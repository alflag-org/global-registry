import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import { ensureJsonObject, parseJsonObject } from '../../domain/models/json';
import type { JsonObject, ProfileVersion, Resource } from '../../domain/models/global-registry';
import { boundedPageLimit } from '../../domain/models/pagination';
import { D1Client } from './client';
import { eventStatements } from './transaction';

export interface CreateProfileInput {
  key: string;
  resourceKind: Resource['kind'];
  resourceKindVersion: number;
  spec: JsonObject;
  actorId: string;
  expectedRevision?: number;
}

export interface ProfileSummary {
  key: string;
  resourceKind: Resource['kind'];
  resourceKindVersion: number;
  version: number;
  status: ProfileVersion['parentStatus'];
  revision: number;
}

export class D1Profiles extends D1Client {
  async createVersion(input: CreateProfileInput): Promise<ProfileVersion> {
    const existing = await this.first<{
      key: string;
      resource_kind: Resource['kind'];
      resource_kind_version: number;
      current_version: number;
      revision: number;
      created_at: string;
    }>('SELECT * FROM profiles WHERE key = ?', input.key);
    const createdAt = new Date().toISOString();
    const spec = ensureJsonObject(input.spec, 'profile spec');
    if (existing === null) {
      const event = eventStatements(this.statement.bind(this), {
        eventType: 'profile.created',
        actorId: input.actorId,
        payload: { key: input.key, version: 1 },
      });
      await this.db.batch([
        this.statement(
          `INSERT INTO profiles (
            key, resource_kind, resource_kind_version, current_version,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, 1, 1, ?, ?)`,
          input.key,
          input.resourceKind,
          input.resourceKindVersion,
          createdAt,
          createdAt,
        ),
        this.statement(
          `INSERT INTO profile_versions (
            profile_key, version, spec_json, created_at, created_by
          ) VALUES (?, 1, ?, ?, ?)`,
          input.key,
          JSON.stringify(spec),
          createdAt,
          input.actorId,
        ),
        ...event,
      ]);
      return {
        key: input.key,
        version: 1,
        resourceKind: input.resourceKind,
        resourceKindVersion: input.resourceKindVersion,
        spec,
        parentStatus: 'active',
        revision: 1,
        createdAt,
      };
    }
    if (input.expectedRevision === undefined) {
      throw new Error('Existing profile persistence requires expectedRevision.');
    }
    const version = existing.current_version + 1;
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'profile.version_created',
        actorId: input.actorId,
        payload: { key: input.key, version, expectedRevision: input.expectedRevision },
      },
      {
        sql: 'EXISTS (SELECT 1 FROM profiles WHERE key = ? AND revision = ? AND updated_at = ?)',
        params: [input.key, input.expectedRevision + 1, createdAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `INSERT INTO profile_versions (
          profile_key, version, spec_json, created_at, created_by
        )
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM profiles WHERE key = ? AND revision = ?)`,
        input.key,
        version,
        JSON.stringify(spec),
        createdAt,
        input.actorId,
        input.key,
        input.expectedRevision,
      ),
      this.statement(
        `UPDATE profiles SET current_version = ?, revision = revision + 1, updated_at = ?
         WHERE key = ? AND revision = ?`,
        version,
        createdAt,
        input.key,
        input.expectedRevision,
      ),
      ...event,
    ]);
    if (results[1]?.meta.changes !== 1) {
      throw new ConflictError('revision_conflict', 'Profile revision is stale.', {
        key: input.key,
        expectedRevision: input.expectedRevision,
      });
    }
    return {
      key: input.key,
      version,
      resourceKind: input.resourceKind,
      resourceKindVersion: input.resourceKindVersion,
      spec,
      parentStatus: 'active',
      revision: input.expectedRevision + 1,
      createdAt,
    };
  }

  async getVersion(key: string, version: number): Promise<ProfileVersion | null> {
    const row = await this.first<{
      key: string;
      resource_kind: Resource['kind'];
      resource_kind_version: number;
      revision: number;
      status: ProfileVersion['parentStatus'];
      spec_json: string;
      created_at: string;
      version: number;
    }>(
      `SELECT p.key, p.resource_kind, p.resource_kind_version, p.revision, p.status,
          pv.spec_json, pv.created_at, pv.version
       FROM profiles p JOIN profile_versions pv ON pv.profile_key = p.key
       WHERE p.key = ? AND pv.version = ?`,
      key,
      version,
    );
    return row === null
      ? null
      : {
          key: row.key,
          version: row.version,
          resourceKind: row.resource_kind,
          resourceKindVersion: row.resource_kind_version,
          spec: parseJsonObject(row.spec_json, 'profile spec'),
          parentStatus: row.status,
          revision: row.revision,
          createdAt: row.created_at,
        };
  }

  async getSummary(key: string): Promise<ProfileSummary | null> {
    const row = await this.first<{
      key: string;
      resource_kind: Resource['kind'];
      resource_kind_version: number;
      current_version: number;
      status: ProfileVersion['parentStatus'];
      revision: number;
    }>(
      `SELECT key, resource_kind, resource_kind_version, current_version, status, revision
       FROM profiles WHERE key = ?`,
      key,
    );
    return row === null
      ? null
      : {
          key: row.key,
          resourceKind: row.resource_kind,
          resourceKindVersion: row.resource_kind_version,
          version: row.current_version,
          status: row.status,
          revision: row.revision,
        };
  }

  async updateStatus(input: {
    key: string;
    status: ProfileVersion['parentStatus'];
    expectedRevision: number;
    actorId: string;
  }): Promise<ProfileSummary> {
    const updatedAt = new Date().toISOString();
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'profile.status_changed',
        actorId: input.actorId,
        payload: { key: input.key, status: input.status },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM profiles WHERE key = ? AND revision = ? AND updated_at = ?
        )`,
        params: [input.key, input.expectedRevision + 1, updatedAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE profiles SET status = ?, revision = revision + 1, updated_at = ?
         WHERE key = ? AND revision = ?`,
        input.status,
        updatedAt,
        input.key,
        input.expectedRevision,
      ),
      ...event,
    ]);
    if (results[0]?.meta.changes !== 1) {
      const current = await this.getSummary(input.key);
      if (current === null) throw new NotFoundError('Profile', input.key);
      throw new ConflictError('revision_conflict', 'Profile revision is stale.', {
        key: input.key,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
      });
    }
    const updated = await this.getSummary(input.key);
    if (updated === null) throw new NotFoundError('Profile', input.key);
    return updated;
  }

  async list(limit?: number): Promise<ProfileSummary[]> {
    const rows = await this.all<{
      key: string;
      resource_kind: Resource['kind'];
      resource_kind_version: number;
      current_version: number;
      status: ProfileVersion['parentStatus'];
      revision: number;
    }>(
      `SELECT key, resource_kind, resource_kind_version, current_version, status, revision
       FROM profiles ORDER BY key LIMIT ?`,
      boundedPageLimit(limit),
    );
    return rows.map((row) => ({
      key: row.key,
      resourceKind: row.resource_kind,
      resourceKindVersion: row.resource_kind_version,
      version: row.current_version,
      status: row.status,
      revision: row.revision,
    }));
  }
}
