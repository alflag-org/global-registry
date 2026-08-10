import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkTypeScriptContainment } from './check-typescript-containment.mjs';

const executeFile = promisify(execFile);
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HTTP_METHODS = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace']);
const MUTATING_METHODS = new Set(['delete', 'patch', 'post', 'put']);
const REQUIRED_WRITE_ERRORS = ['400', '403', '409', '422'] as const;

await checkTypeScriptContainment(rootDirectory);
const { createApp, createOpenApiDocument } = await import('../src/api/app');
const { operationRolePolicy } = await import('../src/api/actor-authorization');

interface OperationEntry {
  method: string;
  path: string;
  operation: Record<string, unknown>;
}

const app = createApp();
const document = createOpenApiDocument(app);
const documentRecord = asRecord(document, 'OpenAPI document');
const paths = asRecord(documentRecord.paths, 'OpenAPI paths');
const operations = collectOperations(paths);

assert(documentRecord.openapi === '3.1.0', 'The generated document must use OpenAPI 3.1.0.');
assertRouteParity();
assertOperationMetadata();
assertConditionalOperationRoleMetadata();
assertUniqueOperationIds();
assertNoGenericResponseObjects();
assertExamplesPresent();
assertLifecycleStateContracts();

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'global-registry-openapi-'));
const documentPath = path.join(temporaryDirectory, 'openapi.json');
const redoclyConfigPath = path.join(temporaryDirectory, 'redocly.yaml');
try {
  await Promise.all([
    writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8'),
    writeFile(
      redoclyConfigPath,
      `extends:
  - spec
rules:
  no-invalid-media-type-examples: error
  no-invalid-parameter-examples: error
  no-invalid-schema-examples: error
`,
      'utf8',
    ),
  ]);
  const redoclyPath = path.join(rootDirectory, 'node_modules', '.bin', 'redocly');
  const result = await executeFile(
    redoclyPath,
    ['lint', '--config', redoclyConfigPath, '--format=summary', documentPath],
    {
      cwd: rootDirectory,
      env: {
        ...process.env,
        NO_COLOR: '1',
        REDOCLY_TELEMETRY: 'off',
        REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true',
      },
    },
  );
  if (result.stdout.trim().length > 0) process.stdout.write(result.stdout);
  if (result.stderr.trim().length > 0) process.stderr.write(result.stderr);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function assertRouteParity(): void {
  const implemented = new Set(
    app.routes
      .filter((route) => route.path.startsWith('/api/v1/') && route.method !== 'ALL')
      .map((route) => `${route.method.toLowerCase()} ${toOpenApiPath(route.path)}`),
  );
  const documented = new Set(
    operations
      .filter(({ path: operationPath }) => operationPath.startsWith('/api/v1/'))
      .map(({ method, path: operationPath }) => `${method} ${operationPath}`),
  );

  const undocumented = [...implemented].filter((route) => !documented.has(route));
  const unimplemented = [...documented].filter((route) => !implemented.has(route));
  assert(
    undocumented.length === 0,
    `Implemented API routes missing from OpenAPI: ${undocumented.join(', ')}`,
  );
  assert(
    unimplemented.length === 0,
    `OpenAPI operations missing from the router: ${unimplemented.join(', ')}`,
  );
}

function assertOperationMetadata(): void {
  for (const { method, path: operationPath, operation } of operations) {
    assert(nonEmptyString(operation.operationId), `${method} ${operationPath} needs operationId.`);
    assert(nonEmptyString(operation.summary), `${method} ${operationPath} needs summary.`);
    assert(nonEmptyString(operation.description), `${method} ${operationPath} needs description.`);
    assert(
      Array.isArray(operation.tags) && operation.tags.length > 0,
      `${method} ${operationPath} needs tags.`,
    );
    assert(
      Array.isArray(operation.security) && operation.security.length > 0,
      `${method} ${operationPath} needs security.`,
    );

    const responses = asRecord(operation.responses, `${method} ${operationPath} responses`);
    if (MUTATING_METHODS.has(method)) {
      const requestBody = operation.requestBody;
      const parameters = operation.parameters;
      assert(
        requestBody !== undefined || (Array.isArray(parameters) && parameters.length > 0),
        `${method} ${operationPath} needs a request body or explicit parameter.`,
      );
      for (const status of REQUIRED_WRITE_ERRORS) {
        assert(
          responses[status] !== undefined,
          `${method} ${operationPath} needs a ${status} response.`,
        );
      }
      assert(
        Array.isArray(operation['x-required-roles']) && operation['x-required-roles'].length > 0,
        `${method} ${operationPath} needs x-required-roles.`,
      );
    }
  }
}

function assertConditionalOperationRoleMetadata(): void {
  const conditionalOperationIds = new Set([
    'createOperation',
    'acquireOperationLocks',
    'renewOperationLocks',
    'releaseOperationLocks',
    'startOperation',
    'updateOperationStep',
    'completeOperation',
    'failOperation',
    'cancelOperation',
    'transitionResource',
  ]);
  const expected = [
    {
      when: operationRolePolicy.destructiveCondition,
      roles: operationRolePolicy.destructiveRoles,
    },
  ];
  for (const { method, path: operationPath, operation } of operations) {
    if (!conditionalOperationIds.has(String(operation.operationId))) continue;
    assert(
      JSON.stringify(operation['x-conditional-required-roles']) === JSON.stringify(expected),
      `${method} ${operationPath} must publish the shared destructive-operation role policy.`,
    );
  }
  assert(
    operations.filter(({ operation }) => conditionalOperationIds.has(String(operation.operationId)))
      .length === conditionalOperationIds.size,
    'Every conditional operation role policy target must exist in the generated document.',
  );
}

function assertUniqueOperationIds(): void {
  const seen = new Set<string>();
  for (const { method, path: operationPath, operation } of operations) {
    const operationId = operation.operationId;
    if (typeof operationId !== 'string') continue;
    assert(
      !seen.has(operationId),
      `Duplicate operationId ${operationId} at ${method} ${operationPath}.`,
    );
    seen.add(operationId);
  }
}

function assertNoGenericResponseObjects(): void {
  for (const { method, path: operationPath, operation } of operations) {
    const responses = asRecord(operation.responses, `${method} ${operationPath} responses`);
    for (const [status, responseValue] of Object.entries(responses)) {
      const response = asOptionalRecord(responseValue);
      const content = asOptionalRecord(response?.content);
      if (content === undefined) continue;
      for (const mediaValue of Object.values(content)) {
        const media = asOptionalRecord(mediaValue);
        if (media?.schema !== undefined) {
          inspectSchema(media.schema, `${method} ${operationPath} response ${status}`);
        }
      }
    }
  }

  const components = asOptionalRecord(documentRecord.components);
  const schemas = asOptionalRecord(components?.schemas);
  if (schemas !== undefined) {
    for (const [name, schema] of Object.entries(schemas)) {
      inspectSchema(schema, `component schema ${name}`);
    }
  }
}

function assertExamplesPresent(): void {
  for (const { method, path: operationPath, operation } of operations) {
    const requestBody = asOptionalRecord(operation.requestBody);
    const requestContent = asOptionalRecord(requestBody?.content);
    const requestJson = asOptionalRecord(requestContent?.['application/json']);
    if (requestJson !== undefined) {
      assert(
        requestJson.example !== undefined || requestJson.examples !== undefined,
        `${method} ${operationPath} request body needs a JSON example.`,
      );
    }

    const parameters = operation.parameters;
    if (Array.isArray(parameters)) {
      for (const parameterValue of parameters) {
        const parameter = asRecord(parameterValue, `${method} ${operationPath} parameter`);
        const schema = asOptionalRecord(parameter.schema);
        assert(
          parameter.example !== undefined ||
            parameter.examples !== undefined ||
            schema?.example !== undefined ||
            schema?.examples !== undefined,
          `${method} ${operationPath} parameter ${String(parameter.name)} needs an example.`,
        );
      }
    }

    const responses = asRecord(operation.responses, `${method} ${operationPath} responses`);
    for (const [status, responseValue] of Object.entries(responses)) {
      const response = asRecord(responseValue, `${method} ${operationPath} response ${status}`);
      const content = asOptionalRecord(response.content);
      const json = asOptionalRecord(content?.['application/json']);
      if (json === undefined) continue;
      assert(
        json.example !== undefined || json.examples !== undefined,
        `${method} ${operationPath} response ${status} needs a JSON example.`,
      );
    }
  }
}

function assertLifecycleStateContracts(): void {
  const components = asRecord(documentRecord.components, 'OpenAPI components');
  const schemas = asRecord(components.schemas, 'OpenAPI component schemas');
  for (const [schemaName, fieldName] of [
    ['Resource', 'lifecycleState'],
    ['TransitionResourceRequest', 'targetState'],
    ['OperationResourcePlan', 'sourceState'],
    ['OperationResourcePlan', 'targetState'],
  ] as const) {
    const schema = asRecord(schemas[schemaName], `${schemaName} schema`);
    const properties = asRecord(schema.properties, `${schemaName} properties`);
    const property = asRecord(properties[fieldName], `${schemaName}.${fieldName}`);
    assert(property.type === 'string', `${schemaName}.${fieldName} must be a string.`);
    assert(
      typeof property.pattern === 'string' && property.pattern.length > 0,
      `${schemaName}.${fieldName} must publish the extensible state identifier pattern.`,
    );
  }
}

function inspectSchema(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    for (const item of value) inspectSchema(item, location);
    return;
  }
  const schema = asOptionalRecord(value);
  if (schema === undefined) return;

  const hasShape =
    schema.properties !== undefined ||
    schema.additionalProperties !== undefined ||
    schema.oneOf !== undefined ||
    schema.anyOf !== undefined ||
    schema.allOf !== undefined ||
    schema.$ref !== undefined;
  assert(
    schema.type !== 'object' || hasShape,
    `${location} contains a generic empty object schema.`,
  );
  for (const nested of Object.values(schema)) inspectSchema(nested, location);
}

function collectOperations(pathsObject: Record<string, unknown>): OperationEntry[] {
  const entries: OperationEntry[] = [];
  for (const [operationPath, pathValue] of Object.entries(pathsObject)) {
    const pathItem = asRecord(pathValue, `path item ${operationPath}`);
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      entries.push({
        method,
        path: operationPath,
        operation: asRecord(operationValue, `${method} ${operationPath}`),
      });
    }
  }
  return entries;
}

function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asOptionalRecord(value);
  if (record === undefined) throw new Error(`${label} must be an object.`);
  return record;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
