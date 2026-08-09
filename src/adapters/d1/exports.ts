import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import {
  MAX_EXPORT_ATTEMPTS,
  MAX_EXPORT_RETENTION_AGE_DAYS,
  MAX_EXPORT_RETENTION_WORK,
  PORTABLE_EXPORT_QUERY_LIMIT,
  PORTABLE_EXPORT_SCHEMA_VERSION,
} from '../../application/limits';
import {
  assertPortableExportChunk,
  type PortableExportChunk,
  type PortableExportEntity,
} from '../../application/registry-snapshot';
import { parseJsonObject } from '../../domain/models/json';
import type { ExportRecord } from '../../domain/models/global-registry';
import { D1Client } from './client';
import {
  mapBinding,
  mapDrift,
  mapEvent,
  mapExport,
  mapHealth,
  mapOperation,
  mapOperationStep,
  mapProvider,
  mapRelationship,
  mapResource,
} from './rows';
import { eventStatements, requireMutation } from './transaction';
import type {
  ActorRow,
  BindingHistoryRow,
  BindingRow,
  DriftRow,
  ExportRow,
  LockGenerationRow,
  LockRow,
  ObservationRow,
  OperationChangeRow,
  OperationResourceRow,
  OperationStepRow,
  OutboxRow,
  PolicyRow,
  PolicyVersionRow,
  ProfileRow,
  ProfileVersionRow,
  RelationshipHistoryRow,
} from './types';

function now(): string {
  return new Date().toISOString();
}

export const EXPORT_LEASE_MS = 5 * 60 * 1000;

function exportClaimObjectKey(exportId: string, revision: number, claimToken: string): string {
  return `exports/${encodeURIComponent(exportId)}/${revision}-${claimToken}/manifest.json`;
}

interface PortableExportCursorRow {
  __export_cursor: number;
}

interface PortableExportReader {
  entity: PortableExportEntity;
  cursorTable: string;
  query: string;
  map: (row: never) => unknown;
}

const portableExportReaders: PortableExportReader[] = [
  reader('actors', 'actors', mapActorSnapshot),
  reader('providers', 'providers', mapProvider),
  reader('profiles', 'profiles', mapProfileSnapshot),
  reader('profileVersions', 'profile_versions', mapProfileVersionSnapshot),
  reader('policies', 'policies', mapPolicySnapshot),
  reader('policyVersions', 'policy_versions', mapPolicyVersionSnapshot),
  reader('resources', 'resources', mapResource),
  reader('relationships', 'resource_relationships', mapRelationship),
  reader('relationshipHistory', 'resource_relationship_history', mapRelationshipHistory),
  reader('bindings', 'provider_bindings', mapBindingSnapshot),
  reader('bindingHistory', 'provider_binding_history', mapBindingHistory),
  reader('health', 'health', mapHealth),
  reader('observations', 'observations', mapObservation),
  reader('drifts', 'drifts', mapDriftSnapshot),
  reader('operations', 'operations', mapOperation),
  {
    entity: 'operationResources',
    cursorTable: 'operation_resources',
    query: `SELECT operation_resources.rowid AS __export_cursor,
                   operation_resources.*, resources.key AS resource_key
              FROM operation_resources
              JOIN resources ON resources.id = operation_resources.resource_id
             WHERE operation_resources.rowid > ? AND operation_resources.rowid <= ?
             ORDER BY operation_resources.rowid
             LIMIT ?`,
    map: mapOperationResource as (row: never) => unknown,
  },
  reader('operationSteps', 'operation_steps', mapOperationStepSnapshot),
  reader('operationChanges', 'operation_changes', mapOperationChange),
  reader('locks', 'resource_locks', mapLock),
  reader('lockGenerations', 'resource_lock_generations', mapLockGeneration),
  reader('events', 'events', mapEvent),
  reader('outbox', 'outbox', mapOutbox),
  reader('exports', 'exports', mapExportSnapshot),
];

function reader<Row>(
  entity: PortableExportEntity,
  table: string,
  map: (row: Row) => unknown,
): PortableExportReader {
  return {
    entity,
    cursorTable: table,
    query: `SELECT rowid AS __export_cursor, * FROM ${table}
             WHERE rowid > ? AND rowid <= ?
             ORDER BY rowid
             LIMIT ?`,
    map: map as (row: never) => unknown,
  };
}

export class D1Exports extends D1Client {
  async create(actorId: string): Promise<ExportRecord> {
    const createdAt = now();
    const exportRecord: ExportRecord = {
      id: `exp_${crypto.randomUUID()}`,
      schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      status: 'planned',
      attempts: 0,
      revision: 1,
      createdAt,
      requestedBy: actorId,
    };
    const event = eventStatements(this.statement.bind(this), {
      eventType: 'export.requested',
      actorId,
      payload: { exportId: exportRecord.id, schemaVersion: exportRecord.schemaVersion },
    });
    await this.db.batch([
      this.statement(
        `INSERT INTO exports (
          id, schema_version, status, revision, created_at, requested_by, updated_at
        ) VALUES (?, ?, 'planned', 1, ?, ?, ?)`,
        exportRecord.id,
        exportRecord.schemaVersion,
        exportRecord.createdAt,
        exportRecord.requestedBy,
        exportRecord.createdAt,
      ),
      ...event,
    ]);
    return exportRecord;
  }

  async createScheduled(actorId: string, day: string): Promise<ExportRecord> {
    const id = `exp_daily_${day}`;
    const createdAt = now();
    const exportRecord: ExportRecord = {
      id,
      schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      status: 'planned',
      attempts: 0,
      revision: 1,
      createdAt,
      requestedBy: actorId,
    };
    const event = eventStatements(this.statement.bind(this), {
      eventType: 'export.requested',
      actorId,
      payload: {
        exportId: exportRecord.id,
        schemaVersion: exportRecord.schemaVersion,
        scheduled: true,
      },
    });
    try {
      await this.db.batch([
        this.statement(
          `INSERT INTO exports (
            id, schema_version, status, revision, created_at, requested_by, updated_at
          ) VALUES (?, ?, 'planned', 1, ?, ?, ?)`,
          exportRecord.id,
          exportRecord.schemaVersion,
          exportRecord.createdAt,
          exportRecord.requestedBy,
          exportRecord.createdAt,
        ),
        ...event,
      ]);
      return exportRecord;
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        const existing = await this.get(id);
        if (existing !== null) return existing;
      }
      throw error;
    }
  }

  async get(id: string): Promise<ExportRecord | null> {
    const row = await this.first<ExportRow>('SELECT * FROM exports WHERE id = ?', id);
    return row === null ? null : mapExport(row);
  }

  async listRetainable(
    referenceTime: string,
    limit = MAX_EXPORT_RETENTION_WORK,
  ): Promise<ExportRecord[]> {
    const cutoff = new Date(
      Date.parse(referenceTime) - MAX_EXPORT_RETENTION_AGE_DAYS * 86_400_000,
    ).toISOString();
    const rows = await this.all<ExportRow>(
      `SELECT * FROM exports
       WHERE status = 'succeeded' AND r2_object_key IS NOT NULL AND expired_at IS NULL
         AND completed_at < ?
       ORDER BY completed_at, id
       LIMIT ?`,
      cutoff,
      Math.min(Math.max(limit, 1), MAX_EXPORT_RETENTION_WORK),
    );
    return rows.map(mapExport);
  }

  async markExpired(id: string, actorId: string): Promise<boolean> {
    const exportRecord = await this.get(id);
    if (exportRecord === null) throw new NotFoundError('Export', id);
    if (exportRecord.r2ObjectKey === undefined) return false;
    const expiredAt = now();
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'export.expired',
        actorId,
        payload: { exportId: id, expiredAt },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM exports
          WHERE id = ? AND r2_object_key IS NULL AND r2_claim_token IS NULL AND expired_at = ?
            AND revision = ? AND updated_at = ?
        )`,
        params: [id, expiredAt, exportRecord.revision + 1, expiredAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE exports SET r2_object_key = NULL, r2_claim_token = NULL, expired_at = ?, revision = revision + 1,
           updated_at = ?
         WHERE id = ? AND revision = ? AND r2_object_key IS NOT NULL`,
        expiredAt,
        expiredAt,
        id,
        exportRecord.revision,
      ),
      ...event,
    ]);
    return results[0]?.meta.changes === 1;
  }

  async claim(
    id: string,
    claimedAt = now(),
  ): Promise<{
    exportId: string;
    revision: number;
    attempt: number;
    objectKey: string;
    claimToken: string;
    supersededClaim?: {
      revision: number;
      objectKey: string;
      claimToken: string;
    };
    recovery: boolean;
  } | null> {
    const current = await this.first<ExportRow>('SELECT * FROM exports WHERE id = ?', id);
    if (current === null) throw new NotFoundError('Export', id);
    if (current.status === 'succeeded' || current.expired_at !== null) return null;
    if (
      current.status === 'running' &&
      current.lease_until !== null &&
      current.lease_until > claimedAt
    ) {
      return null;
    }
    const recovery = current.attempts >= MAX_EXPORT_ATTEMPTS;
    if (recovery && current.status !== 'running') return null;
    const leaseUntil = new Date(Date.parse(claimedAt) + EXPORT_LEASE_MS).toISOString();
    const nextRevision = current.revision + 1;
    const nextAttempt = current.attempts + (recovery ? 0 : 1);
    const claimToken = crypto.randomUUID();
    const objectKey = exportClaimObjectKey(id, nextRevision, claimToken);
    const supersededClaim =
      current.status === 'running' &&
      current.claim_token !== null &&
      current.claim_object_key !== null
        ? {
            revision: current.revision,
            objectKey: current.claim_object_key,
            claimToken: current.claim_token,
          }
        : undefined;
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: recovery ? 'export.recovering' : 'export.running',
        actorId: current.requested_by,
        payload: {
          exportId: id,
          attempt: nextAttempt,
          leaseUntil,
          recovery,
          revision: nextRevision,
          objectKey,
          claimToken,
          schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM exports
          WHERE id = ? AND status = 'running' AND revision = ? AND updated_at = ?
            AND claim_token = ? AND claim_object_key = ?
        )`,
        params: [id, nextRevision, claimedAt, claimToken, objectKey],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE exports SET schema_version = ?, status = 'running', attempts = attempts + ?, lease_until = ?,
           error_message = NULL, completed_at = NULL, r2_object_key = NULL, r2_claim_token = NULL,
           claim_token = ?, claim_object_key = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND (
           (attempts < ? AND (
             status IN ('planned', 'failed')
             OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
           ))
           OR (attempts >= ? AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
         )`,
        PORTABLE_EXPORT_SCHEMA_VERSION,
        recovery ? 0 : 1,
        leaseUntil,
        claimToken,
        objectKey,
        claimedAt,
        id,
        current.revision,
        MAX_EXPORT_ATTEMPTS,
        claimedAt,
        MAX_EXPORT_ATTEMPTS,
        claimedAt,
      ),
      ...event,
    ]);
    requireMutation(results[0], 'Export', id);
    return {
      exportId: id,
      revision: nextRevision,
      attempt: nextAttempt,
      objectKey,
      claimToken,
      ...(supersededClaim === undefined ? {} : { supersededClaim }),
      recovery,
    };
  }

  async complete(input: {
    exportId: string;
    revision: number;
    checksum: string;
    objectKey: string;
    claimToken: string;
  }): Promise<void> {
    const { exportId: id, revision, checksum, objectKey: r2ObjectKey, claimToken } = input;
    const current = await this.first<ExportRow>('SELECT * FROM exports WHERE id = ?', id);
    if (current === null) throw new NotFoundError('Export', id);
    if (current.status === 'succeeded') {
      if (
        current.checksum !== checksum ||
        current.r2_object_key !== r2ObjectKey ||
        current.r2_claim_token !== claimToken
      ) {
        throw new ConflictError(
          'export_object_mismatch',
          'The authoritative export record does not match the deterministic R2 object.',
          { id },
        );
      }
      return;
    }
    if (
      current.status !== 'running' ||
      current.revision !== revision ||
      current.claim_token !== claimToken ||
      current.claim_object_key !== r2ObjectKey
    ) {
      throw new ConflictError(
        'export_lease_conflict',
        'The export completion lease is no longer current.',
        { id },
      );
    }
    const completedAt = now();
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'export.succeeded',
        actorId: current.requested_by,
        payload: {
          exportId: id,
          checksum,
          r2ObjectKey,
          claimToken,
          revision,
          attempt: current.attempts,
          schemaVersion: current.schema_version,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM exports
          WHERE id = ? AND status = 'succeeded' AND revision = ? AND updated_at = ?
            AND r2_object_key = ? AND r2_claim_token = ?
        )`,
        params: [id, revision + 1, completedAt, r2ObjectKey, claimToken],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE exports SET status = 'succeeded', checksum = ?, r2_object_key = ?,
           r2_claim_token = ?, claim_token = NULL, claim_object_key = NULL,
           completed_at = ?, lease_until = NULL, error_message = NULL,
           revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'running' AND revision = ?
           AND claim_token = ? AND claim_object_key = ?`,
        checksum,
        r2ObjectKey,
        claimToken,
        completedAt,
        completedAt,
        id,
        revision,
        claimToken,
        r2ObjectKey,
      ),
      ...event,
    ]);
    requireMutation(results[0], 'Export', id);
  }

  async renew(input: {
    exportId: string;
    revision: number;
    objectKey: string;
    claimToken: string;
  }): Promise<void> {
    const renewedAt = now();
    const leaseUntil = new Date(Date.parse(renewedAt) + EXPORT_LEASE_MS).toISOString();
    const result = await this.statement(
      `UPDATE exports SET lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND revision = ?
         AND claim_token = ? AND claim_object_key = ?`,
      leaseUntil,
      renewedAt,
      input.exportId,
      input.revision,
      input.claimToken,
      input.objectKey,
    ).run();
    requireMutation(result, 'Export', input.exportId);
  }

  async fail(input: {
    exportId: string;
    revision: number;
    claimToken: string;
    errorCode: string;
  }): Promise<void> {
    const { exportId: id, revision, claimToken } = input;
    const current = await this.first<ExportRow>('SELECT * FROM exports WHERE id = ?', id);
    if (current === null) throw new NotFoundError('Export', id);
    if (current.status === 'succeeded') return;
    if (
      current.status !== 'running' ||
      current.revision !== revision ||
      current.claim_token !== claimToken
    ) {
      throw new ConflictError(
        'export_lease_conflict',
        'The export failure lease is no longer current.',
        { id },
      );
    }
    const failedAt = now();
    const errorMessage = /^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(input.errorCode)
      ? input.errorCode
      : 'export_failed';
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'export.failed',
        actorId: current.requested_by,
        payload: {
          exportId: id,
          errorMessage,
          claimToken,
          revision,
          attempt: current.attempts,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM exports
          WHERE id = ? AND status = 'failed' AND revision = ? AND updated_at = ?
            AND claim_token IS NULL AND claim_object_key IS NULL
        )`,
        params: [id, revision + 1, failedAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE exports SET status = 'failed', error_message = ?, completed_at = NULL,
           lease_until = NULL, claim_token = NULL, claim_object_key = NULL,
           r2_object_key = NULL, r2_claim_token = NULL, revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'running' AND revision = ? AND claim_token = ?`,
        errorMessage,
        failedAt,
        id,
        revision,
        claimToken,
      ),
      ...event,
    ]);
    requireMutation(results[0], 'Export', id);
  }

  async validatePortableExportSource(): Promise<void> {
    const results = await this.db.batch([
      this.statement('PRAGMA quick_check(1)'),
      this.statement('SELECT * FROM pragma_foreign_key_check LIMIT 1'),
    ]);
    const quickCheck = results[0]?.results[0] as { quick_check?: unknown } | undefined;
    if (
      results.length !== 2 ||
      results.some((result) => result.success !== true) ||
      quickCheck?.quick_check !== 'ok' ||
      results[1]!.results.length !== 0
    ) {
      throw new Error('portable_export_source_invalid');
    }
  }

  async *readPortableExportChunks(exportId: string): AsyncIterable<PortableExportChunk> {
    const ceilingResults = await this.db.batch(
      portableExportReaders.map((definition) =>
        this.statement(
          `SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM ${definition.cursorTable}`,
        ),
      ),
    );
    if (
      ceilingResults.length !== portableExportReaders.length ||
      ceilingResults.some((result) => result.success !== true)
    ) {
      throw new Error('portable_export_ceiling_read_failed');
    }

    for (const [index, definition] of portableExportReaders.entries()) {
      const ceiling = Number(
        (ceilingResults[index]?.results[0] as { max_rowid?: unknown } | undefined)?.max_rowid,
      );
      if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
        throw new Error('portable_export_ceiling_invalid');
      }
      let cursor = 0;
      let sequence = 1;
      do {
        const rows = await this.all<PortableExportCursorRow>(
          definition.query,
          cursor,
          ceiling,
          PORTABLE_EXPORT_QUERY_LIMIT,
        );
        const chunk = assertPortableExportChunk({
          schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
          exportId,
          entity: definition.entity,
          sequence,
          rows: rows.map((row) => definition.map(row as never)),
        });
        yield chunk;
        if (rows.length === 0 || rows.length < PORTABLE_EXPORT_QUERY_LIMIT) break;
        const nextCursor = rows.at(-1)?.__export_cursor;
        if (!Number.isSafeInteger(nextCursor) || nextCursor === undefined || nextCursor <= cursor) {
          throw new Error('portable_export_cursor_invalid');
        }
        cursor = nextCursor;
        sequence += 1;
      } while (cursor < ceiling);
    }
  }
}

function optionalProperty<T>(key: string, value: T | null): Record<string, T> {
  return value === null ? {} : { [key]: value };
}

function mapActorSnapshot(row: ActorRow) {
  return {
    id: row.id,
    identity: row.identity,
    displayName: row.display_name,
    role: row.role,
    active: row.active === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function mapProfileSnapshot(row: ProfileRow) {
  return {
    key: row.key,
    resourceKind: row.resource_kind,
    status: row.status,
    currentVersion: row.current_version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProfileVersionSnapshot(row: ProfileVersionRow) {
  return {
    profileKey: row.profile_key,
    version: row.version,
    spec: parseJsonObject(row.spec_json, 'profile version spec'),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function mapPolicySnapshot(row: PolicyRow) {
  return {
    namespace: row.namespace,
    key: row.key,
    status: row.status,
    currentVersion: row.current_version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPolicyVersionSnapshot(row: PolicyVersionRow) {
  return {
    namespace: row.namespace,
    policyKey: row.policy_key,
    version: row.version,
    resourceKind: row.resource_kind,
    spec: parseJsonObject(row.spec_json, 'policy version spec'),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function mapRelationshipHistory(row: RelationshipHistoryRow) {
  return {
    id: row.id,
    relationshipId: row.relationship_id,
    sourceResourceId: row.source_resource_id,
    targetResourceId: row.target_resource_id,
    relationshipType: row.relationship_type,
    relationshipRevision: row.relationship_revision,
    createdAt: row.created_at,
    createdBy: row.created_by,
    removedAt: row.removed_at,
    removedBy: row.removed_by,
    operationId: row.operation_id,
  };
}

function mapBindingSnapshot(row: BindingRow) {
  return {
    ...mapBinding(row),
    active: row.active === 1,
  };
}

function mapBindingHistory(row: BindingHistoryRow) {
  return {
    id: row.id,
    resourceId: row.resource_id,
    providerId: row.provider_id,
    providerResourceType: row.provider_resource_type,
    providerResourceId: row.provider_resource_id,
    ...optionalProperty('providerResourceName', row.provider_resource_name),
    locator: parseJsonObject(row.locator_json, 'binding history locator'),
    boundAt: row.bound_at,
    unboundAt: row.unbound_at,
    boundBy: row.bound_by,
    unboundBy: row.unbound_by,
    ...optionalProperty('operationId', row.operation_id),
  };
}

function mapObservation(row: ObservationRow) {
  return {
    id: row.id,
    resourceId: row.resource_id,
    observerId: row.observer_id,
    observedAt: row.observed_at,
    facts: parseJsonObject(row.facts_json, 'observation facts'),
    expiresAt: row.expires_at,
    ...optionalProperty('archivedAt', row.archived_at),
    ...optionalProperty('r2ObjectKey', row.r2_object_key),
    createdAt: row.created_at,
  };
}

function mapDriftSnapshot(row: DriftRow) {
  return {
    ...mapDrift(row),
    fingerprint: row.fingerprint,
  };
}

function mapOperationResource(row: OperationResourceRow) {
  return {
    operationId: row.operation_id,
    resourceId: row.resource_id,
    resourceKey: row.resource_key,
    sourceState: row.source_state,
    targetState: row.target_state,
    resourceRevision: row.resource_revision,
  };
}

function mapOperationStepSnapshot(row: OperationStepRow) {
  return {
    ...mapOperationStep(row),
    updatedAt: row.updated_at,
  };
}

function mapOperationChange(row: OperationChangeRow) {
  return {
    operationId: row.operation_id,
    position: row.position,
    action: row.action,
    resourceId: row.resource_id,
    ...optionalProperty('providerId', row.provider_id),
    ...optionalProperty('providerResourceType', row.provider_resource_type),
    ...optionalProperty('providerResourceId', row.provider_resource_id),
    ...optionalProperty('relationshipId', row.relationship_id),
    ...optionalProperty('targetResourceId', row.target_resource_id),
    ...optionalProperty('relationshipType', row.relationship_type),
  };
}

function mapLock(row: LockRow) {
  return {
    scope: row.scope,
    operationId: row.operation_id,
    actorId: row.actor_id,
    fencingToken: row.fencing_token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLockGeneration(row: LockGenerationRow) {
  return { scope: row.scope, generation: row.generation };
}

function mapOutbox(row: OutboxRow) {
  return {
    id: row.id,
    eventId: row.event_id,
    topic: row.topic,
    payload: parseJsonObject(row.payload_json, 'outbox payload'),
    status: row.status,
    consumerAttempts: row.consumer_attempts,
    producerAttempts: row.producer_attempts,
    createdAt: row.created_at,
    ...optionalProperty('publishedAt', row.published_at),
    ...optionalProperty('lastError', row.last_error),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function mapExportSnapshot(row: ExportRow) {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    ...optionalProperty('checksum', row.checksum),
    ...optionalProperty('r2ObjectKey', row.r2_object_key),
    status: row.status,
    attempts: row.attempts,
    ...optionalProperty('leaseUntil', row.lease_until),
    revision: row.revision,
    createdAt: row.created_at,
    ...optionalProperty('completedAt', row.completed_at),
    requestedBy: row.requested_by,
    ...optionalProperty('errorMessage', row.error_message),
    ...optionalProperty('expiredAt', row.expired_at),
    updatedAt: row.updated_at,
  };
}
