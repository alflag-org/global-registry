import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import { ensureJsonObject, jsonFingerprint, parseJsonObject } from '../../domain/models/json';
import { MAX_OBSERVATION_ARCHIVE_WORK } from '../../application/limits';
import type {
  Drift,
  Health,
  HealthStatus,
  JsonObject,
  Observation,
} from '../../domain/models/global-registry';
import { boundedPageLimit, MAX_DRIFTS_PER_RESOURCE } from '../../domain/models/pagination';
import { D1Client } from './client';
import type { D1Resources } from './resources';
import { mapDrift, mapHealth } from './rows';
import { eventStatements, requireMutation } from './transaction';
import type { DriftRow, HealthRow, ObservationRow } from './types';

export interface PutHealthInput {
  resourceKey: string;
  status: HealthStatus;
  reason?: string;
  observedAt: string;
  expectedRevision: number;
  actorId: string;
}

export interface CreateObservationInput {
  resourceKey: string;
  observedAt: string;
  facts: JsonObject;
  retentionHours: number;
  actorId: string;
}

export interface CreateDriftInput {
  resourceKey: string;
  severity: Drift['severity'];
  expected: JsonObject;
  observed: JsonObject;
  actorId: string;
}

export interface UpdateDriftInput {
  id: string;
  status: Drift['status'];
  expectedRevision: number;
  actorId: string;
}

export interface ExpiredObservation {
  id: string;
  resourceId: string;
  resourceKey: string;
  observerId: string;
  observedAt: string;
  facts: JsonObject;
  expiresAt: string;
  createdAt: string;
}

export class D1Observations extends D1Client {
  constructor(
    db: D1Database,
    private readonly resources: D1Resources,
  ) {
    super(db);
  }

  async getHealth(resourceKey: string): Promise<Health | null> {
    const row = await this.first<HealthRow>(
      `SELECT h.* FROM health h JOIN resources r ON r.id = h.resource_id WHERE r.key = ?`,
      resourceKey,
    );
    return row === null ? null : mapHealth(row);
  }

  async putHealth(input: PutHealthInput): Promise<Health> {
    const resource = await this.resources.get(input.resourceKey);
    if (resource === null) throw new NotFoundError('Resource', input.resourceKey);
    const updatedAt = new Date().toISOString();
    const existing = await this.getHealth(input.resourceKey);
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'health.updated',
        actorId: input.actorId,
        resourceKey: input.resourceKey,
        payload: { status: input.status, expectedRevision: input.expectedRevision },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM health WHERE resource_id = ? AND revision = ? AND updated_at = ?
        )`,
        params: [resource.id, input.expectedRevision + 1, updatedAt],
      },
    );
    if (existing === null) {
      if (input.expectedRevision !== 0) {
        throw new ConflictError(
          'revision_conflict',
          'Health record does not have the expected revision.',
        );
      }
      const results = await this.db.batch([
        this.statement(
          `INSERT INTO health (resource_id, status, reason, observed_at, observed_by, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
          resource.id,
          input.status,
          input.reason ?? null,
          input.observedAt,
          input.actorId,
          updatedAt,
        ),
        ...event,
      ]);
      requireMutation(results[0], 'Health', input.resourceKey);
    } else {
      const results = await this.db.batch([
        this.statement(
          `UPDATE health SET status = ?, reason = ?, observed_at = ?, observed_by = ?,
             revision = revision + 1, updated_at = ?
           WHERE resource_id = ? AND revision = ?`,
          input.status,
          input.reason ?? null,
          input.observedAt,
          input.actorId,
          updatedAt,
          resource.id,
          input.expectedRevision,
        ),
        ...event,
      ]);
      requireMutation(results[0], 'Health', input.resourceKey);
    }
    const health = await this.getHealth(input.resourceKey);
    if (health === null) throw new NotFoundError('Health', input.resourceKey);
    return health;
  }

  async create(input: CreateObservationInput): Promise<Observation> {
    const resource = await this.resources.get(input.resourceKey);
    if (resource === null) throw new NotFoundError('Resource', input.resourceKey);
    const createdAt = new Date().toISOString();
    const facts = ensureJsonObject(input.facts, 'observation facts');
    const observation: Observation = {
      id: crypto.randomUUID(),
      resourceId: resource.id,
      observerId: input.actorId,
      observedAt: input.observedAt,
      facts,
      expiresAt: new Date(
        Date.parse(createdAt) + input.retentionHours * 60 * 60 * 1000,
      ).toISOString(),
      createdAt,
    };
    const event = eventStatements(this.statement.bind(this), {
      eventType: 'observation.recorded',
      actorId: input.actorId,
      resourceKey: input.resourceKey,
      payload: { observationId: observation.id, observedAt: observation.observedAt },
    });
    await this.db.batch([
      this.statement(
        `INSERT INTO observations (
          id, resource_id, observer_id, observed_at, facts_json, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        observation.id,
        observation.resourceId,
        observation.observerId,
        observation.observedAt,
        JSON.stringify(facts),
        observation.expiresAt,
        observation.createdAt,
      ),
      ...event,
    ]);
    return observation;
  }

  async listExpired(referenceTime: string, limit = 100): Promise<ExpiredObservation[]> {
    const rows = await this.all<ObservationRow & { resource_key: string }>(
      `SELECT observation.*, resource.key AS resource_key
       FROM observations observation
       JOIN resources resource ON resource.id = observation.resource_id
       WHERE observation.expires_at <= ? AND observation.archived_at IS NULL
       ORDER BY observation.expires_at, observation.id
       LIMIT ?`,
      referenceTime,
      Math.min(Math.max(limit, 1), MAX_OBSERVATION_ARCHIVE_WORK),
    );
    return rows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      resourceKey: row.resource_key,
      observerId: row.observer_id,
      observedAt: row.observed_at,
      facts: parseJsonObject(row.facts_json, 'observation facts'),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  async markArchived(input: {
    id: string;
    resourceKey: string;
    r2ObjectKey: string;
    actorId: string;
  }): Promise<boolean> {
    const archivedAt = new Date().toISOString();
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'observation.archived',
        actorId: input.actorId,
        resourceKey: input.resourceKey,
        payload: {
          observationId: input.id,
          r2ObjectKey: input.r2ObjectKey,
          archivedAt,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM observations
          WHERE id = ? AND archived_at = ? AND r2_object_key = ?
        )`,
        params: [input.id, archivedAt, input.r2ObjectKey],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE observations SET archived_at = ?, r2_object_key = ?
         WHERE id = ? AND archived_at IS NULL`,
        archivedAt,
        input.r2ObjectKey,
        input.id,
      ),
      ...event,
    ]);
    return results[0]?.meta.changes === 1;
  }

  async createDrift(input: CreateDriftInput): Promise<Drift> {
    const resource = await this.resources.get(input.resourceKey);
    if (resource === null) throw new NotFoundError('Resource', input.resourceKey);
    const createdAt = new Date().toISOString();
    const expected = ensureJsonObject(input.expected, 'drift expected state');
    const observed = ensureJsonObject(input.observed, 'drift observed state');
    const fingerprint = await jsonFingerprint({
      severity: input.severity,
      expected,
      observed,
    });
    const duplicate = await this.first<{ id: string }>(
      `SELECT id FROM drifts
       WHERE resource_id = ? AND fingerprint = ? AND status <> 'resolved' LIMIT 1`,
      resource.id,
      fingerprint,
    );
    if (duplicate !== null) {
      throw new ConflictError(
        'duplicate_drift',
        'An equivalent active drift already exists for this resource.',
        { resourceKey: input.resourceKey },
      );
    }
    const drift: Drift = {
      id: crypto.randomUUID(),
      resourceId: resource.id,
      severity: input.severity,
      status: 'open',
      expected,
      observed,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      createdBy: input.actorId,
    };
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'drift.created',
        actorId: input.actorId,
        resourceKey: input.resourceKey,
        payload: { driftId: drift.id, severity: drift.severity },
      },
      {
        sql: 'EXISTS (SELECT 1 FROM drifts WHERE id = ? AND created_at = ?)',
        params: [drift.id, drift.createdAt],
      },
    );
    try {
      const results = await this.db.batch([
        this.statement(
          `INSERT INTO drifts (
          id, resource_id, severity, status, fingerprint, expected_json, observed_json, revision,
          created_at, updated_at, created_by
        ) SELECT ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM drifts WHERE resource_id = ?) < ?`,
          drift.id,
          drift.resourceId,
          drift.severity,
          fingerprint,
          JSON.stringify(expected),
          JSON.stringify(observed),
          drift.createdAt,
          drift.updatedAt,
          drift.createdBy,
          drift.resourceId,
          MAX_DRIFTS_PER_RESOURCE,
        ),
        ...event,
      ]);
      if (results[0]?.meta.changes !== 1) {
        throw new ConflictError(
          'drift_quota_exceeded',
          'The resource drift retention quota has been reached.',
          { resourceKey: input.resourceKey, maximum: MAX_DRIFTS_PER_RESOURCE },
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('idx_drifts_active_fingerprint') ||
          error.message.includes('drifts.resource_id, drifts.fingerprint'))
      ) {
        throw new ConflictError(
          'duplicate_drift',
          'An equivalent active drift already exists for this resource.',
          { resourceKey: input.resourceKey },
        );
      }
      throw error;
    }
    return drift;
  }

  async getDrift(id: string): Promise<Drift | null> {
    const row = await this.first<DriftRow>('SELECT * FROM drifts WHERE id = ?', id);
    return row === null ? null : mapDrift(row);
  }

  async updateDrift(input: UpdateDriftInput): Promise<Drift> {
    const changedAt = new Date().toISOString();
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'drift.updated',
        actorId: input.actorId,
        payload: {
          driftId: input.id,
          status: input.status,
          expectedRevision: input.expectedRevision,
        },
      },
      {
        sql: 'EXISTS (SELECT 1 FROM drifts WHERE id = ? AND revision = ? AND updated_at = ?)',
        params: [input.id, input.expectedRevision + 1, changedAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE drifts SET status = ?, revision = revision + 1, updated_at = ?,
           resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END
         WHERE id = ? AND revision = ?`,
        input.status,
        changedAt,
        input.status,
        changedAt,
        input.id,
        input.expectedRevision,
      ),
      ...event,
    ]);
    requireMutation(results[0], 'Drift', input.id);
    const drift = await this.getDrift(input.id);
    if (drift === null) throw new NotFoundError('Drift', input.id);
    return drift;
  }

  async listDrifts(status?: Drift['status'], limit?: number): Promise<Drift[]> {
    const rows =
      status === undefined
        ? await this.all<DriftRow>(
            'SELECT * FROM drifts ORDER BY updated_at DESC LIMIT ?',
            boundedPageLimit(limit),
          )
        : await this.all<DriftRow>(
            'SELECT * FROM drifts WHERE status = ? ORDER BY updated_at DESC LIMIT ?',
            status,
            boundedPageLimit(limit),
          );
    return rows.map(mapDrift);
  }
}
