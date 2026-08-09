import { ConflictError, NotFoundError } from '../../domain/errors/global-registry-error';
import type {
  ResourceKindDefinitionVersion,
  VersionParentStatus,
} from '../../domain/models/global-registry';
import { boundedPageLimit } from '../../domain/models/pagination';
import { resourceKindDefinitionVersionRecordSchema } from '../../domain/models/schemas';
import type { PersistResourceKindDefinitionInput } from '../../application/resource-kind-definitions';
import type { ResourceKindDefinitionSummary } from '../../application/resource-kind-definitions';
import { D1Client } from './client';
import { eventStatements } from './transaction';

interface DefinitionRow {
  key: string;
  version: number;
  states_json: string;
  initial_state: string;
  terminal_states_json: string;
  transitions_json: string;
  placement_mode: ResourceKindDefinitionVersion['placementMode'];
  specification_mode: ResourceKindDefinitionVersion['specificationMode'];
  relationship_rules_json: string;
  status: VersionParentStatus;
  revision: number;
  created_at: string;
  created_by: string | null;
}

export class D1ResourceKindDefinitions extends D1Client {
  async get(key: string, version: number): Promise<ResourceKindDefinitionVersion | null> {
    const row = await this.first<DefinitionRow>(
      `SELECT parent.key, version.version, version.states_json, version.initial_state,
          version.terminal_states_json, version.transitions_json, version.placement_mode,
          version.specification_mode, version.relationship_rules_json, parent.status,
          parent.revision, version.created_at, version.created_by
       FROM resource_kind_definitions parent
       JOIN resource_kind_definition_versions version ON version.kind_key = parent.key
       WHERE parent.key = ? AND version.version = ?`,
      key,
      version,
    );
    return row === null ? null : mapDefinition(row);
  }

  async getSummary(key: string): Promise<ResourceKindDefinitionSummary | null> {
    const row = await this.first<{
      key: string;
      current_version: number;
      status: VersionParentStatus;
      revision: number;
    }>(
      'SELECT key, current_version, status, revision FROM resource_kind_definitions WHERE key = ?',
      key,
    );
    return row === null
      ? null
      : {
          key: row.key,
          version: row.current_version,
          status: row.status,
          revision: row.revision,
        };
  }

  async list(limit?: number): Promise<ResourceKindDefinitionSummary[]> {
    const rows = await this.all<{
      key: string;
      current_version: number;
      status: VersionParentStatus;
      revision: number;
    }>(
      `SELECT key, current_version, status, revision
       FROM resource_kind_definitions ORDER BY key LIMIT ?`,
      boundedPageLimit(limit),
    );
    return rows.map((row) => ({
      key: row.key,
      version: row.current_version,
      status: row.status,
      revision: row.revision,
    }));
  }

  async createVersion(
    input: PersistResourceKindDefinitionInput,
  ): Promise<ResourceKindDefinitionVersion> {
    const existing = await this.getSummary(input.key);
    const createdAt = new Date().toISOString();
    const version = existing === null ? 1 : existing.version + 1;
    const revision = existing === null ? 1 : (input.expectedRevision as number) + 1;
    const eventType =
      existing === null
        ? 'resource_kind_definition.created'
        : 'resource_kind_definition.version_created';
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType,
        actorId: input.actorId,
        payload: {
          key: input.key,
          version,
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: input.expectedRevision }),
        },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM resource_kind_definitions
          WHERE key = ? AND revision = ? AND updated_at = ?
        )`,
        params: [input.key, revision, createdAt],
      },
    );
    const parentStatement =
      existing === null
        ? this.statement(
            `INSERT INTO resource_kind_definitions (
              key, status, current_version, revision, created_at, updated_at
            ) VALUES (?, 'active', 1, 1, ?, ?)`,
            input.key,
            createdAt,
            createdAt,
          )
        : this.statement(
            `UPDATE resource_kind_definitions
             SET current_version = ?, revision = revision + 1, updated_at = ?
             WHERE key = ? AND revision = ? AND status = 'active'`,
            version,
            createdAt,
            input.key,
            input.expectedRevision as number,
          );
    const results = await this.db.batch([
      parentStatement,
      this.statement(
        `INSERT INTO resource_kind_definition_versions (
          kind_key, version, states_json, initial_state, terminal_states_json,
          transitions_json, placement_mode, specification_mode,
          relationship_rules_json, created_at, created_by
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM resource_kind_definitions
          WHERE key = ? AND current_version = ? AND revision = ?
        )`,
        input.key,
        version,
        JSON.stringify(input.states),
        input.initialState,
        JSON.stringify(input.terminalStates),
        JSON.stringify(input.transitions),
        input.placementMode,
        input.specificationMode,
        JSON.stringify(input.relationshipRules),
        createdAt,
        input.actorId,
        input.key,
        version,
        revision,
      ),
      ...event,
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new ConflictError('revision_conflict', 'Resource kind definition revision is stale.', {
        key: input.key,
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
      });
    }
    const created = await this.get(input.key, version);
    if (created === null) throw new NotFoundError('Resource kind definition', input.key);
    return created;
  }

  async updateStatus(input: {
    key: string;
    status: VersionParentStatus;
    expectedRevision: number;
    actorId: string;
  }): Promise<ResourceKindDefinitionSummary> {
    const updatedAt = new Date().toISOString();
    const event = eventStatements(
      this.statement.bind(this),
      {
        eventType: 'resource_kind_definition.status_changed',
        actorId: input.actorId,
        payload: { key: input.key, status: input.status },
      },
      {
        sql: `EXISTS (
          SELECT 1 FROM resource_kind_definitions
          WHERE key = ? AND revision = ? AND updated_at = ?
        )`,
        params: [input.key, input.expectedRevision + 1, updatedAt],
      },
    );
    const results = await this.db.batch([
      this.statement(
        `UPDATE resource_kind_definitions
         SET status = ?, revision = revision + 1, updated_at = ?
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
      if (current === null) throw new NotFoundError('Resource kind definition', input.key);
      throw new ConflictError('revision_conflict', 'Resource kind definition revision is stale.', {
        key: input.key,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
      });
    }
    const updated = await this.getSummary(input.key);
    if (updated === null) throw new NotFoundError('Resource kind definition', input.key);
    return updated;
  }
}

function mapDefinition(row: DefinitionRow): ResourceKindDefinitionVersion {
  const parsed = resourceKindDefinitionVersionRecordSchema.safeParse({
    key: row.key,
    version: row.version,
    states: JSON.parse(row.states_json) as unknown,
    initialState: row.initial_state,
    terminalStates: JSON.parse(row.terminal_states_json) as unknown,
    transitions: JSON.parse(row.transitions_json) as unknown,
    placementMode: row.placement_mode,
    specificationMode: row.specification_mode,
    relationshipRules: JSON.parse(row.relationship_rules_json) as unknown,
    parentStatus: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    ...(row.created_by === null ? {} : { createdBy: row.created_by }),
  });
  if (!parsed.success) throw new Error(`Stored Resource kind definition ${row.key} is invalid.`);
  const definition = parsed.data;
  return {
    key: definition.key,
    version: definition.version,
    states: definition.states,
    initialState: definition.initialState,
    terminalStates: definition.terminalStates,
    transitions: definition.transitions,
    placementMode: definition.placementMode,
    specificationMode: definition.specificationMode,
    relationshipRules: definition.relationshipRules,
    parentStatus: definition.parentStatus,
    revision: definition.revision,
    createdAt: definition.createdAt,
    ...(definition.createdBy === undefined ? {} : { createdBy: definition.createdBy }),
  };
}
