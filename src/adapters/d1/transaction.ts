import { ConflictError } from '../../domain/errors/global-registry-error';
import { ensureJsonObject } from '../../domain/models/json';
import type { JsonObject } from '../../domain/models/global-registry';
import type { SqlValue } from './client';
import type { D1Client } from './client';

interface EventInput {
  eventType: string;
  actorId: string;
  payload: JsonObject;
  resourceKey?: string;
  operationId?: string;
}

export interface SqlPredicate {
  sql: string;
  params: SqlValue[];
}

type StatementFactory = (sql: string, ...params: SqlValue[]) => D1PreparedStatement;

export function eventStatements(
  statement: StatementFactory,
  input: EventInput,
  predicate?: SqlPredicate,
): D1PreparedStatement[] {
  const payload = ensureJsonObject(input.payload, 'audit event payload');
  const eventId = prefixedId('evt');
  const occurredAt = new Date().toISOString();
  const eventParams: SqlValue[] = [
    eventId,
    input.eventType,
    input.resourceKey ?? null,
    input.operationId ?? null,
    input.actorId,
    JSON.stringify(payload),
    occurredAt,
  ];
  const eventStatement =
    predicate === undefined
      ? statement(
          `INSERT INTO events (
            event_id, event_type, resource_key, operation_id, actor_id, payload_json, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ...eventParams,
        )
      : statement(
          `INSERT INTO events (
            event_id, event_type, resource_key, operation_id, actor_id, payload_json, occurred_at
          ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${predicate.sql}`,
          ...eventParams,
          ...predicate.params,
        );
  const outboxStatement = statement(
    `INSERT INTO outbox (id, event_id, topic, payload_json, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE event_id = ?)`,
    prefixedId('out'),
    eventId,
    `global-registry.${input.eventType}`,
    JSON.stringify(payload),
    occurredAt,
    occurredAt,
    eventId,
  );
  return [eventStatement, outboxStatement];
}

export function fencePredicate(
  scope: string,
  operationId: string,
  fencingToken: number,
  observedAt: string,
  actorId: string,
): SqlPredicate {
  return {
    sql: `EXISTS (
      SELECT 1 FROM resource_locks
      WHERE scope = ? AND operation_id = ? AND actor_id = ? AND fencing_token = ? AND expires_at > ?
    )`,
    params: [scope, operationId, actorId, fencingToken, observedAt],
  };
}

export async function assertFence(
  client: D1Client,
  scope: string,
  operationId: string,
  fencingToken: number,
  observedAt: string,
  actorId: string,
): Promise<void> {
  const lock = await client.first<{ scope: string }>(
    `SELECT scope FROM resource_locks
     WHERE scope = ? AND operation_id = ? AND actor_id = ? AND fencing_token = ? AND expires_at > ?`,
    scope,
    operationId,
    actorId,
    fencingToken,
    observedAt,
  );
  if (lock === null) {
    throw new ConflictError(
      'stale_fencing_token',
      'The lock lease is missing, expired, or stale.',
      { scope, operationId },
    );
  }
}

export function requireMutation(
  result: D1Result<unknown> | undefined,
  entity: string,
  key: string,
): void {
  if (result?.meta.changes === 1) return;
  throw new ConflictError(
    'revision_conflict',
    `${entity} has changed or its lock is no longer current.`,
    { entity, key },
  );
}

function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
