import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { checkTypeScriptContainment } from './check-typescript-containment.mjs';

type SqlRow = Record<string, unknown>;

export const MAX_RAW_SQL_EXPORT_BYTES = 32 * 1024 * 1024;

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
await checkTypeScriptContainment(rootDirectory);
const { validateRegistrySnapshot } = await import('../src/application/registry-validation');
const { PORTABLE_EXPORT_SCHEMA_VERSION } = await import('../src/application/limits');

const rawExportTables = new Set([
  'd1_migrations',
  'actors',
  'providers',
  'profiles',
  'profile_versions',
  'policies',
  'policy_versions',
  'resources',
  'resource_relationships',
  'provider_bindings',
  'provider_binding_history',
  'health',
  'observations',
  'drifts',
  'operations',
  'operation_resources',
  'operation_steps',
  'operation_changes',
  'resource_relationship_history',
  'resource_locks',
  'resource_lock_generations',
  'events',
  'outbox',
  'exports',
]);

const rawExportIndexes = new Set([
  'idx_actors_active_admin',
  'idx_resources_kind',
  'idx_resources_lifecycle',
  'idx_relationships_source',
  'idx_relationships_target',
  'idx_relationship_history_relationship',
  'idx_bindings_provider',
  'idx_observations_resource_expires',
  'idx_observations_retention',
  'idx_drifts_resource_status',
  'idx_drifts_active_fingerprint',
  'idx_providers_status',
  'idx_operations_status',
  'idx_operation_steps_operation',
  'idx_operation_changes_resource',
  'idx_events_resource_occurred',
  'idx_events_operation_occurred',
  'idx_outbox_pending',
  'idx_outbox_stale_dispatch',
  'idx_exports_retention',
]);

const rawExportTriggers = new Set([
  'resource_lock_generations_no_delete',
  'resource_lock_generations_monotonic',
  'actors_insert_metadata_required',
  'actors_canonical_identity_required',
  'actors_canonical_identity_update_required',
  'actors_first_active_admin_required',
  'actors_immutable_fields',
  'actors_update_metadata_required',
  'actors_self_lockout_required',
  'actors_last_active_admin_required',
  'actors_audit_after_insert',
  'actors_audit_after_update',
  'providers_retirement_requires_no_bindings',
  'providers_retirement_is_terminal',
  'profiles_retirement_is_terminal',
  'policies_retirement_is_terminal',
  'resources_key_immutable',
  'resources_no_hard_delete',
  'providers_no_hard_delete',
  'profiles_no_hard_delete',
  'policies_no_hard_delete',
  'actors_no_hard_delete',
  'operations_no_hard_delete',
  'profile_versions_append_only_update',
  'profile_versions_append_only_delete',
  'policy_versions_append_only_update',
  'policy_versions_append_only_delete',
  'provider_binding_history_append_only_update',
  'provider_binding_history_append_only_delete',
  'resource_relationship_history_append_only_update',
  'resource_relationship_history_append_only_delete',
  'operation_plan_immutable',
  'operation_resources_immutable_update',
  'operation_resources_immutable_delete',
  'operation_changes_immutable_update',
  'operation_changes_immutable_delete',
  'operation_steps_plan_immutable',
  'operation_steps_no_delete',
  'events_append_only_update',
  'events_append_only_delete',
]);

const forbiddenSqlTokens = [
  'ATTACH',
  'DETACH',
  'VACUUM',
  'LOAD_EXTENSION',
  'WRITABLE_SCHEMA',
  'ENABLE_LOAD_EXTENSION',
  'CREATE_VIRTUAL',
  'ALTER',
  'DROP',
  'REINDEX',
  'TEMP',
];

const cliArguments = process.argv.slice(2).filter((argument) => argument !== '--');
const options = cliArguments.filter((argument) => argument.startsWith('--'));
const unknownOptions = options.filter((option) => option !== '--inventory-only');
if (unknownOptions.length > 0) {
  throw new Error(`Unsupported option: ${unknownOptions.join(', ')}`);
}
const inputs = cliArguments.filter((argument) => !argument.startsWith('--'));
if (inputs.length !== 1) {
  throw new Error('Pass exactly one D1 SQL export path.');
}
const [input] = inputs;
if (input === undefined || input.length === 0) {
  throw new Error('Pass exactly one D1 SQL export path.');
}
const inventoryOnly = options.includes('--inventory-only');

const sql = await readBoundedSqlExport(input);
const statements = validateRawSqlStatements(sql);
const database = new DatabaseSync(':memory:');
try {
  database.enableLoadExtension(false);
  database.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON;');
  for (const statement of statements) database.exec(statement);
  const inventory = {
    source: input,
    bytes: Buffer.byteLength(sql),
    sha256: createHash('sha256').update(sql).digest('hex'),
    counts: tableCounts(database),
    revisionTotals: revisionTotals(database),
  };
  if (inventoryOnly) {
    console.log(JSON.stringify(inventory, null, 2));
  } else {
    requireColumns(database, {
      actors: ['created_by', 'updated_by'],
      resources: ['spec_overrides_json', 'effective_spec_json'],
      providers: ['status', 'binding_revision'],
      profiles: ['status'],
      policies: ['status'],
      policy_versions: ['resource_kind'],
      resource_relationships: ['revision'],
      drifts: ['fingerprint'],
      outbox: ['consumer_attempts', 'producer_attempts', 'updated_at'],
      exports: ['updated_at', 'attempts', 'lease_until'],
    });
    const snapshot = readSnapshot(database);
    const validation = validateRegistrySnapshot(snapshot);
    console.log(
      JSON.stringify(
        {
          inventory,
          validation,
        },
        null,
        2,
      ),
    );
    if (!validation.valid) process.exitCode = 1;
  }
} finally {
  database.close();
}

async function readBoundedSqlExport(inputPath: string): Promise<string> {
  let before;
  try {
    before = await lstat(inputPath);
  } catch (error) {
    throw new Error(`Cannot inspect SQL export path: ${inputPath}`, { cause: error });
  }
  assertRegularNonSymlink(before, inputPath);
  if (before.size > MAX_RAW_SQL_EXPORT_BYTES) {
    throw new Error(
      `SQL export exceeds the ${MAX_RAW_SQL_EXPORT_BYTES}-byte raw input limit before reading.`,
    );
  }

  let handle;
  try {
    const flags =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    handle = await open(inputPath, flags);
    const opened = await handle.stat();
    assertRegularNonSymlink(opened, inputPath);
    assertSameFile(before, opened, inputPath);

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = MAX_RAW_SQL_EXPORT_BYTES + 1 - total;
      if (remaining <= 0) {
        throw new Error(`SQL export exceeds the ${MAX_RAW_SQL_EXPORT_BYTES}-byte raw input limit.`);
      }
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      chunks.push(chunk);
      total += result.bytesRead;
      if (total > MAX_RAW_SQL_EXPORT_BYTES) {
        throw new Error(`SQL export exceeds the ${MAX_RAW_SQL_EXPORT_BYTES}-byte raw input limit.`);
      }
    }

    const after = await handle.stat();
    assertRegularNonSymlink(after, inputPath);
    assertSameFile(opened, after, inputPath);
    let currentPath;
    try {
      currentPath = await lstat(inputPath);
    } catch (error) {
      throw new Error(`SQL export path changed while it was being read: ${inputPath}`, {
        cause: error,
      });
    }
    assertRegularNonSymlink(currentPath, inputPath);
    assertSameFile(before, currentPath, inputPath);
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SQL export')) throw error;
    throw new Error(`Cannot safely read SQL export path: ${inputPath}`, { cause: error });
  } finally {
    await handle?.close();
  }
}

function assertRegularNonSymlink(
  information: Awaited<ReturnType<typeof lstat>>,
  inputPath: string,
) {
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(`SQL export must be a regular non-symlink file: ${inputPath}`);
  }
}

function assertSameFile(
  expected: Awaited<ReturnType<typeof lstat>>,
  actual: Awaited<ReturnType<typeof lstat>>,
  inputPath: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`SQL export path changed while it was being read: ${inputPath}`);
  }
}

function validateRawSqlStatements(sql: string): string[] {
  if (sql.length === 0 || sql.includes('\u0000')) {
    throw new Error('SQL export is empty or contains a NUL byte.');
  }
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) throw new Error('SQL export contains no SQL statements.');
  for (const statement of statements) validateRawSqlStatement(statement);
  return statements;
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        if (quote === ']' && next === ']') {
          index += 1;
        } else if (next === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '[') {
      quote = ']';
      continue;
    }
    if (character === ';') {
      const statement = sql.slice(start, index).trim();
      const executable = stripLeadingSqlComments(statement);
      if (/^CREATE\s+TRIGGER\s+/i.test(executable) && !/\bEND\s*$/i.test(executable)) {
        continue;
      }
      if (statement.length > 0 && !isOnlySqlComment(statement)) statements.push(statement);
      start = index + 1;
    }
  }
  if (quote !== null || blockComment)
    throw new Error('SQL export contains an unterminated quote or comment.');
  const trailing = sql.slice(start).trim();
  if (trailing.length > 0 && !isOnlySqlComment(trailing)) statements.push(trailing);
  return statements;
}

function isOnlySqlComment(statement: string): boolean {
  return statement.replace(/(?:--[^\r\n]*|\/\*[\s\S]*?\*\/)/g, '').trim().length === 0;
}

function validateRawSqlStatement(statement: string): void {
  const withoutLiterals = sqlWithoutLiteralsAndComments(statement).toUpperCase();
  for (const token of forbiddenSqlTokens) {
    if (new RegExp(`\\b${token}\\b`).test(withoutLiterals)) {
      throw new Error(`SQL export contains a forbidden statement or escape token: ${token}.`);
    }
  }

  const executable = stripLeadingSqlComments(statement);
  if (/^PRAGMA\s+DEFER_FOREIGN_KEYS\s*=\s*(?:TRUE|1)\s*$/i.test(executable)) return;
  if (/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/.test(executable.toUpperCase())) {
    const name = objectName(executable, /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i);
    if (name !== undefined && rawExportTables.has(name)) return;
  }
  if (/^INSERT\s+INTO\s+/.test(executable.toUpperCase())) {
    const name = objectName(executable, /^INSERT\s+INTO\s+/i);
    if (name !== undefined && (rawExportTables.has(name) || name === 'sqlite_sequence')) return;
  }
  if (/^DELETE\s+FROM\s+sqlite_sequence\s*$/i.test(executable)) return;
  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+/.test(executable.toUpperCase())) {
    const name = objectName(executable, /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+/i);
    if (name !== undefined && rawExportIndexes.has(name)) return;
  }
  if (/^CREATE\s+TRIGGER\s+/.test(executable.toUpperCase())) {
    const name = objectName(executable, /^CREATE\s+TRIGGER\s+/i);
    if (name !== undefined && rawExportTriggers.has(name)) return;
  }
  throw new Error(
    `SQL export contains an unsupported or ambiguous statement: ${statement.slice(0, 120)}.`,
  );
}

function stripLeadingSqlComments(statement: string): string {
  let result = statement.trimStart();
  while (true) {
    if (result.startsWith('--')) {
      const lineEnd = result.search(/[\r\n]/);
      result = lineEnd < 0 ? '' : result.slice(lineEnd + 1).trimStart();
      continue;
    }
    if (result.startsWith('/*')) {
      const commentEnd = result.indexOf('*/', 2);
      if (commentEnd < 0) throw new Error('SQL export contains an unterminated comment.');
      result = result.slice(commentEnd + 2).trimStart();
      continue;
    }
    return result;
  }
}

function objectName(statement: string, prefix: RegExp): string | undefined {
  const remainder = statement.replace(prefix, '');
  const match = remainder.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4];
}

function sqlWithoutLiteralsAndComments(statement: string): string {
  return statement
    .replace(/'(?:''|[^'])*'/g, ' ')
    .replace(/"(?:""|[^"])*"/g, ' ')
    .replace(/`(?:``|[^`])*`/g, ' ')
    .replace(/\[(?:\]\]|[^\]])*\]/g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function readSnapshot(database: DatabaseSync): unknown {
  const actorRows = snapshotRows(database, 'SELECT * FROM actors ORDER BY id');
  const providerRows = snapshotRows(database, 'SELECT * FROM providers ORDER BY id');
  const profileRows = snapshotRows(database, 'SELECT * FROM profiles ORDER BY key');
  const profileVersionRows = snapshotRows(
    database,
    'SELECT * FROM profile_versions ORDER BY profile_key, version',
  );
  const policyRows = snapshotRows(database, 'SELECT * FROM policies ORDER BY namespace, key');
  const policyVersionRows = snapshotRows(
    database,
    'SELECT * FROM policy_versions ORDER BY namespace, policy_key, version',
  );
  const resourceRows = snapshotRows(database, 'SELECT * FROM resources ORDER BY key');
  const relationshipRows = snapshotRows(
    database,
    'SELECT * FROM resource_relationships ORDER BY id',
  );
  const relationshipHistoryRows = snapshotRows(
    database,
    'SELECT * FROM resource_relationship_history ORDER BY removed_at, id',
  );
  const bindingRows = snapshotRows(
    database,
    'SELECT * FROM provider_bindings ORDER BY resource_id',
  );
  const bindingHistoryRows = snapshotRows(
    database,
    'SELECT * FROM provider_binding_history ORDER BY unbound_at, id',
  );
  const healthRows = snapshotRows(database, 'SELECT * FROM health ORDER BY resource_id');
  const observationRows = snapshotRows(
    database,
    'SELECT * FROM observations ORDER BY created_at, id',
  );
  const driftRows = snapshotRows(database, 'SELECT * FROM drifts ORDER BY id');
  const operationRows = snapshotRows(database, 'SELECT * FROM operations ORDER BY created_at, id');
  const operationResourceRows = snapshotRows(
    database,
    `SELECT operation_resources.*, resources.key AS resource_key
       FROM operation_resources
       JOIN resources ON resources.id = operation_resources.resource_id
      ORDER BY operation_resources.operation_id, operation_resources.resource_id`,
  );
  const operationStepRows = snapshotRows(
    database,
    'SELECT * FROM operation_steps ORDER BY operation_id, position',
  );
  const operationChangeRows = snapshotRows(
    database,
    'SELECT * FROM operation_changes ORDER BY operation_id, position',
  );
  const lockRows = snapshotRows(database, 'SELECT * FROM resource_locks ORDER BY scope');
  const lockGenerationRows = snapshotRows(
    database,
    'SELECT * FROM resource_lock_generations ORDER BY scope',
  );
  const eventRows = snapshotRows(database, 'SELECT * FROM events ORDER BY occurred_at, event_id');
  const outboxRows = snapshotRows(database, 'SELECT * FROM outbox ORDER BY created_at, id');
  const exportRows = snapshotRows(database, 'SELECT * FROM exports ORDER BY created_at, id');

  return {
    schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
    exportedAt: '1970-01-01T00:00:00.000Z',
    actors: actorRows.map((row) => ({
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
    })),
    providers: providerRows.map((row) => ({
      id: row.id,
      driver: row.driver,
      credentialRef: row.credential_ref,
      status: row.status,
      capabilities: parseJson(
        row.capabilities_json,
        `providers.${String(row.id)}.capabilities_json`,
      ),
      mappings: parseJson(row.mappings_json, `providers.${String(row.id)}.mappings_json`),
      bindingRevision: row.binding_revision,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    profiles: profileRows.map((row) => ({
      key: row.key,
      resourceKind: row.resource_kind,
      status: row.status,
      currentVersion: row.current_version,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    profileVersions: profileVersionRows.map((row) => ({
      profileKey: row.profile_key,
      version: row.version,
      spec: parseJson(row.spec_json, `profileVersions.${String(row.profile_key)}.spec_json`),
      createdAt: row.created_at,
      createdBy: row.created_by,
    })),
    policies: policyRows.map((row) => ({
      namespace: row.namespace,
      key: row.key,
      status: row.status,
      currentVersion: row.current_version,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    policyVersions: policyVersionRows.map((row) => ({
      namespace: row.namespace,
      policyKey: row.policy_key,
      version: row.version,
      resourceKind: row.resource_kind,
      spec: parseJson(row.spec_json, `policyVersions.${String(row.policy_key)}.spec_json`),
      createdAt: row.created_at,
      createdBy: row.created_by,
    })),
    resources: resourceRows.map((row) => ({
      id: row.id,
      key: row.key,
      kind: row.kind,
      name: row.name,
      ...(row.profile_key === null
        ? {}
        : { profile: { key: row.profile_key, version: row.profile_version } }),
      ...(row.policy_namespace === null
        ? {}
        : {
            policy: {
              namespace: row.policy_namespace,
              key: row.policy_key,
              version: row.policy_version,
            },
          }),
      placement: parseJson(row.placement_json, `resources.${String(row.key)}.placement_json`),
      specOverrides: parseJson(
        row.spec_overrides_json,
        `resources.${String(row.key)}.spec_overrides_json`,
      ),
      spec: parseJson(row.effective_spec_json, `resources.${String(row.key)}.effective_spec_json`),
      lifecycleState: row.lifecycle_state,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    relationships: relationshipRows.map((row) => ({
      id: row.id,
      sourceResourceId: row.source_resource_id,
      targetResourceId: row.target_resource_id,
      relationshipType: row.relationship_type,
      revision: row.revision,
      createdAt: row.created_at,
      createdBy: row.created_by,
    })),
    relationshipHistory: relationshipHistoryRows.map((row) => ({
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
    })),
    bindings: bindingRows.map((row) => ({
      resourceId: row.resource_id,
      providerId: row.provider_id,
      providerResourceType: row.provider_resource_type,
      providerResourceId: row.provider_resource_id,
      ...optionalProperty('providerResourceName', row.provider_resource_name),
      locator: parseJson(row.locator_json, `bindings.${String(row.resource_id)}.locator_json`),
      boundAt: row.bound_at,
      boundBy: row.bound_by,
      active: row.active === 1,
    })),
    bindingHistory: bindingHistoryRows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      providerId: row.provider_id,
      providerResourceType: row.provider_resource_type,
      providerResourceId: row.provider_resource_id,
      ...optionalProperty('providerResourceName', row.provider_resource_name),
      locator: parseJson(row.locator_json, `bindingHistory.${String(row.id)}.locator_json`),
      boundAt: row.bound_at,
      unboundAt: row.unbound_at,
      boundBy: row.bound_by,
      unboundBy: row.unbound_by,
      ...optionalProperty('operationId', row.operation_id),
    })),
    health: healthRows.map((row) => ({
      resourceId: row.resource_id,
      status: row.status,
      ...optionalProperty('reason', row.reason),
      observedAt: row.observed_at,
      observedBy: row.observed_by,
      revision: row.revision,
      updatedAt: row.updated_at,
    })),
    observations: observationRows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      observerId: row.observer_id,
      observedAt: row.observed_at,
      facts: parseJson(row.facts_json, `observations.${String(row.id)}.facts_json`),
      expiresAt: row.expires_at,
      ...optionalProperty('archivedAt', row.archived_at),
      ...optionalProperty('r2ObjectKey', row.r2_object_key),
      createdAt: row.created_at,
    })),
    drifts: driftRows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      severity: row.severity,
      status: row.status,
      fingerprint: row.fingerprint,
      expected: parseJson(row.expected_json, `drifts.${String(row.id)}.expected_json`),
      observed: parseJson(row.observed_json, `drifts.${String(row.id)}.observed_json`),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      ...optionalProperty('resolvedAt', row.resolved_at),
    })),
    operations: operationRows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      kind: row.kind,
      status: row.status,
      plan: parseJson(row.plan_json, `operations.${String(row.id)}.plan_json`),
      planHash: row.plan_hash,
      destructive: row.destructive === 1,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    operationResources: operationResourceRows.map((row) => ({
      operationId: row.operation_id,
      resourceId: row.resource_id,
      resourceKey: row.resource_key,
      sourceState: row.source_state,
      targetState: row.target_state,
      resourceRevision: row.resource_revision,
    })),
    operationSteps: operationStepRows.map((row) => ({
      id: row.id,
      operationId: row.operation_id,
      position: row.position,
      name: row.name,
      status: row.status,
      gate: parseJson(row.gate_json, `operationSteps.${String(row.id)}.gate_json`),
      evidence: parseJson(row.evidence_json, `operationSteps.${String(row.id)}.evidence_json`),
      revision: row.revision,
      ...optionalProperty('startedAt', row.started_at),
      ...optionalProperty('completedAt', row.completed_at),
      updatedAt: row.updated_at,
    })),
    operationChanges: operationChangeRows.map((row) => ({
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
    })),
    locks: lockRows.map((row) => ({
      scope: row.scope,
      operationId: row.operation_id,
      actorId: row.actor_id,
      fencingToken: row.fencing_token,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    lockGenerations: lockGenerationRows.map((row) => ({
      scope: row.scope,
      generation: row.generation,
    })),
    events: eventRows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      ...optionalProperty('resourceKey', row.resource_key),
      ...optionalProperty('operationId', row.operation_id),
      actorId: row.actor_id,
      payload: parseJson(row.payload_json, `events.${String(row.event_id)}.payload_json`),
      occurredAt: row.occurred_at,
    })),
    outbox: outboxRows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      topic: row.topic,
      payload: parseJson(row.payload_json, `outbox.${String(row.id)}.payload_json`),
      status: row.status,
      consumerAttempts: row.consumer_attempts,
      producerAttempts: row.producer_attempts,
      createdAt: row.created_at,
      ...optionalProperty('publishedAt', row.published_at),
      ...optionalProperty('lastError', row.last_error),
      revision: row.revision,
      updatedAt: row.updated_at,
    })),
    exports: exportRows.map((row) => ({
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
    })),
  };
}

function tableCounts(database: DatabaseSync): Record<string, number> {
  const tables = [
    'actors',
    'providers',
    'profiles',
    'profile_versions',
    'policies',
    'policy_versions',
    'resources',
    'resource_relationships',
    'resource_relationship_history',
    'provider_bindings',
    'provider_binding_history',
    'health',
    'observations',
    'drifts',
    'operations',
    'operation_resources',
    'operation_steps',
    'operation_changes',
    'resource_locks',
    'resource_lock_generations',
    'events',
    'outbox',
    'exports',
  ];
  return Object.fromEntries(
    tables
      .filter((table) => tableExists(database, table))
      .map((table) => [table, scalar(database, `SELECT COUNT(*) AS value FROM ${table}`)]),
  );
}

function revisionTotals(database: DatabaseSync): Record<string, number> {
  const tables = [
    'actors',
    'providers',
    'profiles',
    'policies',
    'resources',
    'resource_relationships',
    'provider_bindings',
    'health',
    'drifts',
    'operations',
    'operation_steps',
    'outbox',
    'exports',
  ];
  return Object.fromEntries(
    tables
      .filter((table) => tableExists(database, table) && hasColumn(database, table, 'revision'))
      .map((table) => [
        table,
        scalar(database, `SELECT COALESCE(SUM(revision), 0) AS value FROM ${table}`),
      ]),
  );
}

function requireColumns(database: DatabaseSync, expected: Record<string, string[]>): void {
  for (const [table, required] of Object.entries(expected)) {
    const present = new Set(
      rows(database, `PRAGMA table_info(${table})`).map((row) => String(row.name)),
    );
    const missing = required.filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new Error(
        `Export does not contain the current migrated schema: ${table}.${missing.join(', ')}`,
      );
    }
  }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  );
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return rows(database, `PRAGMA table_info(${table})`).some((row) => row.name === column);
}

function rows(database: DatabaseSync, sql: string): SqlRow[] {
  return database.prepare(sql).all() as SqlRow[];
}

function snapshotRows(database: DatabaseSync, sql: string): SqlRow[] {
  return rows(database, sql);
}

function scalar(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as SqlRow | undefined;
  const value = row?.value;
  if (typeof value !== 'number') throw new Error(`Expected numeric SQL result for: ${sql}`);
  return value;
}

function optionalProperty<T>(key: string, value: T | null): Record<string, T> {
  return value === null ? {} : { [key]: value };
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') throw new Error(`${field} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} is not valid JSON.`);
  }
}
