import path from 'node:path';
import { actorCreateInputSchema } from '../src/domain/actor/schemas';

const databaseNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const environmentNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface BootstrapAdminOptions {
  database: string;
  identity: string;
  displayName: string;
  remote: boolean;
  config: string;
  environment?: string;
}

export interface BootstrapAdminResult {
  actorId: string;
  identity: string;
  auditEvents: number;
  outboxRows: number;
}

export interface BootstrapValues {
  actorId: string;
  identity: string;
  displayName: string;
  createdAt: string;
}

interface WranglerStatementResult {
  results?: unknown[];
  success?: boolean;
}

export function bootstrapAdminUsage(): string {
  return `Usage:
  mise run bootstrap-admin -- --database <name-or-binding> --identity <access:subject|service:common_name> --display-name <name> [options]

Options:
  --local             Use local D1 (default).
  --remote            Use remote D1. This must be explicit.
  --config <path>     Wrangler config (default: wrangler.jsonc locally, wrangler.operator.jsonc remotely).
  --env <name>        Wrangler environment (default: development locally).
  -h, --help          Show this help.`;
}

export function parseBootstrapAdminArguments(
  args: readonly string[],
): BootstrapAdminOptions | null {
  if (args.includes('--help') || args.includes('-h')) return null;

  const values = new Map<string, string>();
  let explicitMode: 'local' | 'remote' | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) throw new Error('Argument parsing exceeded the provided input.');
    if (argument === '--') continue;
    if (argument === '--local' || argument === '--remote') {
      const mode = argument.slice(2) as 'local' | 'remote';
      if (explicitMode !== undefined && explicitMode !== mode) {
        throw new Error('--local and --remote cannot be used together.');
      }
      if (explicitMode === mode) throw new Error(`${argument} was provided more than once.`);
      explicitMode = mode;
      continue;
    }
    if (!['--database', '--identity', '--display-name', '--config', '--env'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument ?? '(missing)'}`);
    }
    if (values.has(argument)) throw new Error(`${argument} was provided more than once.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const database = requiredValue(values, '--database');
  if (!databaseNamePattern.test(database)) {
    throw new Error(
      '--database must contain only letters, digits, dots, underscores, or hyphens and cannot start with punctuation.',
    );
  }
  const identity = requiredValue(values, '--identity');
  const displayName = requiredValue(values, '--display-name');
  const actor = actorCreateInputSchema.safeParse({ identity, displayName, role: 'admin' });
  if (!actor.success) {
    throw new Error(
      `Invalid admin Actor: ${actor.error.issues.map((issue) => issue.message).join(' ')}`,
    );
  }

  const remote = explicitMode === 'remote';
  const config = values.get('--config') ?? (remote ? 'wrangler.operator.jsonc' : 'wrangler.jsonc');
  if (
    config.length === 0 ||
    config.length > 512 ||
    path.isAbsolute(config) ||
    config.includes('\\') ||
    config.split('/').includes('..') ||
    config.startsWith('-')
  ) {
    throw new Error('--config must be a contained relative path without parent traversal.');
  }
  const environment = values.get('--env') ?? (remote ? undefined : 'development');
  if (environment !== undefined && !environmentNamePattern.test(environment)) {
    throw new Error('--env must be a stable environment identifier.');
  }

  return {
    database,
    identity: actor.data.identity,
    displayName: actor.data.displayName,
    remote,
    config,
    ...(environment === undefined ? {} : { environment }),
  };
}

export function buildBootstrapAdminSql(values: BootstrapValues): string {
  const actorId = sqlText(values.actorId);
  const identity = sqlText(values.identity);
  const displayName = sqlText(values.displayName);
  const createdAt = sqlText(values.createdAt);
  const eventId = sqlText(`evt_actor_${values.actorId}_1`);
  const outboxId = sqlText(`out_actor_${values.actorId}_1`);
  return `INSERT INTO actors (
  id, identity, display_name, role, active, revision,
  created_at, updated_at, created_by, updated_by
)
SELECT ${actorId}, ${identity}, ${displayName}, 'admin', 1, 1,
  ${createdAt}, ${createdAt}, ${actorId}, ${actorId}
WHERE NOT EXISTS (SELECT 1 FROM actors WHERE role = 'admin');
SELECT changes() AS bootstrap_inserted;
SELECT
  id AS actor_id,
  identity,
  role,
  active,
  (SELECT count(*) FROM events WHERE event_id = ${eventId}) AS audit_events,
  (SELECT count(*) FROM outbox WHERE id = ${outboxId}) AS outbox_rows
FROM actors
WHERE id = ${actorId};`;
}

export function parseBootstrapAdminOutput(output: string): BootstrapAdminResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Wrangler returned non-JSON output for the bootstrap operation.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Wrangler returned an unexpected bootstrap result.');
  }
  const statements = parsed as WranglerStatementResult[];
  if (statements.some((statement) => statement.success === false)) {
    throw new Error('Wrangler reported a failed bootstrap statement.');
  }
  const rows = statements.flatMap((statement) => statement.results ?? []);
  const insertion = rows.find(isInsertionRow);
  if (insertion === undefined) {
    throw new Error('Wrangler did not report whether the admin Actor was inserted.');
  }
  if (Number(insertion.bootstrap_inserted) !== 1) {
    throw new Error('An admin Actor already exists; bootstrap was refused.');
  }
  const verification = rows.find(isVerificationRow);
  if (verification === undefined) {
    throw new Error(
      'The admin Actor was inserted, but its audit/outbox verification result is missing; inspect D1 before retrying.',
    );
  }
  const auditEvents = Number(verification.audit_events);
  const outboxRows = Number(verification.outbox_rows);
  if (
    verification.role !== 'admin' ||
    Number(verification.active) !== 1 ||
    auditEvents !== 1 ||
    outboxRows !== 1
  ) {
    throw new Error(
      'The admin Actor was inserted, but its active-admin or audit/outbox invariant could not be verified; inspect D1 before retrying.',
    );
  }
  return {
    actorId: String(verification.actor_id),
    identity: String(verification.identity),
    auditEvents,
    outboxRows,
  };
}

function requiredValue(values: ReadonlyMap<string, string>, option: string): string {
  const value = values.get(option);
  if (value === undefined) throw new Error(`${option} is required.`);
  return value;
}

function sqlText(value: string): string {
  return `CAST(X'${[...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}' AS TEXT)`;
}

function isInsertionRow(value: unknown): value is { bootstrap_inserted: unknown } {
  return value !== null && typeof value === 'object' && 'bootstrap_inserted' in value;
}

function isVerificationRow(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && 'actor_id' in value && 'audit_events' in value
  );
}
