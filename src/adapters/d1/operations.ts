import type {
  ChangeOperationStatusCommand,
  ChangeOperationStepCommand,
  CompleteOperationCommand,
  ForceCancelOperationCommand,
  OperationDetail,
  PersistOperationCommand,
  TransitionResourceCommand,
} from '../../application/operations';
import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import { ensureJsonObject } from '../../domain/models/json';
import { boundedPageLimit } from '../../domain/models/pagination';
import type {
  LockLease,
  Operation,
  OperationStatus,
  OperationStep,
  Resource,
} from '../../domain/models/global-registry';
import { D1Client, type SqlValue } from './client';
import type { D1Resources } from './resources';
import { mapOperation, mapOperationStep } from './rows';
import {
  assertFence,
  eventStatements,
  fencePredicate,
  requireMutation,
  type SqlPredicate,
} from './transaction';
import type { LockRow, OperationResourceRow, OperationRow, OperationStepRow } from './types';

interface AcquireLocksInput {
  operationId: string;
  scopes: string[];
  leaseSeconds: number;
  actorId: string;
}

function operationResource(row: OperationResourceRow): OperationDetail['resources'][number] {
  return {
    resourceKey: row.resource_key,
    sourceState: row.source_state,
    targetState: row.target_state,
    resourceRevision: row.resource_revision,
  };
}

interface CompletionIssueCounts {
  incomplete_resources: number;
  incomplete_steps: number;
  incomplete_changes: number;
}

function completionIssuesSql(): string {
  return `
    SELECT 'resource' AS kind
    FROM operation_resources planned_resource
    LEFT JOIN resources current_resource ON current_resource.id = planned_resource.resource_id
    WHERE planned_resource.operation_id = ?
      AND (
        current_resource.id IS NULL
        OR current_resource.lifecycle_state <> planned_resource.target_state
      )

    UNION ALL

    SELECT 'step' AS kind
    FROM operation_steps planned_step
    WHERE planned_step.operation_id = ?
      AND planned_step.status NOT IN ('succeeded', 'skipped')

    UNION ALL

    SELECT 'change' AS kind
    FROM operation_changes planned_change
    WHERE planned_change.operation_id = ?
      AND NOT (
        (
          planned_change.action = 'binding.replace'
          AND EXISTS (
            SELECT 1 FROM provider_bindings current_binding
            WHERE current_binding.resource_id = planned_change.resource_id
              AND current_binding.provider_id = planned_change.provider_id
              AND current_binding.provider_resource_type = planned_change.provider_resource_type
              AND current_binding.provider_resource_id = planned_change.provider_resource_id
          )
        )
        OR (
          planned_change.action = 'binding.remove'
          AND NOT EXISTS (
            SELECT 1 FROM provider_bindings current_binding
            WHERE current_binding.resource_id = planned_change.resource_id
          )
        )
        OR (
          planned_change.action = 'relationship.create'
          AND EXISTS (
            SELECT 1 FROM resource_relationships current_relationship
            WHERE current_relationship.source_resource_id = planned_change.resource_id
              AND current_relationship.target_resource_id = planned_change.target_resource_id
              AND current_relationship.relationship_type = planned_change.relationship_type
          )
        )
        OR (
          planned_change.action = 'relationship.remove'
          AND NOT EXISTS (
            SELECT 1 FROM resource_relationships current_relationship
            WHERE current_relationship.id = planned_change.relationship_id
          )
        )
      )`;
}

function completionPredicate(operationId: string): SqlPredicate {
  return {
    sql: `NOT EXISTS (${completionIssuesSql()})`,
    params: [operationId, operationId, operationId],
  };
}

function lockSnapshotPredicate(operationId: string, locks: readonly LockRow[]): SqlPredicate {
  const exactLocks = locks.map(
    () => `EXISTS (
      SELECT 1 FROM resource_locks
      WHERE scope = ? AND operation_id = ? AND actor_id = ? AND fencing_token = ?
        AND expires_at = ? AND created_at = ? AND updated_at = ?
    )`,
  );
  return {
    sql: ['(SELECT COUNT(*) FROM resource_locks WHERE operation_id = ?) = ?', ...exactLocks].join(
      ' AND ',
    ),
    params: [
      operationId,
      locks.length,
      ...locks.flatMap((lock) => [
        lock.scope,
        lock.operation_id,
        lock.actor_id,
        lock.fencing_token,
        lock.expires_at,
        lock.created_at,
        lock.updated_at,
      ]),
    ],
  };
}

export class D1Operations extends D1Client {
  constructor(
    db: D1Database,
    private readonly resources: D1Resources,
  ) {
    super(db);
  }

  private transitionPlanPredicate(input: TransitionResourceCommand): SqlPredicate {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM operations operation
        JOIN operation_resources planned ON planned.operation_id = operation.id
        WHERE operation.id = ?
          AND operation.status = 'running'
          AND planned.resource_id = ?
          AND planned.resource_revision = ?
          AND planned.source_state = ?
          AND planned.target_state = ?
      )`,
      params: [
        input.operationId,
        input.resourceId,
        input.expectedRevision,
        input.sourceState,
        input.targetState,
      ],
    };
  }

  async create(input: PersistOperationCommand): Promise<Operation> {
    const plan = ensureJsonObject(input.plan, 'operation plan');
    const resourceKeys = input.resources.map(({ resourceKey }) => resourceKey);
    const createdAt = new Date().toISOString();
    const operation: Operation = {
      id: `op_${crypto.randomUUID()}`,
      actorId: input.actorId,
      kind: input.kind,
      status: 'planned',
      plan,
      planHash: input.planHash,
      destructive: input.destructive,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'operation.planned',
        actorId: input.actorId,
        operationId: operation.id,
        payload: {
          kind: operation.kind,
          planHash: operation.planHash,
          resourceKeys,
          destructive: operation.destructive,
        },
      },
      {
        sql: 'EXISTS (SELECT 1 FROM operations WHERE id = ?)',
        params: [operation.id],
      },
    );
    const resourceGuards = input.resources
      .map(
        () =>
          `EXISTS (
            SELECT 1 FROM resources
            WHERE id = ? AND key = ? AND revision = ? AND lifecycle_state = ?
          )`,
      )
      .join(' AND ');
    const resourceGuardParams: SqlValue[] = input.resources.flatMap((resource) => [
      resource.resourceId,
      resource.resourceKey,
      resource.resourceRevision,
      resource.sourceState,
    ]);
    const statements: D1PreparedStatement[] = [
      this.statement(
        `INSERT INTO operations (
          id, actor_id, kind, status, plan_json, plan_hash, destructive, revision, created_at, updated_at
        )
        SELECT ?, ?, ?, 'planned', ?, ?, ?, 1, ?, ?
        WHERE ${resourceGuards}`,
        operation.id,
        operation.actorId,
        operation.kind,
        JSON.stringify(plan),
        operation.planHash,
        operation.destructive ? 1 : 0,
        createdAt,
        createdAt,
        ...resourceGuardParams,
      ),
      ...input.resources.map((planned) =>
        this.statement(
          `INSERT INTO operation_resources (
            operation_id, resource_id, source_state, target_state, resource_revision
          )
          SELECT ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM operations WHERE id = ?)`,
          operation.id,
          planned.resourceId,
          planned.sourceState,
          planned.targetState,
          planned.resourceRevision,
          operation.id,
        ),
      ),
      ...input.steps.map((step) =>
        this.statement(
          `INSERT INTO operation_steps (
            id, operation_id, position, name, status, gate_json, evidence_json, revision, updated_at
          )
          SELECT ?, ?, ?, ?, 'planned', ?, ?, 1, ?
          WHERE EXISTS (SELECT 1 FROM operations WHERE id = ?)`,
          crypto.randomUUID(),
          operation.id,
          step.position,
          step.name,
          JSON.stringify(ensureJsonObject(step.gate, 'operation step gate')),
          JSON.stringify(ensureJsonObject(step.evidence ?? {}, 'operation step evidence')),
          createdAt,
          operation.id,
        ),
      ),
      ...input.changes.map(({ change, position, resourceId, targetResourceId }) =>
        this.statement(
          `INSERT INTO operation_changes (
            operation_id, position, action, resource_id, provider_id, provider_resource_type,
            provider_resource_id, relationship_id, target_resource_id, relationship_type
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM operations WHERE id = ?)`,
          operation.id,
          position,
          change.action,
          resourceId,
          change.action === 'binding.replace' ? change.providerId : null,
          change.action === 'binding.replace' ? change.providerResourceType : null,
          change.action === 'binding.replace' ? change.providerResourceId : null,
          change.action === 'relationship.remove' ? change.relationshipId : null,
          targetResourceId,
          change.action === 'relationship.create' ? change.relationshipType : null,
          operation.id,
        ),
      ),
      ...event,
    ];
    const results = await this.db.batch(statements);
    requireMutation(results[0], 'Operation plan', operation.id);
    return operation;
  }

  async get(id: string): Promise<Operation | null> {
    const row = await this.first<OperationRow>('SELECT * FROM operations WHERE id = ?', id);
    return row === null ? null : mapOperation(row);
  }

  async getDetail(id: string): Promise<OperationDetail | null> {
    const operation = await this.get(id);
    if (operation === null) return null;
    const [resourceRows, stepRows] = await Promise.all([
      this.all<OperationResourceRow>(
        `SELECT opr.operation_id, opr.resource_id, r.key AS resource_key, opr.source_state,
          opr.target_state, opr.resource_revision
         FROM operation_resources opr JOIN resources r ON r.id = opr.resource_id
         WHERE opr.operation_id = ? ORDER BY r.key`,
        id,
      ),
      this.all<OperationStepRow>(
        'SELECT * FROM operation_steps WHERE operation_id = ? ORDER BY position',
        id,
      ),
    ]);
    return {
      operation,
      resources: resourceRows.map(operationResource),
      steps: stepRows.map(mapOperationStep),
    };
  }

  async list(status?: OperationStatus, limit?: number): Promise<Operation[]> {
    const rows =
      status === undefined
        ? await this.all<OperationRow>(
            'SELECT * FROM operations ORDER BY created_at DESC LIMIT ?',
            boundedPageLimit(limit),
          )
        : await this.all<OperationRow>(
            'SELECT * FROM operations WHERE status = ? ORDER BY created_at DESC LIMIT ?',
            status,
            boundedPageLimit(limit),
          );
    return rows.map(mapOperation);
  }

  async acquireLocks(
    input: AcquireLocksInput,
    eventType: 'lock.acquired' | 'lock.renewed' = 'lock.acquired',
  ): Promise<LockLease[]> {
    const acquiredAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(acquiredAt) + input.leaseSeconds * 1000).toISOString();
    const requestedValues = input.scopes.map(() => '(?)').join(', ');
    const scopePlaceholders = input.scopes.map(() => '?').join(', ');
    const eligibility = `
       WHERE NOT EXISTS (SELECT 1 FROM conflicts)
         AND EXISTS (
           SELECT 1 FROM operations
           WHERE id = ? AND actor_id = ? AND status IN ('planned', 'running')
         )
         AND NOT EXISTS (
           SELECT 1 FROM requested requested_scope
           WHERE NOT EXISTS (
             SELECT 1
             FROM operation_resources planned_resource
             JOIN resources planned_target ON planned_target.id = planned_resource.resource_id
             WHERE planned_resource.operation_id = ?
               AND planned_target.key = substr(requested_scope.scope, 10)
           )
         )`;
    const generationStatement = this.statement(
      `WITH requested(scope) AS (VALUES ${requestedValues}),
        conflicts AS (
          SELECT 1 FROM resource_locks
          WHERE scope IN (SELECT scope FROM requested) AND expires_at > ? AND operation_id <> ?
        )
       INSERT INTO resource_lock_generations (scope, generation)
       SELECT scope, 1 FROM requested
       ${eligibility}
       ON CONFLICT(scope) DO UPDATE SET generation = resource_lock_generations.generation + 1`,
      ...input.scopes,
      acquiredAt,
      input.operationId,
      input.operationId,
      input.actorId,
      input.operationId,
    );
    const lockStatement = this.statement(
      `WITH requested(scope) AS (VALUES ${requestedValues}),
        conflicts AS (
          SELECT 1 FROM resource_locks
          WHERE scope IN (SELECT scope FROM requested) AND expires_at > ? AND operation_id <> ?
        )
       INSERT INTO resource_locks (scope, operation_id, actor_id, fencing_token, expires_at, created_at, updated_at)
       SELECT requested.scope, ?, ?, generation.generation, ?, ?, ?
       FROM requested
       JOIN resource_lock_generations generation ON generation.scope = requested.scope
       ${eligibility}
       ON CONFLICT(scope) DO UPDATE SET
         operation_id = excluded.operation_id,
         actor_id = excluded.actor_id,
         fencing_token = excluded.fencing_token,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       WHERE resource_locks.operation_id = excluded.operation_id OR resource_locks.expires_at <= ?`,
      ...input.scopes,
      acquiredAt,
      input.operationId,
      input.operationId,
      input.actorId,
      expiresAt,
      acquiredAt,
      acquiredAt,
      input.operationId,
      input.actorId,
      input.operationId,
      acquiredAt,
    );
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType,
        actorId: input.actorId,
        operationId: input.operationId,
        payload: { scopes: input.scopes, expiresAt },
      },
      {
        sql: `(SELECT COUNT(*) FROM resource_locks
               WHERE scope IN (${scopePlaceholders}) AND operation_id = ? AND expires_at = ?) = ?`,
        params: [...input.scopes, input.operationId, expiresAt, input.scopes.length],
      },
    );
    const results = await this.db.batch([generationStatement, lockStatement, ...event]);
    if (results[1]?.meta.changes !== input.scopes.length) {
      throw new ConflictError(
        'lock_conflict',
        'One or more requested lock scopes are already leased.',
        { scopes: input.scopes },
      );
    }
    const locks = await this.all<LockRow>(
      `SELECT scope, operation_id, actor_id, fencing_token, expires_at FROM resource_locks
       WHERE scope IN (${scopePlaceholders}) AND operation_id = ? ORDER BY scope`,
      ...input.scopes,
      input.operationId,
    );
    if (locks.length !== input.scopes.length) {
      throw new ConflictError(
        'lock_acquisition_incomplete',
        'Lock acquisition did not produce every requested lease.',
      );
    }
    return locks.map((lock) => ({
      scope: lock.scope,
      operationId: lock.operation_id,
      fencingToken: lock.fencing_token,
      expiresAt: lock.expires_at,
    }));
  }

  async renewLocks(input: AcquireLocksInput): Promise<LockLease[]> {
    return this.acquireLocks(input, 'lock.renewed');
  }

  async releaseLocks(input: {
    operationId: string;
    scopes: string[];
    actorId: string;
  }): Promise<void> {
    const placeholders = input.scopes.map(() => '?').join(', ');
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'lock.released',
        actorId: input.actorId,
        operationId: input.operationId,
        payload: { scopes: input.scopes },
      },
      {
        sql: `changes() = ? AND NOT EXISTS (
          SELECT 1 FROM resource_locks
          WHERE operation_id = ? AND actor_id = ? AND scope IN (${placeholders})
        )`,
        params: [input.scopes.length, input.operationId, input.actorId, ...input.scopes],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `DELETE FROM resource_locks
         WHERE operation_id = ? AND actor_id = ? AND scope IN (${placeholders})
           AND (SELECT COUNT(*) FROM resource_locks
                WHERE operation_id = ? AND actor_id = ? AND scope IN (${placeholders})) = ?`,
        input.operationId,
        input.actorId,
        ...input.scopes,
        input.operationId,
        input.actorId,
        ...input.scopes,
        input.scopes.length,
      ),
      ...event,
    ]);
    if (results[0]?.meta.changes !== input.scopes.length) {
      throw new ConflictError(
        'lock_release_conflict',
        'The caller does not own every requested lock scope.',
        { operationId: input.operationId },
      );
    }
  }

  async transition(input: TransitionResourceCommand): Promise<Resource> {
    const changedAt = new Date().toISOString();
    const scope = `resource/${input.key}`;
    await assertFence(this, scope, input.operationId, input.fencingToken, changedAt, input.actorId);
    const fence = fencePredicate(
      scope,
      input.operationId,
      input.fencingToken,
      changedAt,
      input.actorId,
    );
    const plan = this.transitionPlanPredicate(input);
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'lifecycle.transition',
        actorId: input.actorId,
        resourceKey: input.key,
        operationId: input.operationId,
        payload: {
          from: input.sourceState,
          to: input.targetState,
          expectedRevision: input.expectedRevision,
          fencingToken: input.fencingToken,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM resources WHERE key = ? AND revision = ? AND updated_at = ?
        ) AND ${fence.sql} AND ${plan.sql}`,
        params: [input.key, input.expectedRevision + 1, changedAt, ...fence.params, ...plan.params],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE resources SET lifecycle_state = ?, revision = revision + 1, updated_at = ?
         WHERE key = ? AND revision = ? AND ${fence.sql} AND ${plan.sql}`,
        input.targetState,
        changedAt,
        input.key,
        input.expectedRevision,
        ...fence.params,
        ...plan.params,
      ),
      ...event,
    ]);
    requireMutation(results[0], 'Resource', input.key);
    const updated = await this.resources.get(input.key);
    if (updated === null) throw new NotFoundError('Resource', input.key);
    return updated;
  }

  async complete(input: CompleteOperationCommand): Promise<Operation> {
    const changedAt = new Date().toISOString();
    await assertFence(
      this,
      input.lockScope,
      input.id,
      input.fencingToken,
      changedAt,
      input.actorId,
    );
    const fence = fencePredicate(
      input.lockScope,
      input.id,
      input.fencingToken,
      changedAt,
      input.actorId,
    );
    const completion = completionPredicate(input.id);
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'operation.succeeded',
        actorId: input.actorId,
        operationId: input.id,
        payload: {
          from: 'running',
          to: 'succeeded',
          expectedRevision: input.expectedRevision,
          verification: 'authoritative_state',
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM operations
          WHERE id = ? AND status = 'succeeded' AND revision = ? AND updated_at = ?
        ) AND ${fence.sql} AND ${completion.sql}`,
        params: [
          input.id,
          input.expectedRevision + 1,
          changedAt,
          ...fence.params,
          ...completion.params,
        ],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE operations SET status = 'succeeded', revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND status = 'running'
           AND ${fence.sql} AND ${completion.sql}`,
        changedAt,
        input.id,
        input.expectedRevision,
        ...fence.params,
        ...completion.params,
      ),
      ...event,
    ]);
    if (results[0]?.meta.changes !== 1) {
      const current = await this.get(input.id);
      if (current?.status === 'running' && current.revision === input.expectedRevision) {
        const issues = await this.completionIssueCounts(input.id);
        if (
          issues.incomplete_resources > 0 ||
          issues.incomplete_steps > 0 ||
          issues.incomplete_changes > 0
        ) {
          throw new ConflictError(
            'operation_completion_incomplete',
            'The operation plan has not reached every completion condition.',
            {
              incompleteResources: issues.incomplete_resources,
              incompleteSteps: issues.incomplete_steps,
              incompleteChanges: issues.incomplete_changes,
            },
          );
        }
      }
      requireMutation(results[0], 'Operation', input.id);
    }
    const updated = await this.get(input.id);
    if (updated === null) throw new NotFoundError('Operation', input.id);
    return updated;
  }

  async updateStatus(input: ChangeOperationStatusCommand): Promise<Operation> {
    if (input.targetStatus === 'succeeded') {
      throw new ConflictError(
        'operation_completion_required',
        'Use the dedicated completion operation to enter succeeded status.',
      );
    }
    const changedAt = new Date().toISOString();
    await assertFence(
      this,
      input.lockScope,
      input.id,
      input.fencingToken,
      changedAt,
      input.actorId,
    );
    const fence = fencePredicate(
      input.lockScope,
      input.id,
      input.fencingToken,
      changedAt,
      input.actorId,
    );
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: `operation.${input.targetStatus}`,
        actorId: input.actorId,
        operationId: input.id,
        payload: {
          from: input.sourceStatus,
          to: input.targetStatus,
          expectedRevision: input.expectedRevision,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM operations WHERE id = ? AND revision = ? AND updated_at = ?
        ) AND ${fence.sql}`,
        params: [input.id, input.expectedRevision + 1, changedAt, ...fence.params],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE operations SET status = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND status = ? AND ${fence.sql}`,
        input.targetStatus,
        changedAt,
        input.id,
        input.expectedRevision,
        input.sourceStatus,
        ...fence.params,
      ),
      ...event,
    ]);
    requireMutation(results[0], 'Operation', input.id);
    const updated = await this.get(input.id);
    if (updated === null) throw new NotFoundError('Operation', input.id);
    return updated;
  }

  async forceCancel(input: ForceCancelOperationCommand): Promise<Operation> {
    const changedAt = new Date().toISOString();
    const locks = await this.all<LockRow>(
      `SELECT scope, operation_id, actor_id, fencing_token, expires_at, created_at, updated_at
       FROM resource_locks WHERE operation_id = ? ORDER BY scope`,
      input.id,
    );
    const snapshot = lockSnapshotPredicate(input.id, locks);
    const eventId = `evt_${crypto.randomUUID()}`;
    const outboxId = `out_${crypto.randomUUID()}`;
    const payload = ensureJsonObject(
      {
        from: 'running',
        to: 'cancelled',
        reason: input.reason,
        ownerActorId: input.ownerActorId,
        expectedRevision: input.expectedRevision,
        resultingRevision: input.expectedRevision + 1,
        lockSnapshot: locks.map((lock) => ({
          scope: lock.scope,
          operationId: lock.operation_id,
          actorId: lock.actor_id,
          fencingToken: lock.fencing_token,
          expiresAt: lock.expires_at,
          createdAt: lock.created_at,
          updatedAt: lock.updated_at,
        })),
      },
      'operation force-cancel event payload',
    );
    const serializedPayload = JSON.stringify(payload);
    const results = await this.db.batch([
      this.statement(
        `UPDATE operations SET status = 'cancelled', revision = revision + 1, updated_at = ?
         WHERE id = ? AND actor_id = ? AND revision = ? AND status = 'running'
           AND ${snapshot.sql}`,
        changedAt,
        input.id,
        input.ownerActorId,
        input.expectedRevision,
        ...snapshot.params,
      ),
      this.statement(
        `INSERT INTO events (
          event_id, event_type, operation_id, actor_id, payload_json, occurred_at
        )
        SELECT ?, 'operation.force_cancelled', ?, ?, ?, ?
        WHERE changes() = 1
          AND EXISTS (
            SELECT 1 FROM operations
            WHERE id = ? AND status = 'cancelled' AND revision = ? AND updated_at = ?
          )
          AND ${snapshot.sql}`,
        eventId,
        input.id,
        input.actorId,
        serializedPayload,
        changedAt,
        input.id,
        input.expectedRevision + 1,
        changedAt,
        ...snapshot.params,
      ),
      this.statement(
        `INSERT INTO outbox (id, event_id, topic, payload_json, created_at, updated_at)
         SELECT ?, ?, 'global-registry.operation.force_cancelled', ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM events WHERE event_id = ?)`,
        outboxId,
        eventId,
        serializedPayload,
        changedAt,
        changedAt,
        eventId,
      ),
      this.statement(
        `DELETE FROM resource_locks
         WHERE operation_id = ? AND EXISTS (SELECT 1 FROM events WHERE event_id = ?)`,
        input.id,
        eventId,
      ),
    ]);
    if (results[0]?.meta.changes !== 1) {
      throw new ConflictError(
        'operation_recovery_conflict',
        'The operation revision, status, owner, or lock snapshot changed before force-cancel.',
        { operationId: input.id },
      );
    }
    if (
      results[1]?.meta.changes !== 1 ||
      results[2]?.meta.changes !== 1 ||
      results[3]?.meta.changes !== locks.length
    ) {
      throw new ConflictError(
        'operation_recovery_incomplete',
        'Administrative force-cancel did not atomically record its audit/outbox state and release every operation lock.',
        { operationId: input.id },
      );
    }
    const updated = await this.get(input.id);
    if (updated === null) throw new NotFoundError('Operation', input.id);
    return updated;
  }

  async updateStep(input: ChangeOperationStepCommand): Promise<OperationStep> {
    const changedAt = new Date().toISOString();
    await assertFence(
      this,
      input.lockScope,
      input.operationId,
      input.fencingToken,
      changedAt,
      input.actorId,
    );
    const fence = fencePredicate(
      input.lockScope,
      input.operationId,
      input.fencingToken,
      changedAt,
      input.actorId,
    );
    const terminal = ['succeeded', 'failed', 'blocked', 'skipped'].includes(input.status);
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'operation.step_updated',
        actorId: input.actorId,
        operationId: input.operationId,
        payload: {
          stepId: input.stepId,
          status: input.status,
          expectedRevision: input.expectedRevision,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM operation_steps
          WHERE id = ? AND operation_id = ? AND revision = ? AND updated_at = ?
        ) AND ${fence.sql}`,
        params: [
          input.stepId,
          input.operationId,
          input.expectedRevision + 1,
          changedAt,
          ...fence.params,
        ],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE operation_steps
         SET status = ?, evidence_json = ?, revision = revision + 1, updated_at = ?,
           started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
           completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
         WHERE id = ? AND operation_id = ? AND revision = ? AND status = ? AND ${fence.sql}`,
        input.status,
        JSON.stringify(ensureJsonObject(input.evidence, 'operation step evidence')),
        changedAt,
        input.status,
        changedAt,
        terminal ? 1 : 0,
        changedAt,
        input.stepId,
        input.operationId,
        input.expectedRevision,
        input.sourceStatus,
        ...fence.params,
      ),
      ...event,
    ]);
    requireMutation(results[0], 'Operation step', input.stepId);
    const row = await this.first<OperationStepRow>(
      'SELECT * FROM operation_steps WHERE id = ?',
      input.stepId,
    );
    if (row === null) throw new NotFoundError('Operation step', input.stepId);
    return mapOperationStep(row);
  }

  private async completionIssueCounts(operationId: string): Promise<CompletionIssueCounts> {
    const counts = await this.first<CompletionIssueCounts>(
      `SELECT
        COALESCE(SUM(CASE WHEN issue.kind = 'resource' THEN 1 ELSE 0 END), 0)
          AS incomplete_resources,
        COALESCE(SUM(CASE WHEN issue.kind = 'step' THEN 1 ELSE 0 END), 0)
          AS incomplete_steps,
        COALESCE(SUM(CASE WHEN issue.kind = 'change' THEN 1 ELSE 0 END), 0)
          AS incomplete_changes
       FROM (${completionIssuesSql()}) issue`,
      operationId,
      operationId,
      operationId,
    );
    return counts ?? { incomplete_resources: 0, incomplete_steps: 0, incomplete_changes: 0 };
  }
}
