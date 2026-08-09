import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import type {
  CreateResource,
  Drift,
  Health,
  ProviderBinding,
  Resource,
  ResourceQuery,
  ResourceRelationship,
  UpdateResource,
} from '../../domain/models/global-registry';
import { ensureJsonObject } from '../../domain/models/json';
import { boundedPageLimit, MAX_RESOURCE_DETAIL_PAGE_SIZE } from '../../domain/models/pagination';
import type { ResourceDetailQuery } from '../../application/ports';
import { D1Client, type SqlValue } from './client';
import { mapBinding, mapDrift, mapHealth, mapRelationship, mapResource } from './rows';
import { eventStatements, type SqlPredicate } from './transaction';
import type { BindingRow, DriftRow, HealthRow, RelationshipRow, ResourceRow } from './types';

export interface ResourceDetail {
  resource: Resource;
  binding: ProviderBinding | null;
  health: Health | null;
  relationships: ResourceRelationship[];
  drifts: Drift[];
  relationshipsNextCursor?: string;
  driftsNextCursor?: string;
}

export class D1Resources extends D1Client {
  async get(key: string): Promise<Resource | null> {
    const row = await this.first<ResourceRow>('SELECT * FROM resources WHERE key = ?', key);
    return row === null ? null : mapResource(row);
  }

  async getById(id: string): Promise<Resource | null> {
    const row = await this.first<ResourceRow>('SELECT * FROM resources WHERE id = ?', id);
    return row === null ? null : mapResource(row);
  }

  async list(query: ResourceQuery = {}): Promise<Resource[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const conditions: string[] = [];
    const params: SqlValue[] = [];
    if (query.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(query.kind);
    }
    if (query.lifecycleState !== undefined) {
      conditions.push('lifecycle_state = ?');
      params.push(query.lifecycleState);
    }
    if (query.cursor !== undefined) {
      conditions.push('key > ?');
      params.push(query.cursor);
    }
    params.push(limit);
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    return (
      await this.all<ResourceRow>(
        `SELECT * FROM resources ${where} ORDER BY key LIMIT ?`,
        ...params,
      )
    ).map(mapResource);
  }

  async getDetail(key: string, query: ResourceDetailQuery = {}): Promise<ResourceDetail | null> {
    const resource = await this.get(key);
    if (resource === null) return null;
    const relationshipLimit = boundedPageLimit(
      query.relationshipLimit,
      MAX_RESOURCE_DETAIL_PAGE_SIZE,
      50,
    );
    const driftLimit = boundedPageLimit(query.driftLimit, MAX_RESOURCE_DETAIL_PAGE_SIZE, 50);
    const relationshipParams: SqlValue[] = [resource.id, resource.id];
    const relationshipCursor =
      query.relationshipCursor === undefined ? '' : ' AND relationship.id > ?';
    if (query.relationshipCursor !== undefined) relationshipParams.push(query.relationshipCursor);
    relationshipParams.push(relationshipLimit + 1);
    const driftParams: SqlValue[] = [resource.id];
    const driftCursor = query.driftCursor === undefined ? '' : ' AND id > ?';
    if (query.driftCursor !== undefined) driftParams.push(query.driftCursor);
    driftParams.push(driftLimit + 1);
    const [bindingRow, healthRow, relationshipRows, driftRows] = await Promise.all([
      this.first<BindingRow>('SELECT * FROM provider_bindings WHERE resource_id = ?', resource.id),
      this.first<HealthRow>('SELECT * FROM health WHERE resource_id = ?', resource.id),
      this.all<RelationshipRow>(
        `SELECT relationship.* FROM resource_relationships relationship
         WHERE (source_resource_id = ? OR target_resource_id = ?)${relationshipCursor}
         ORDER BY relationship.id LIMIT ?`,
        ...relationshipParams,
      ),
      this.all<DriftRow>(
        `SELECT * FROM drifts WHERE resource_id = ?${driftCursor}
         ORDER BY id LIMIT ?`,
        ...driftParams,
      ),
    ]);
    const relationshipPage = relationshipRows.slice(0, relationshipLimit);
    const driftPage = driftRows.slice(0, driftLimit);
    const detail: ResourceDetail = {
      resource,
      binding: bindingRow === null ? null : mapBinding(bindingRow),
      health: healthRow === null ? null : mapHealth(healthRow),
      relationships: relationshipPage.map(mapRelationship),
      drifts: driftPage.map(mapDrift),
    };
    if (relationshipRows.length > relationshipLimit && relationshipPage.at(-1) !== undefined) {
      detail.relationshipsNextCursor = relationshipPage.at(-1)?.id as string;
    }
    if (driftRows.length > driftLimit && driftPage.at(-1) !== undefined) {
      detail.driftsNextCursor = driftPage.at(-1)?.id as string;
    }
    return detail;
  }

  async create(input: CreateResource): Promise<Resource> {
    const createdAt = new Date().toISOString();
    const placement = ensureJsonObject(input.placement, 'resource placement');
    const specOverrides = ensureJsonObject(input.specOverrides, 'resource spec overrides');
    const spec = ensureJsonObject(input.spec, 'resource effective spec');
    const resource: Resource = {
      id: crypto.randomUUID(),
      key: input.key,
      kind: input.kind,
      name: input.name,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(input.policy === undefined ? {} : { policy: input.policy }),
      placement,
      specOverrides,
      spec,
      lifecycleState: 'absent',
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const guard = resourceMutationGuard(input);
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'resource.created',
        resourceKey: resource.key,
        actorId: input.actorId,
        payload: { key: resource.key, kind: resource.kind, revision: resource.revision },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM resources WHERE id = ? AND revision = 1 AND created_at = ?
        )`,
        params: [resource.id, createdAt],
      },
    );
    try {
      const results = await this.db.batch([
        this.statement(
          `INSERT INTO resources (
            id, key, kind, name, profile_key, profile_version, policy_namespace, policy_key,
            policy_version, placement_json, spec_overrides_json, effective_spec_json,
            lifecycle_state, revision, created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'absent', 1, ?, ?
          WHERE ${guard.sql}`,
          resource.id,
          resource.key,
          resource.kind,
          resource.name,
          input.profile?.key ?? null,
          input.profile?.version ?? null,
          input.policy?.namespace ?? null,
          input.policy?.key ?? null,
          input.policy?.version ?? null,
          JSON.stringify(resource.placement),
          JSON.stringify(resource.specOverrides),
          JSON.stringify(resource.spec),
          createdAt,
          createdAt,
          ...guard.params,
        ),
        this.statement(
          `INSERT INTO health (
            resource_id, status, observed_at, observed_by, revision, updated_at
          ) SELECT ?, 'unknown', ?, ?, 1, ?
          WHERE EXISTS (SELECT 1 FROM resources WHERE id = ?)`,
          resource.id,
          createdAt,
          input.actorId,
          createdAt,
          resource.id,
        ),
        ...event,
      ]);
      if (results[0]?.meta.changes !== 1) {
        throw new ConflictError(
          'resource_dependencies_changed',
          'A referenced profile or policy changed while the resource candidate was validated.',
          { key: input.key },
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed: resources.key')
      ) {
        throw new ConflictError('duplicate_resource_key', 'Resource key must be globally unique.', {
          key: input.key,
        });
      }
      throw error;
    }
    return resource;
  }

  async update(input: UpdateResource): Promise<Resource> {
    const updatedAt = new Date().toISOString();
    const placement = ensureJsonObject(input.placement, 'resource placement');
    const specOverrides = ensureJsonObject(input.specOverrides, 'resource spec overrides');
    const spec = ensureJsonObject(input.spec, 'resource effective spec');
    const guard = resourceMutationGuard(input);
    const params: SqlValue[] = [
      input.name,
      JSON.stringify(placement),
      JSON.stringify(specOverrides),
      JSON.stringify(spec),
      input.profile?.key ?? null,
      input.profile?.version ?? null,
      input.policy?.namespace ?? null,
      input.policy?.key ?? null,
      input.policy?.version ?? null,
      updatedAt,
      input.key,
      input.expectedRevision,
      ...guard.params,
    ];
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'resource.updated',
        resourceKey: input.key,
        actorId: input.actorId,
        payload: { key: input.key, expectedRevision: input.expectedRevision },
      },
      {
        sql: 'EXISTS (SELECT 1 FROM resources WHERE key = ? AND revision = ? AND updated_at = ?)',
        params: [input.key, input.expectedRevision + 1, updatedAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE resources SET
          name = ?, placement_json = ?, spec_overrides_json = ?, effective_spec_json = ?,
          profile_key = ?, profile_version = ?, policy_namespace = ?,
          policy_key = ?, policy_version = ?, revision = revision + 1, updated_at = ?
         WHERE key = ? AND revision = ? AND ${guard.sql}`,
        ...params,
      ),
      ...event,
    ]);
    if (results[0]?.meta.changes !== 1) {
      const existing = await this.get(input.key);
      if (existing === null) throw new NotFoundError('Resource', input.key);
      if (existing.revision === input.expectedRevision) {
        throw new ConflictError(
          'resource_dependencies_changed',
          'A referenced profile, policy, binding, or provider changed while the resource candidate was validated.',
          { key: input.key },
        );
      }
      throw new ConflictError('revision_conflict', 'Resource revision is stale.', {
        key: input.key,
        expectedRevision: input.expectedRevision,
        currentRevision: existing.revision,
      });
    }
    const resource = await this.get(input.key);
    if (resource === null) throw new NotFoundError('Resource', input.key);
    return resource;
  }
}

function resourceMutationGuard(input: CreateResource | UpdateResource): SqlPredicate {
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (input.profileGuard !== undefined) {
    if (input.profile === undefined || input.profile === null) {
      throw new Error('A profile guard requires a profile reference.');
    }
    conditions.push(`EXISTS (
      SELECT 1 FROM profiles
      WHERE key = ? AND revision = ? AND status = ?
    )`);
    params.push(
      input.profile.key,
      input.profileGuard.expectedRevision,
      input.profileGuard.expectedStatus,
    );
  }
  if (input.policyGuard !== undefined) {
    if (input.policy === undefined || input.policy === null) {
      throw new Error('A policy guard requires a policy reference.');
    }
    conditions.push(`EXISTS (
      SELECT 1 FROM policies
      WHERE namespace = ? AND key = ? AND revision = ? AND status = ?
    )`);
    params.push(
      input.policy.namespace,
      input.policy.key,
      input.policyGuard.expectedRevision,
      input.policyGuard.expectedStatus,
    );
  }
  if ('boundProviderGuard' in input && input.boundProviderGuard !== undefined) {
    conditions.push(`EXISTS (
      SELECT 1
      FROM provider_bindings binding
      JOIN providers provider ON provider.id = binding.provider_id
      WHERE binding.resource_id = resources.id
        AND provider.id = ? AND provider.revision = ?
    )`);
    params.push(input.boundProviderGuard.providerId, input.boundProviderGuard.expectedRevision);
  }

  return {
    sql: conditions.length === 0 ? '1 = 1' : conditions.join(' AND '),
    params,
  };
}
