import { ValidationError } from '../errors/global-registry-error';
import type { JsonObject, JsonValue } from './global-registry';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET_KEY_PARTS = [
  'password',
  'passwd',
  'passcode',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'clientsecret',
  'authorization',
  'cookie',
  'credentialvalue',
  'credentialsecret',
];
const PRIVATE_KEY_MARKER = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/;

/** Maximum JSON nesting accepted by every persisted or request-supplied value. */
export const MAX_JSON_DEPTH = 64;

/** Maximum number of JSON values accepted in one value graph. */
export const MAX_JSON_NODES = 10_000;

type OutputContainer = Record<string, JsonValue> | JsonValue[];
type OutputKey = string | number | null;

interface VisitTask {
  value: unknown;
  parent: OutputContainer | null;
  key: OutputKey;
  depth: number;
  field: string;
}

export function ensureJsonObject(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new ValidationError('invalid_json_object', `${field} must be a JSON object.`);
  }
  return normalizeJsonObject(value, field);
}

/** Rejects credential-like fields in JSON that is intentionally opaque to Core. */
export function ensureCredentialFreeJsonObject(value: unknown, field: string): JsonObject {
  const normalized = ensureJsonObject(value, field);
  const pending: JsonValue[] = [normalized];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || current === null || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      const compact = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
      if (
        compact.includes('credential') ||
        SECRET_KEY_PARTS.some((part) => compact.includes(part))
      ) {
        throw new ValidationError(
          'secret_like_json_key',
          `${field} must not contain credential or secret fields.`,
        );
      }
      pending.push(nested);
    }
  }
  return normalized;
}

/**
 * Applies explicit resource values over profile defaults without sharing mutable
 * references with either input. Objects merge recursively; arrays are replaced.
 */
export function mergeJsonObjects(defaults: JsonObject, overrides: JsonObject): JsonObject {
  const merged = cloneJsonValue(defaults, 'profile defaults');
  if (!isJsonObject(merged)) {
    throw new ValidationError('invalid_json_object', 'Profile defaults must be a JSON object.');
  }

  const stack: Array<{
    target: Record<string, JsonValue>;
    source: Record<string, unknown>;
    field: string;
  }> = [{ target: merged, source: overrides, field: 'resource overrides' }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    for (const [key, value] of Object.entries(frame.source)) {
      validateKey(key, frame.field);
      const defaultValue = frame.target[key];
      if (isJsonObject(defaultValue) && isJsonObject(value)) {
        const nested = cloneJsonValue(defaultValue, `${frame.field}.${key}`);
        if (!isJsonObject(nested)) {
          throw new ValidationError(
            'invalid_json_object',
            `${frame.field}.${key} must be a JSON object.`,
          );
        }
        setJsonProperty(frame.target, key, nested);
        stack.push({
          target: nested,
          source: value,
          field: `${frame.field}.${key}`,
        });
      } else {
        setJsonProperty(frame.target, key, cloneJsonValue(value, `${frame.field}.${key}`));
      }
    }
  }

  return ensureJsonObject(merged, 'merged JSON');
}

/**
 * Checks a parsed JSON value without recursion. This runs before Zod or
 * normalization can walk attacker-controlled nesting.
 */
export function assertJsonValueLimits(value: unknown, field: string): void {
  walkJsonValue(value, field, () => undefined);
}

export function isBoundedJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValueLimits(value, 'JSON value');
    return true;
  } catch {
    return false;
  }
}

export function isBoundedJsonObject(value: unknown): value is JsonObject {
  return isJsonObject(value) && isBoundedJsonValue(value);
}

export function stableJsonString(value: JsonValue): string {
  assertJsonValueLimits(value, 'JSON value');
  let result = '';
  const stack: Array<{ kind: 'value' | 'text'; value: JsonValue | string }> = [
    { kind: 'value', value },
  ];
  while (stack.length > 0) {
    const task = stack.pop();
    if (task === undefined) continue;
    if (task.kind === 'text') {
      result += task.value as string;
      continue;
    }
    const child = task.value;
    if (child === null || typeof child === 'boolean' || typeof child === 'number') {
      result += JSON.stringify(child);
      continue;
    }
    if (typeof child === 'string') {
      result += JSON.stringify(child);
      continue;
    }
    if (Array.isArray(child)) {
      result += '[';
      stack.push({ kind: 'text', value: ']' });
      for (let index = child.length - 1; index >= 0; index -= 1) {
        if (index < child.length - 1) stack.push({ kind: 'text', value: ',' });
        stack.push({ kind: 'value', value: child[index] as JsonValue });
      }
      continue;
    }
    result += '{';
    const entries = Object.entries(child).sort(([left], [right]) => left.localeCompare(right));
    stack.push({ kind: 'text', value: '}' });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, nested] = entries[index] as [string, JsonValue];
      if (index < entries.length - 1) stack.push({ kind: 'text', value: ',' });
      stack.push({ kind: 'value', value: nested });
      stack.push({ kind: 'text', value: ':' });
      stack.push({ kind: 'text', value: JSON.stringify(key) });
    }
  }
  return result;
}

export async function jsonFingerprint(value: JsonValue): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableJsonString(value)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

function walkJsonValue(
  value: unknown,
  field: string,
  onKey: (key: string, child: unknown, childField: string) => void,
): void {
  const stack: Array<{ value: unknown; depth: number; field: string }> = [
    { value, depth: 0, field },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new ValidationError(
        'json_limits_exceeded',
        `${field} exceeds the JSON depth or node-count limit.`,
      );
    }

    const { value: child, depth, field: childField } = current;
    if (child === null || typeof child === 'boolean' || typeof child === 'string') continue;
    if (typeof child === 'number') {
      if (!Number.isFinite(child)) {
        throw new ValidationError('invalid_json_number', 'JSON numbers must be finite.');
      }
      continue;
    }
    if (Array.isArray(child)) {
      if (nodes + child.length > MAX_JSON_NODES) {
        throw new ValidationError(
          'json_limits_exceeded',
          `${field} exceeds the JSON depth or node-count limit.`,
        );
      }
      for (let index = child.length - 1; index >= 0; index -= 1) {
        stack.push({ value: child[index], depth: depth + 1, field: `${childField}[${index}]` });
      }
      continue;
    }
    if (isJsonObject(child)) {
      const entries = Object.entries(child);
      if (nodes + entries.length > MAX_JSON_NODES) {
        throw new ValidationError(
          'json_limits_exceeded',
          `${field} exceeds the JSON depth or node-count limit.`,
        );
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, nested] = entries[index] as [string, unknown];
        const nestedField = `${childField}.${key}`;
        onKey(key, nested, nestedField);
        stack.push({ value: nested, depth: depth + 1, field: nestedField });
      }
      continue;
    }
    throw new ValidationError('invalid_json_value', 'Value cannot be represented as JSON.');
  }
}

function normalizeJsonObject(value: Record<string, unknown>, field: string): JsonObject {
  const normalized = cloneJsonValue(value, field);
  if (!isJsonObject(normalized)) {
    throw new ValidationError('invalid_json_object', `${field} must be a JSON object.`);
  }
  return normalized;
}

function cloneJsonValue(value: unknown, field: string): JsonValue {
  assertJsonValueLimits(value, field);
  let root: JsonValue | undefined;
  const stack: VisitTask[] = [{ value, parent: null, key: null, depth: 0, field }];

  while (stack.length > 0) {
    const task = stack.pop();
    if (task === undefined) continue;
    const child = task.value;

    if (child === null || typeof child === 'boolean' || typeof child === 'string') {
      assignValue(task.parent, task.key, normalizeJsonPrimitive(child, task.field));
      if (task.parent === null) root = child;
      continue;
    }
    if (typeof child === 'number') {
      assignValue(task.parent, task.key, normalizeJsonPrimitive(child, task.field));
      if (task.parent === null) root = child;
      continue;
    }
    if (Array.isArray(child)) {
      const output: JsonValue[] = new Array(child.length);
      assignValue(task.parent, task.key, output);
      if (task.parent === null) root = output;
      for (let index = child.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: child[index],
          parent: output,
          key: index,
          depth: task.depth + 1,
          field: `${task.field}[${index}]`,
        });
      }
      continue;
    }
    if (isJsonObject(child)) {
      const output = createJsonObject();
      assignValue(task.parent, task.key, output);
      if (task.parent === null) root = output;
      const entries = Object.entries(child);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, nested] = entries[index] as [string, unknown];
        validateKey(key, task.field);
        stack.push({
          value: nested,
          parent: output,
          key,
          depth: task.depth + 1,
          field: `${task.field}.${key}`,
        });
      }
      continue;
    }
    throw new ValidationError('invalid_json_value', 'Value cannot be represented as JSON.');
  }

  if (root === undefined) {
    throw new ValidationError('invalid_json_value', 'Value cannot be represented as JSON.');
  }
  return root;
}

function normalizeJsonPrimitive(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (
      PRIVATE_KEY_MARKER.test(value) ||
      /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value)
    ) {
      throw new ValidationError(
        'secret_like_json_value',
        `${field} contains secret-like material.`,
      );
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError('invalid_json_number', 'JSON numbers must be finite.');
    }
    return value;
  }
  throw new ValidationError('invalid_json_value', 'Value cannot be represented as JSON.');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateKey(key: string, field: string): void {
  const compact = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
  if (UNSAFE_KEYS.has(key.toLowerCase())) {
    throw new ValidationError('unsafe_json_key', `${field} contains an unsafe JSON key.`);
  }
  if (SECRET_KEY_PARTS.some((part) => compact === part || compact.startsWith(part))) {
    throw new ValidationError('secret_like_json_key', `${field} contains a secret-like key.`);
  }
}

function createJsonObject(): Record<string, JsonValue> {
  return Object.create(null) as Record<string, JsonValue>;
}

function assignValue(parent: OutputContainer | null, key: OutputKey, value: JsonValue): void {
  if (parent === null) return;
  if (Array.isArray(parent)) {
    if (typeof key !== 'number') throw new Error('JSON array assignment requires a numeric key.');
    parent[key] = value;
    return;
  }
  if (typeof key !== 'string') throw new Error('JSON object assignment requires a string key.');
  setJsonProperty(parent, key, value);
}

function setJsonProperty(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function parseJsonObject(serialized: string, field: string): JsonObject {
  try {
    return ensureJsonObject(JSON.parse(serialized) as unknown, field);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('invalid_stored_json', `${field} is not a valid JSON object.`);
  }
}
