import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import type { JsonObject, ProviderBinding } from '../../domain/models/global-registry';
import { ensureJsonObject } from '../../domain/models/json';
import { D1Client, type SqlValue } from './client';
import type { D1Providers } from './providers';
import type { D1Resources } from './resources';
import { mapBinding } from './rows';
import { assertFence, eventStatements, fencePredicate, requireMutation } from './transaction';
import type { BindingRow } from './types';

export interface ReplaceBindingInput {
  resourceKey: string;
  providerId: string;
  providerResourceType: string;
  providerResourceId: string;
  providerResourceName?: string;
  locator: JsonObject;
  expectedRevision: number;
  expectedProviderRevision: number;
  expectedProviderBindingRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export interface RemoveBindingInput {
  resourceKey: string;
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export class D1Bindings extends D1Client {
  constructor(
    db: D1Database,
    private readonly resources: D1Resources,
    private readonly providers: D1Providers,
  ) {
    super(db);
  }

  async get(resourceKey: string): Promise<ProviderBinding | null> {
    const row = await this.first<BindingRow>(
      `SELECT b.* FROM provider_bindings b
       JOIN resources r ON r.id = b.resource_id WHERE r.key = ?`,
      resourceKey,
    );
    return row === null ? null : mapBinding(row);
  }

  async replace(input: ReplaceBindingInput): Promise<ProviderBinding> {
    const resource = await this.resources.get(input.resourceKey);
    if (resource === null) throw new NotFoundError('Resource', input.resourceKey);
    if ((await this.providers.get(input.providerId)) === null) {
      throw new NotFoundError('Provider', input.providerId);
    }
    const changedAt = new Date().toISOString();
    const locator = ensureJsonObject(input.locator, 'binding locator');
    const scope = `resource/${input.resourceKey}`;
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
          AND planned_change.action = 'binding.replace'
          AND planned_change.resource_id = ?
          AND planned_change.provider_id = ?
          AND planned_change.provider_resource_type = ?
          AND planned_change.provider_resource_id = ?
      )`,
      params: [
        input.operationId,
        resource.id,
        input.providerId,
        input.providerResourceType,
        input.providerResourceId,
      ],
    };
    const mutationGuard = `(${fence.sql}) AND (${plan.sql})`;
    const mutationGuardParams: SqlValue[] = [...fence.params, ...plan.params];
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'binding.replaced',
        actorId: input.actorId,
        resourceKey: input.resourceKey,
        operationId: input.operationId,
        payload: {
          providerId: input.providerId,
          providerResourceType: input.providerResourceType,
          providerResourceId: input.providerResourceId,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM resources WHERE key = ? AND revision = ? AND updated_at = ?
        ) AND ${mutationGuard}`,
        params: [input.resourceKey, input.expectedRevision + 1, changedAt, ...mutationGuardParams],
      },
    );
    try {
      const providerGuard = `EXISTS (
        SELECT 1 FROM providers
        WHERE id = ? AND revision = ? AND binding_revision = ? AND status = 'active'
      )`;
      const providerGuardParams: SqlValue[] = [
        input.providerId,
        input.expectedProviderRevision,
        input.expectedProviderBindingRevision + 1,
      ];
      const results = await this.db.batch([
        this.statement(
          `UPDATE providers SET binding_revision = binding_revision + 1
           WHERE id = ? AND revision = ? AND binding_revision = ? AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM resources WHERE id = ? AND revision = ?
             )
             AND ${mutationGuard}`,
          input.providerId,
          input.expectedProviderRevision,
          input.expectedProviderBindingRevision,
          resource.id,
          input.expectedRevision,
          ...mutationGuardParams,
        ),
        this.statement(
          `INSERT INTO provider_binding_history (
            id, resource_id, provider_id, provider_resource_type, provider_resource_id,
            provider_resource_name, locator_json, bound_at, unbound_at, bound_by, unbound_by,
            operation_id
          )
          SELECT ?, b.resource_id, b.provider_id, b.provider_resource_type, b.provider_resource_id,
            b.provider_resource_name, b.locator_json, b.bound_at, ?, b.bound_by, ?, ?
          FROM provider_bindings b JOIN resources r ON r.id = b.resource_id
          WHERE r.key = ? AND r.revision = ?
            AND ${providerGuard} AND ${mutationGuard}`,
          crypto.randomUUID(),
          changedAt,
          input.actorId,
          input.operationId,
          input.resourceKey,
          input.expectedRevision,
          ...providerGuardParams,
          ...mutationGuardParams,
        ),
        this.statement(
          `UPDATE providers SET binding_revision = binding_revision + 1
           WHERE id = (
             SELECT provider_id FROM provider_bindings WHERE resource_id = ?
           ) AND id <> ? AND ${providerGuard} AND ${mutationGuard}`,
          resource.id,
          input.providerId,
          ...providerGuardParams,
          ...mutationGuardParams,
        ),
        this.statement(
          `DELETE FROM provider_bindings
           WHERE resource_id = ?
             AND EXISTS (SELECT 1 FROM resources WHERE id = ? AND revision = ?)
             AND ${providerGuard} AND ${mutationGuard}`,
          resource.id,
          resource.id,
          input.expectedRevision,
          ...providerGuardParams,
          ...mutationGuardParams,
        ),
        this.statement(
          `INSERT INTO provider_bindings (
            resource_id, provider_id, provider_resource_type, provider_resource_id,
            provider_resource_name, locator_json, active, bound_at, bound_by
          ) SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?
          WHERE EXISTS (SELECT 1 FROM resources WHERE id = ? AND revision = ?)
            AND ${providerGuard} AND ${mutationGuard}`,
          resource.id,
          input.providerId,
          input.providerResourceType,
          input.providerResourceId,
          input.providerResourceName ?? null,
          JSON.stringify(locator),
          changedAt,
          input.actorId,
          resource.id,
          input.expectedRevision,
          ...providerGuardParams,
          ...mutationGuardParams,
        ),
        this.statement(
          `UPDATE resources SET revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?
             AND EXISTS (
               SELECT 1 FROM provider_bindings
               WHERE resource_id = ? AND provider_id = ?
                 AND provider_resource_type = ? AND provider_resource_id = ?
             )
             AND ${providerGuard} AND ${mutationGuard}`,
          changedAt,
          resource.id,
          input.expectedRevision,
          resource.id,
          input.providerId,
          input.providerResourceType,
          input.providerResourceId,
          ...providerGuardParams,
          ...mutationGuardParams,
        ),
        ...event,
      ]);
      requireMutation(results[0], 'Provider', input.providerId);
      requireMutation(results[5], 'Resource', input.resourceKey);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError(
          'duplicate_provider_binding',
          'This provider resource is already bound to a different Global Registry resource.',
          { providerId: input.providerId, providerResourceId: input.providerResourceId },
        );
      }
      throw error;
    }
    const binding = await this.get(input.resourceKey);
    if (binding === null) {
      throw new ConflictError('binding_not_created', 'Binding update did not complete.');
    }
    return binding;
  }

  async remove(input: RemoveBindingInput): Promise<void> {
    const resource = await this.resources.get(input.resourceKey);
    if (resource === null) throw new NotFoundError('Resource', input.resourceKey);
    const changedAt = new Date().toISOString();
    const scope = `resource/${input.resourceKey}`;
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
          AND planned_change.action = 'binding.remove'
          AND planned_change.resource_id = ?
      )`,
      params: [input.operationId, resource.id],
    };
    const mutationGuard = `(${fence.sql}) AND (${plan.sql})`;
    const mutationGuardParams: SqlValue[] = [...fence.params, ...plan.params];
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'binding.removed',
        actorId: input.actorId,
        resourceKey: input.resourceKey,
        operationId: input.operationId,
        payload: { key: input.resourceKey },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM resources WHERE key = ? AND revision = ? AND updated_at = ?
        ) AND ${mutationGuard}`,
        params: [input.resourceKey, input.expectedRevision + 1, changedAt, ...mutationGuardParams],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE providers SET binding_revision = binding_revision + 1
         WHERE id = (
           SELECT provider_id FROM provider_bindings WHERE resource_id = ?
         )
           AND EXISTS (
             SELECT 1 FROM resources WHERE id = ? AND revision = ?
           )
           AND ${mutationGuard}`,
        resource.id,
        resource.id,
        input.expectedRevision,
        ...mutationGuardParams,
      ),
      this.statement(
        `INSERT INTO provider_binding_history (
          id, resource_id, provider_id, provider_resource_type, provider_resource_id,
          provider_resource_name, locator_json, bound_at, unbound_at, bound_by, unbound_by,
          operation_id
        )
        SELECT ?, b.resource_id, b.provider_id, b.provider_resource_type, b.provider_resource_id,
          b.provider_resource_name, b.locator_json, b.bound_at, ?, b.bound_by, ?, ?
        FROM provider_bindings b JOIN resources r ON r.id = b.resource_id
        WHERE r.key = ? AND r.revision = ? AND ${mutationGuard}`,
        crypto.randomUUID(),
        changedAt,
        input.actorId,
        input.operationId,
        input.resourceKey,
        input.expectedRevision,
        ...mutationGuardParams,
      ),
      this.statement(
        `UPDATE resources SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?
           AND EXISTS (SELECT 1 FROM provider_bindings WHERE resource_id = ?)
           AND ${mutationGuard}`,
        changedAt,
        resource.id,
        input.expectedRevision,
        resource.id,
        ...mutationGuardParams,
      ),
      this.statement(
        `DELETE FROM provider_bindings WHERE resource_id = ?
         AND EXISTS (SELECT 1 FROM resources WHERE id = ? AND revision = ? AND updated_at = ?)
         AND ${mutationGuard}`,
        resource.id,
        resource.id,
        input.expectedRevision + 1,
        changedAt,
        ...mutationGuardParams,
      ),
      ...event,
    ]);
    requireMutation(results[0], 'Provider binding', input.resourceKey);
    requireMutation(results[2], 'Resource binding', input.resourceKey);
  }
}
