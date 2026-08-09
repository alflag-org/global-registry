import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import { ensureJsonObject, parseJsonObject } from '../../domain/models/json';
import type { JsonObject, PolicyVersion, Resource } from '../../domain/models/global-registry';
import { boundedPageLimit } from '../../domain/models/pagination';
import { D1Client } from './client';
import { eventStatements } from './transaction';

export interface CreatePolicyInput {
  namespace: string;
  key: string;
  resourceKind: Resource['kind'];
  spec: JsonObject;
  actorId: string;
  expectedRevision?: number;
}

export interface PolicySummary {
  namespace: string;
  key: string;
  resourceKind: Resource['kind'];
  version: number;
  status: PolicyVersion['parentStatus'];
  revision: number;
}

export class D1Policies extends D1Client {
  async createVersion(input: CreatePolicyInput): Promise<PolicyVersion> {
    const existing = await this.first<{
      current_version: number;
      revision: number;
    }>('SELECT * FROM policies WHERE namespace = ? AND key = ?', input.namespace, input.key);
    const createdAt = new Date().toISOString();
    const spec = ensureJsonObject(input.spec, 'policy spec');
    if (existing === null) {
      const event = eventStatements(this.statement.bind(this), {
        eventType: 'policy.created',
        actorId: input.actorId,
        payload: { namespace: input.namespace, key: input.key, version: 1 },
      });
      await this.db.batch([
        this.statement(
          `INSERT INTO policies (
            namespace, key, current_version, revision, created_at, updated_at
          ) VALUES (?, ?, 1, 1, ?, ?)`,
          input.namespace,
          input.key,
          createdAt,
          createdAt,
        ),
        this.statement(
          `INSERT INTO policy_versions (
            namespace, policy_key, version, resource_kind, spec_json, created_at, created_by
          ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
          input.namespace,
          input.key,
          input.resourceKind,
          JSON.stringify(spec),
          createdAt,
          input.actorId,
        ),
        ...event,
      ]);
      return {
        namespace: input.namespace,
        key: input.key,
        version: 1,
        resourceKind: input.resourceKind,
        spec,
        parentStatus: 'active',
        revision: 1,
        createdAt,
      };
    }
    if (input.expectedRevision === undefined) {
      throw new Error('Existing policy persistence requires expectedRevision.');
    }
    const version = existing.current_version + 1;
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'policy.version_created',
        actorId: input.actorId,
        payload: {
          namespace: input.namespace,
          key: input.key,
          version,
          expectedRevision: input.expectedRevision,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM policies
          WHERE namespace = ? AND key = ? AND revision = ? AND updated_at = ?
        )`,
        params: [input.namespace, input.key, input.expectedRevision + 1, createdAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `INSERT INTO policy_versions (
          namespace, policy_key, version, resource_kind, spec_json, created_at, created_by
        )
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM policies WHERE namespace = ? AND key = ? AND revision = ?
        )`,
        input.namespace,
        input.key,
        version,
        input.resourceKind,
        JSON.stringify(spec),
        createdAt,
        input.actorId,
        input.namespace,
        input.key,
        input.expectedRevision,
      ),
      this.statement(
        `UPDATE policies SET current_version = ?, revision = revision + 1, updated_at = ?
         WHERE namespace = ? AND key = ? AND revision = ?`,
        version,
        createdAt,
        input.namespace,
        input.key,
        input.expectedRevision,
      ),
      ...event,
    ]);
    if (results[1]?.meta.changes !== 1) {
      throw new ConflictError('revision_conflict', 'Policy revision is stale.', {
        namespace: input.namespace,
        key: input.key,
        expectedRevision: input.expectedRevision,
      });
    }
    return {
      namespace: input.namespace,
      key: input.key,
      version,
      resourceKind: input.resourceKind,
      spec,
      parentStatus: 'active',
      revision: input.expectedRevision + 1,
      createdAt,
    };
  }

  async getVersion(namespace: string, key: string, version: number): Promise<PolicyVersion | null> {
    const row = await this.first<{
      namespace: string;
      key: string;
      revision: number;
      version: number;
      resource_kind: Resource['kind'];
      status: PolicyVersion['parentStatus'];
      spec_json: string;
      created_at: string;
    }>(
      `SELECT p.namespace, p.key, p.revision, p.status, pv.version, pv.resource_kind,
          pv.spec_json, pv.created_at
       FROM policies p JOIN policy_versions pv
         ON pv.namespace = p.namespace AND pv.policy_key = p.key
       WHERE p.namespace = ? AND p.key = ? AND pv.version = ?`,
      namespace,
      key,
      version,
    );
    return row === null
      ? null
      : {
          namespace: row.namespace,
          key: row.key,
          version: row.version,
          resourceKind: row.resource_kind,
          spec: parseJsonObject(row.spec_json, 'policy spec'),
          parentStatus: row.status,
          revision: row.revision,
          createdAt: row.created_at,
        };
  }

  async getSummary(namespace: string, key: string): Promise<PolicySummary | null> {
    const row = await this.first<{
      namespace: string;
      key: string;
      current_version: number;
      resource_kind: Resource['kind'];
      status: PolicyVersion['parentStatus'];
      revision: number;
    }>(
      `SELECT p.namespace, p.key, p.current_version, pv.resource_kind, p.status, p.revision
       FROM policies p JOIN policy_versions pv
         ON pv.namespace = p.namespace AND pv.policy_key = p.key
         AND pv.version = p.current_version
       WHERE p.namespace = ? AND p.key = ?`,
      namespace,
      key,
    );
    return row === null
      ? null
      : {
          namespace: row.namespace,
          key: row.key,
          resourceKind: row.resource_kind,
          version: row.current_version,
          status: row.status,
          revision: row.revision,
        };
  }

  async updateStatus(input: {
    namespace: string;
    key: string;
    status: PolicyVersion['parentStatus'];
    expectedRevision: number;
    actorId: string;
  }): Promise<PolicySummary> {
    const updatedAt = new Date().toISOString();
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'policy.status_changed',
        actorId: input.actorId,
        payload: { namespace: input.namespace, key: input.key, status: input.status },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM policies
          WHERE namespace = ? AND key = ? AND revision = ? AND updated_at = ?
        )`,
        params: [input.namespace, input.key, input.expectedRevision + 1, updatedAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE policies SET status = ?, revision = revision + 1, updated_at = ?
         WHERE namespace = ? AND key = ? AND revision = ?`,
        input.status,
        updatedAt,
        input.namespace,
        input.key,
        input.expectedRevision,
      ),
      ...event,
    ]);
    if (results[0]?.meta.changes !== 1) {
      const current = await this.getSummary(input.namespace, input.key);
      if (current === null) throw new NotFoundError('Policy', `${input.namespace}/${input.key}`);
      throw new ConflictError('revision_conflict', 'Policy revision is stale.', {
        namespace: input.namespace,
        key: input.key,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
      });
    }
    const updated = await this.getSummary(input.namespace, input.key);
    if (updated === null) throw new NotFoundError('Policy', `${input.namespace}/${input.key}`);
    return updated;
  }

  async list(limit?: number): Promise<PolicySummary[]> {
    const rows = await this.all<{
      namespace: string;
      key: string;
      current_version: number;
      resource_kind: Resource['kind'];
      status: PolicyVersion['parentStatus'];
      revision: number;
    }>(
      `SELECT p.namespace, p.key, p.current_version, pv.resource_kind, p.status, p.revision
       FROM policies p JOIN policy_versions pv
         ON pv.namespace = p.namespace AND pv.policy_key = p.key
         AND pv.version = p.current_version
       ORDER BY p.namespace, p.key LIMIT ?`,
      boundedPageLimit(limit),
    );
    return rows.map((row) => ({
      namespace: row.namespace,
      key: row.key,
      resourceKind: row.resource_kind,
      version: row.current_version,
      status: row.status,
      revision: row.revision,
    }));
  }
}
