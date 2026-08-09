import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import {
  MAX_EXPORT_ATTEMPTS,
  MAX_EXPORT_RETENTION_AGE_DAYS,
  MAX_EXPORT_RETENTION_WORK,
  PORTABLE_EXPORT_QUERY_LIMIT,
  PORTABLE_EXPORT_SCHEMA_VERSION,
} from '../../application/limits';
import { assertValidRegistrySnapshot } from '../../application/registry-validation';
import {
  assertPortableExportRowCapacity,
  type PortableRegistrySnapshot,
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
  EventRow,
  ExportRow,
  HealthRow,
  LockGenerationRow,
  LockRow,
  ObservationRow,
  OperationChangeRow,
  OperationResourceRow,
  OperationRow,
  OperationStepRow,
  OutboxRow,
  PolicyRow,
  PolicyVersionRow,
  ProfileRow,
  ProfileVersionRow,
  ProviderRow,
  RelationshipHistoryRow,
  RelationshipRow,
  ResourceRow,
} from './types';

function now(): string {
  return new Date().toISOString();
}

export const EXPORT_LEASE_MS = 5 * 60 * 1000;

function exportClaimObjectKey(exportId: string, revision: number, claimToken: string): string {
  return `exports/${encodeURIComponent(exportId)}/${revision}-${claimToken}.json`;
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
        `UPDATE exports SET status = 'running', attempts = attempts + ?, lease_until = ?,
           error_message = NULL, completed_at = NULL, r2_object_key = NULL, r2_claim_token = NULL,
           claim_token = ?, claim_object_key = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND (
           (attempts < ? AND (
             status IN ('planned', 'failed')
             OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
           ))
           OR (attempts >= ? AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
         )`,
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

  async buildPortableSnapshot(): Promise<PortableRegistrySnapshot> {
    const bounded = (sql: string) => this.statement(`${sql}\nLIMIT ?`, PORTABLE_EXPORT_QUERY_LIMIT);
    const statements = [
      bounded('SELECT * FROM actors ORDER BY id'),
      bounded('SELECT * FROM providers ORDER BY id'),
      bounded('SELECT * FROM profiles ORDER BY key'),
      bounded('SELECT * FROM profile_versions ORDER BY profile_key, version'),
      bounded('SELECT * FROM policies ORDER BY namespace, key'),
      bounded('SELECT * FROM policy_versions ORDER BY namespace, policy_key, version'),
      bounded('SELECT * FROM resources ORDER BY key'),
      bounded('SELECT * FROM resource_relationships ORDER BY id'),
      bounded('SELECT * FROM resource_relationship_history ORDER BY removed_at, id'),
      bounded('SELECT * FROM provider_bindings ORDER BY resource_id'),
      bounded('SELECT * FROM provider_binding_history ORDER BY unbound_at, id'),
      bounded('SELECT * FROM health ORDER BY resource_id'),
      bounded('SELECT * FROM observations ORDER BY created_at, id'),
      bounded('SELECT * FROM drifts ORDER BY id'),
      bounded('SELECT * FROM operations ORDER BY created_at, id'),
      bounded(
        `SELECT operation_resources.*, resources.key AS resource_key
           FROM operation_resources
           JOIN resources ON resources.id = operation_resources.resource_id
          ORDER BY operation_resources.operation_id, operation_resources.resource_id`,
      ),
      bounded('SELECT * FROM operation_steps ORDER BY operation_id, position'),
      bounded('SELECT * FROM operation_changes ORDER BY operation_id, position'),
      bounded('SELECT * FROM resource_locks ORDER BY scope'),
      bounded('SELECT * FROM resource_lock_generations ORDER BY scope'),
      bounded('SELECT * FROM events ORDER BY occurred_at, event_id'),
      bounded('SELECT * FROM outbox ORDER BY created_at, id'),
      bounded('SELECT * FROM exports ORDER BY created_at, id'),
    ];
    const results = await this.db.batch(statements);
    if (results.length !== statements.length || results.some((result) => result.success !== true)) {
      throw new Error('export_snapshot_batch_failed');
    }
    const rows = results.map((result) => result.results);
    assertPortableExportRowCapacity(rows);
    const snapshot = {
      schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      exportedAt: now(),
      actors: rows[0]!.map((row) => mapActorSnapshot(row as ActorRow)),
      providers: rows[1]!.map((row) => mapProvider(row as ProviderRow)),
      profiles: rows[2]!.map((row) => mapProfileSnapshot(row as ProfileRow)),
      profileVersions: rows[3]!.map((row) => mapProfileVersionSnapshot(row as ProfileVersionRow)),
      policies: rows[4]!.map((row) => mapPolicySnapshot(row as PolicyRow)),
      policyVersions: rows[5]!.map((row) => mapPolicyVersionSnapshot(row as PolicyVersionRow)),
      resources: rows[6]!.map((row) => mapResource(row as ResourceRow)),
      relationships: rows[7]!.map((row) => mapRelationship(row as RelationshipRow)),
      relationshipHistory: rows[8]!.map((row) =>
        mapRelationshipHistory(row as RelationshipHistoryRow),
      ),
      bindings: rows[9]!.map((row) => mapBindingSnapshot(row as BindingRow)),
      bindingHistory: rows[10]!.map((row) => mapBindingHistory(row as BindingHistoryRow)),
      health: rows[11]!.map((row) => mapHealth(row as HealthRow)),
      observations: rows[12]!.map((row) => mapObservation(row as ObservationRow)),
      drifts: rows[13]!.map((row) => mapDriftSnapshot(row as DriftRow)),
      operations: rows[14]!.map((row) => mapOperation(row as OperationRow)),
      operationResources: rows[15]!.map((row) => mapOperationResource(row as OperationResourceRow)),
      operationSteps: rows[16]!.map((row) => mapOperationStepSnapshot(row as OperationStepRow)),
      operationChanges: rows[17]!.map((row) => mapOperationChange(row as OperationChangeRow)),
      locks: rows[18]!.map((row) => mapLock(row as LockRow)),
      lockGenerations: rows[19]!.map((row) => mapLockGeneration(row as LockGenerationRow)),
      events: rows[20]!.map((row) => mapEvent(row as EventRow)),
      outbox: rows[21]!.map((row) => mapOutbox(row as OutboxRow)),
      exports: rows[22]!.map((row) => mapExportSnapshot(row as ExportRow)),
    };
    return assertValidRegistrySnapshot(snapshot);
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
