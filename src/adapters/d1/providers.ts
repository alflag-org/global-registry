import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import type {
  JsonObject,
  Provider,
  ProviderBinding,
  Resource,
} from '../../domain/models/global-registry';
import { ensureCredentialFreeJsonObject, ensureJsonObject } from '../../domain/models/json';
import { boundedPageLimit } from '../../domain/models/pagination';
import { D1Client, type SqlValue } from './client';
import { mapBinding, mapProvider, mapResource } from './rows';
import { eventStatements } from './transaction';
import type { BindingRow, ProviderRow, ResourceRow } from './types';

export interface CreateProviderInput {
  id: string;
  driver: string;
  credentialRef: string;
  status: Provider['status'];
  capabilities: JsonObject;
  configuration: JsonObject;
  mappings: JsonObject;
  actorId: string;
}

export interface UpdateProviderInput {
  id: string;
  expectedRevision: number;
  expectedBindingRevision: number;
  expectedBoundResourceCount: number;
  actorId: string;
  driver?: string;
  credentialRef?: string;
  status?: Provider['status'];
  capabilities?: JsonObject;
  configuration?: JsonObject;
  mappings?: JsonObject;
  expectedBoundResources: Array<{
    id: string;
    key: string;
    revision: number;
  }>;
}

export class D1Providers extends D1Client {
  async get(id: string): Promise<Provider | null> {
    const row = await this.first<ProviderRow>('SELECT * FROM providers WHERE id = ?', id);
    return row === null ? null : mapProvider(row);
  }

  async list(limit?: number): Promise<Provider[]> {
    return (
      await this.all<ProviderRow>(
        'SELECT * FROM providers ORDER BY id LIMIT ?',
        boundedPageLimit(limit),
      )
    ).map(mapProvider);
  }

  async listBindings(
    providerId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{
    items: Array<{ binding: ProviderBinding; resource: Resource }>;
    nextCursor?: string;
  }> {
    const pageSize = boundedPageLimit(limit, 50, 50);
    const conditions = ['provider_id = ?'];
    const params: SqlValue[] = [providerId];
    if (cursor !== undefined) {
      conditions.push('resource_id > ?');
      params.push(cursor);
    }
    params.push(pageSize + 1);
    const bindings = await this.all<BindingRow>(
      `SELECT * FROM provider_bindings WHERE ${conditions.join(' AND ')}
       ORDER BY resource_id LIMIT ?`,
      ...params,
    );
    const page = bindings.slice(0, pageSize);
    const items = await Promise.all(
      page.map(async (row) => {
        const resourceRow = await this.first<ResourceRow>(
          'SELECT * FROM resources WHERE id = ?',
          row.resource_id,
        );
        if (resourceRow === null) throw new NotFoundError('Resource', row.resource_id);
        return { binding: mapBinding(row), resource: mapResource(resourceRow) };
      }),
    );
    if (bindings.length > pageSize && page.at(-1) !== undefined) {
      return { items, nextCursor: page.at(-1)?.resource_id as string };
    }
    return { items };
  }

  async create(input: CreateProviderInput): Promise<Provider> {
    const createdAt = new Date().toISOString();
    const capabilities = ensureJsonObject(input.capabilities, 'provider capabilities');
    const configuration = ensureCredentialFreeJsonObject(
      input.configuration,
      'provider configuration',
    );
    const mappings = ensureCredentialFreeJsonObject(input.mappings, 'provider mappings');
    const provider: Provider = {
      id: input.id,
      driver: input.driver,
      credentialRef: input.credentialRef,
      status: input.status,
      capabilities,
      configuration,
      mappings,
      bindingRevision: 0,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const event = eventStatements(this.statement.bind(this), {
      eventType: 'provider.created',
      actorId: input.actorId,
      payload: { id: provider.id, driver: provider.driver, revision: 1 },
    });
    try {
      await this.db.batch([
        this.statement(
          `INSERT INTO providers (
            id, driver, credential_ref, status, capabilities_json, configuration_json, mappings_json,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          provider.id,
          provider.driver,
          provider.credentialRef,
          provider.status,
          JSON.stringify(capabilities),
          JSON.stringify(configuration),
          JSON.stringify(mappings),
          createdAt,
          createdAt,
        ),
        ...event,
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError('duplicate_provider_id', 'Provider ID already exists.', {
          id: input.id,
        });
      }
      throw error;
    }
    return provider;
  }

  async update(input: UpdateProviderInput): Promise<Provider> {
    const updatedAt = new Date().toISOString();
    const assignments = ['revision = revision + 1', 'updated_at = ?'];
    const params: SqlValue[] = [updatedAt];
    if (input.driver !== undefined) {
      assignments.push('driver = ?');
      params.push(input.driver);
    }
    if (input.credentialRef !== undefined) {
      assignments.push('credential_ref = ?');
      params.push(input.credentialRef);
    }
    if (input.status !== undefined) {
      assignments.push('status = ?');
      params.push(input.status);
    }
    if (input.capabilities !== undefined) {
      assignments.push('capabilities_json = ?');
      params.push(JSON.stringify(ensureJsonObject(input.capabilities, 'provider capabilities')));
    }
    if (input.configuration !== undefined) {
      assignments.push('configuration_json = ?');
      params.push(
        JSON.stringify(
          ensureCredentialFreeJsonObject(input.configuration, 'provider configuration'),
        ),
      );
    }
    if (input.mappings !== undefined) {
      assignments.push('mappings_json = ?');
      params.push(
        JSON.stringify(ensureCredentialFreeJsonObject(input.mappings, 'provider mappings')),
      );
    }
    if (assignments.length === 2) {
      throw new Error('Provider persistence command must contain a mutable field.');
    }
    const resourceGuards = input.expectedBoundResources
      .map(
        () => `EXISTS (
          SELECT 1
          FROM resources resource
          JOIN provider_bindings binding ON binding.resource_id = resource.id
          WHERE resource.id = ? AND resource.revision = ? AND binding.provider_id = ?
        )`,
      )
      .join(' AND ');
    const resourceGuardParams: SqlValue[] = input.expectedBoundResources.flatMap((resource) => [
      resource.id,
      resource.revision,
      input.id,
    ]);
    params.push(
      input.id,
      input.expectedRevision,
      input.expectedBindingRevision,
      input.id,
      input.expectedBoundResourceCount,
      ...resourceGuardParams,
    );
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'provider.updated',
        actorId: input.actorId,
        payload: { id: input.id, expectedRevision: input.expectedRevision },
      },
      {
        sql: 'EXISTS (SELECT 1 FROM providers WHERE id = ? AND revision = ? AND updated_at = ?)',
        params: [input.id, input.expectedRevision + 1, updatedAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE providers SET ${assignments.join(', ')}
         WHERE id = ? AND revision = ? AND binding_revision = ?
           AND (SELECT COUNT(*) FROM provider_bindings WHERE provider_id = ?) = ?
           ${resourceGuards.length === 0 ? '' : `AND ${resourceGuards}`}`,
        ...params,
      ),
      ...event,
    ]);
    if (results[0]?.meta.changes !== 1) {
      const existing = await this.get(input.id);
      if (existing === null) throw new NotFoundError('Provider', input.id);
      if (existing.bindingRevision !== input.expectedBindingRevision) {
        throw new ConflictError(
          'provider_bindings_changed',
          'Provider bindings changed while the provider candidate was being validated.',
          {
            id: input.id,
            expectedBindingRevision: input.expectedBindingRevision,
            currentBindingRevision: existing.bindingRevision,
          },
        );
      }
      const bindingCount = await this.first<{ count: number }>(
        'SELECT COUNT(*) AS count FROM provider_bindings WHERE provider_id = ?',
        input.id,
      );
      if (bindingCount?.count !== input.expectedBoundResourceCount) {
        throw new ConflictError(
          'provider_bindings_changed',
          'Provider binding membership changed while the provider candidate was being validated.',
          {
            id: input.id,
            expectedBoundResourceCount: input.expectedBoundResourceCount,
            currentBoundResourceCount: bindingCount?.count ?? null,
          },
        );
      }
      for (const expected of input.expectedBoundResources) {
        const resource = await this.first<{ revision: number }>(
          'SELECT revision FROM resources WHERE id = ?',
          expected.id,
        );
        if (resource === null || resource.revision !== expected.revision) {
          throw new ConflictError(
            'provider_bound_resources_changed',
            'A bound resource changed while the provider candidate was being validated.',
            {
              id: input.id,
              resourceKey: expected.key,
              expectedRevision: expected.revision,
              currentRevision: resource?.revision ?? null,
            },
          );
        }
      }
      throw new ConflictError('revision_conflict', 'Provider revision is stale.', {
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: existing.revision,
      });
    }
    const provider = await this.get(input.id);
    if (provider === null) throw new NotFoundError('Provider', input.id);
    return provider;
  }
}
