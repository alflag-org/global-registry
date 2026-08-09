import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import type { ResourceRelationship } from '../../domain/models/global-registry';
import { D1Client } from './client';
import type { D1Resources } from './resources';
import { mapRelationship } from './rows';
import { assertFence, eventStatements, fencePredicate, requireMutation } from './transaction';
import type { RelationshipRow } from './types';

export interface CreateRelationshipInput {
  sourceKey: string;
  targetKey: string;
  relationshipType: ResourceRelationship['relationshipType'];
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export interface RemoveRelationshipInput {
  id: string;
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export class D1Relationships extends D1Client {
  constructor(
    db: D1Database,
    private readonly resources: D1Resources,
  ) {
    super(db);
  }

  async get(id: string): Promise<ResourceRelationship | null> {
    const row = await this.first<RelationshipRow>(
      'SELECT * FROM resource_relationships WHERE id = ?',
      id,
    );
    return row === null ? null : mapRelationship(row);
  }

  async create(input: CreateRelationshipInput): Promise<ResourceRelationship> {
    const [source, target] = await Promise.all([
      this.resources.get(input.sourceKey),
      this.resources.get(input.targetKey),
    ]);
    if (source === null) throw new NotFoundError('Resource', input.sourceKey);
    if (target === null) throw new NotFoundError('Resource', input.targetKey);

    const changedAt = new Date().toISOString();
    const scope = `resource/${input.sourceKey}`;
    await assertFence(this, scope, input.operationId, input.fencingToken, changedAt, input.actorId);
    const fence = fencePredicate(
      scope,
      input.operationId,
      input.fencingToken,
      changedAt,
      input.actorId,
    );
    const plan = {
      sql: `EXISTS (
        SELECT 1
        FROM operations operation
        JOIN operation_changes planned_change
          ON planned_change.operation_id = operation.id
        WHERE operation.id = ? AND operation.status = 'running'
          AND planned_change.action = 'relationship.create'
          AND planned_change.resource_id = ?
          AND planned_change.target_resource_id = ?
          AND planned_change.relationship_type = ?
      )`,
      params: [input.operationId, source.id, target.id, input.relationshipType],
    };
    const mutationGuard = `(${fence.sql}) AND (${plan.sql})`;
    const mutationGuardParams = [...fence.params, ...plan.params];
    const relationship: ResourceRelationship = {
      id: crypto.randomUUID(),
      sourceResourceId: source.id,
      targetResourceId: target.id,
      relationshipType: input.relationshipType,
      revision: 1,
      createdAt: changedAt,
      createdBy: input.actorId,
    };
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'relationship.created',
        actorId: input.actorId,
        resourceKey: input.sourceKey,
        operationId: input.operationId,
        payload: {
          relationshipId: relationship.id,
          sourceKey: input.sourceKey,
          targetKey: input.targetKey,
          type: input.relationshipType,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM resources WHERE id = ? AND revision = ? AND updated_at = ?
        ) AND ${mutationGuard}`,
        params: [source.id, input.expectedRevision + 1, changedAt, ...mutationGuardParams],
      },
    );

    try {
      const results = await this.db.batch([
        this.statement(
          `INSERT INTO resource_relationships (
            id, source_resource_id, target_resource_id, relationship_type, revision,
            created_at, created_by
          ) SELECT ?, ?, ?, ?, 1, ?, ?
          WHERE EXISTS (SELECT 1 FROM resources WHERE id = ? AND revision = ?)
            AND ${mutationGuard}`,
          relationship.id,
          relationship.sourceResourceId,
          relationship.targetResourceId,
          relationship.relationshipType,
          relationship.createdAt,
          relationship.createdBy,
          source.id,
          input.expectedRevision,
          ...mutationGuardParams,
        ),
        this.statement(
          `UPDATE resources SET revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND ${mutationGuard}`,
          changedAt,
          source.id,
          input.expectedRevision,
          ...mutationGuardParams,
        ),
        ...event,
      ]);
      requireMutation(results[1], 'Resource', input.sourceKey);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError('duplicate_relationship', 'The relationship already exists.');
      }
      throw error;
    }
    return relationship;
  }

  async remove(input: RemoveRelationshipInput): Promise<void> {
    const relationship = await this.first<RelationshipRow>(
      'SELECT * FROM resource_relationships WHERE id = ?',
      input.id,
    );
    if (relationship === null) throw new NotFoundError('Relationship', input.id);
    const source = await this.first<{ key: string; revision: number }>(
      'SELECT key, revision FROM resources WHERE id = ?',
      relationship.source_resource_id,
    );
    if (source === null) throw new NotFoundError('Resource', relationship.source_resource_id);

    const changedAt = new Date().toISOString();
    const scope = `resource/${source.key}`;
    await assertFence(this, scope, input.operationId, input.fencingToken, changedAt, input.actorId);
    const fence = fencePredicate(
      scope,
      input.operationId,
      input.fencingToken,
      changedAt,
      input.actorId,
    );
    const plan = {
      sql: `EXISTS (
        SELECT 1
        FROM operations operation
        JOIN operation_changes planned_change
          ON planned_change.operation_id = operation.id
        WHERE operation.id = ? AND operation.status = 'running'
          AND planned_change.action = 'relationship.remove'
          AND planned_change.resource_id = ?
          AND planned_change.relationship_id = ?
      )`,
      params: [input.operationId, relationship.source_resource_id, input.id],
    };
    const mutationGuard = `(${fence.sql}) AND (${plan.sql})`;
    const mutationGuardParams = [...fence.params, ...plan.params];
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'relationship.removed',
        actorId: input.actorId,
        resourceKey: source.key,
        operationId: input.operationId,
        payload: { relationshipId: input.id },
      },
      {
        sql: `NOT EXISTS (
          SELECT 1 FROM resource_relationships WHERE id = ?
        ) AND EXISTS (
          SELECT 1 FROM resources WHERE id = ? AND revision = ? AND updated_at = ?
        ) AND ${mutationGuard}`,
        params: [
          input.id,
          relationship.source_resource_id,
          source.revision + 1,
          changedAt,
          ...mutationGuardParams,
        ],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `INSERT INTO resource_relationship_history (
          id, relationship_id, source_resource_id, target_resource_id, relationship_type,
          relationship_revision, created_at, created_by, removed_at, removed_by, operation_id
        )
        SELECT ?, id, source_resource_id, target_resource_id, relationship_type, revision,
          created_at, created_by, ?, ?, ?
        FROM resource_relationships
        WHERE id = ? AND revision = ?
          AND EXISTS (
            SELECT 1 FROM resources WHERE id = ? AND revision = ?
          ) AND ${mutationGuard}`,
        crypto.randomUUID(),
        changedAt,
        input.actorId,
        input.operationId,
        input.id,
        input.expectedRevision,
        relationship.source_resource_id,
        source.revision,
        ...mutationGuardParams,
      ),
      this.statement(
        `DELETE FROM resource_relationships
         WHERE id = ? AND revision = ?
           AND EXISTS (
             SELECT 1 FROM resources WHERE id = ? AND revision = ?
           ) AND ${mutationGuard}`,
        input.id,
        input.expectedRevision,
        relationship.source_resource_id,
        source.revision,
        ...mutationGuardParams,
      ),
      this.statement(
        `UPDATE resources SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND ${mutationGuard}`,
        changedAt,
        relationship.source_resource_id,
        source.revision,
        ...mutationGuardParams,
      ),
      ...event,
    ]);
    requireMutation(results[1], 'Relationship', input.id);
    requireMutation(results[2], 'Resource', source.key);
  }
}
