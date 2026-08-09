import { DatabaseSync } from 'node:sqlite';
import { checkTypeScriptContainment } from './check-typescript-containment.mjs';
import {
  applyMigrations,
  assertDatabaseIntegrity,
  INITIAL_MIGRATION_FILE,
  loadMigrations,
  type Migration,
} from './migration-validation';

await checkTypeScriptContainment();

const migrations = await loadMigrations(new URL('../migrations/', import.meta.url));
const initialMigration = migrations[0];
assert(initialMigration !== undefined, `Missing ${INITIAL_MIGRATION_FILE}.`);
const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys = ON');
let latestSchemaSignature: string | undefined;
let triggerCount: number;
try {
  applyMigrations(database, migrations);
  assertDatabaseIntegrity(database, 'fresh database');

  const expectedTables = [
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
  ];
  const actualTables = rows(
    database,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map((row) => String(row.name));
  assert(
    JSON.stringify(actualTables) === JSON.stringify([...expectedTables].sort()),
    'Schema inventory changed.',
  );
  const exportColumns = rows(database, 'PRAGMA table_info(exports)').map((row) => String(row.name));
  for (const column of ['claim_token', 'claim_object_key', 'r2_claim_token']) {
    assert(exportColumns.includes(column), `Missing fenced export column ${column}.`);
  }

  const expectedTriggers = [
    'resource_lock_generations_no_delete',
    'resource_lock_generations_monotonic',
    'actors_canonical_identity_required',
    'actors_canonical_identity_update_required',
    'actors_first_active_admin_required',
    'actors_last_active_admin_required',
    'actors_self_lockout_required',
    'actors_audit_after_insert',
    'actors_audit_after_update',
    'resources_no_hard_delete',
    'operations_no_hard_delete',
    'operation_plan_immutable',
    'operation_changes_immutable_update',
    'operation_steps_plan_immutable',
    'events_append_only_delete',
  ];
  const actualTriggers = rows(
    database,
    `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
  ).map((row) => String(row.name));
  triggerCount = actualTriggers.length;
  assert(actualTables.length === 23, `Expected 23 tables, found ${actualTables.length}.`);
  assert(actualTriggers.length === 40, `Expected 40 triggers, found ${actualTriggers.length}.`);
  assert(
    countMigrationCommands(initialMigration.sql) === 83,
    `Expected 83 commands in frozen ${INITIAL_MIGRATION_FILE}, found ${countMigrationCommands(initialMigration.sql)}.`,
  );
  for (const trigger of expectedTriggers)
    assert(actualTriggers.includes(trigger), `Missing trigger ${trigger}.`);
  assert(
    !actualTables.includes('schema_migrations'),
    'The application schema must not duplicate D1 migration state.',
  );

  const timestamp = '2026-08-05T00:00:00.000Z';
  insertActor(database, 'actor-1', 'access:actor-1', 'admin', 'actor-1', timestamp);
  expectFailure(
    () =>
      insertActor(
        database,
        'actor-bad',
        'email:actor@example.test',
        'readonly',
        'actor-1',
        timestamp,
      ),
    'actor_identity_not_canonical',
  );
  expectFailure(
    () =>
      insertActor(database, 'actor-bad-2', 'access: trailing', 'readonly', 'actor-1', timestamp),
    'actor_identity_not_canonical',
  );

  insertActor(database, 'actor-2', 'service:actor-2', 'admin', 'actor-1', timestamp);
  insertActor(database, 'actor-boundary-access', 'access:a', 'readonly', 'actor-1', timestamp);
  insertActor(database, 'actor-boundary-service', 'service:a', 'readonly', 'actor-1', timestamp);
  for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    const control = String.fromCodePoint(codePoint);
    const actorId = `actor-insert-control-${codePoint}`;
    expectFailure(
      () =>
        insertActor(
          database,
          actorId,
          `access:control${control}value`,
          'readonly',
          'actor-1',
          timestamp,
        ),
      'actor_identity_not_canonical',
    );

    const updateActorId = `actor-update-control-${codePoint}`;
    insertActor(
      database,
      updateActorId,
      `service:valid-${codePoint}`,
      'readonly',
      'actor-1',
      timestamp,
    );
    expectFailure(
      () =>
        database
          .prepare(
            `UPDATE actors SET identity = ?, revision = revision + 1, updated_at = ?, updated_by = ?
             WHERE id = ? AND revision = 1`,
          )
          .run(`access:control${control}value`, timestamp, 'actor-1', updateActorId),
      'actor_identity_not_canonical',
    );
  }
  database
    .prepare(
      `UPDATE actors SET active = 0, revision = revision + 1, updated_at = ?, updated_by = ?
     WHERE id = ? AND revision = 1`,
    )
    .run('2026-08-05T00:01:00.000Z', 'actor-1', 'actor-1');
  expectFailure(
    () =>
      database
        .prepare(
          `UPDATE actors SET active = 0, revision = revision + 1, updated_at = ?, updated_by = ?
         WHERE id = ? AND revision = 1`,
        )
        .run('2026-08-05T00:02:00.000Z', 'actor-1', 'actor-2'),
    'actor_last_active_admin_required',
  );
  expectFailure(
    () =>
      database
        .prepare(
          `UPDATE actors SET role = 'readonly', revision = revision + 1, updated_at = ?, updated_by = ?
         WHERE id = ? AND revision = 1`,
        )
        .run('2026-08-05T00:03:00.000Z', 'actor-2', 'actor-2'),
    'actor_self_lockout_required',
  );

  database.exec(`
    CREATE TRIGGER reject_actor_audit
    BEFORE INSERT ON outbox
    WHEN NEW.topic = 'global-registry.actor.updated'
    BEGIN SELECT RAISE(ABORT, 'audit_failure'); END;
  `);
  expectFailure(
    () =>
      database
        .prepare(
          `UPDATE actors SET display_name = ?, revision = revision + 1, updated_at = ?, updated_by = ?
         WHERE id = ? AND revision = 1`,
        )
        .run('Rolled back', '2026-08-05T00:04:00.000Z', 'actor-1', 'actor-2'),
    'audit_failure',
  );
  database.exec('DROP TRIGGER reject_actor_audit');
  assert(
    database.prepare(`SELECT display_name FROM actors WHERE id = 'actor-2'`).get()?.display_name ===
      'A',
    'Actor audit failure did not roll back state.',
  );

  expectFailure(
    () =>
      database
        .prepare(
          `INSERT INTO providers (id, driver, credential_ref, capabilities_json, mappings_json, created_at, updated_at) VALUES ('provider-1', 'aws', 'secret-value', '{}', '{}', ?, ?)`,
        )
        .run(timestamp, timestamp),
    'CHECK constraint failed',
  );
  expectFailure(
    () =>
      database
        .prepare(
          `INSERT INTO providers (id, driver, credential_ref, capabilities_json, mappings_json, created_at, updated_at) VALUES ('provider-1', 'aws', 'AWS_TOKEN', '[]', '{}', ?, ?)`,
        )
        .run(timestamp, timestamp),
    'CHECK constraint failed',
  );
  expectFailure(
    () =>
      database
        .prepare(
          `INSERT INTO exports (id, schema_version, status, created_at, requested_by, updated_at)
           VALUES ('export-invalid-running', '1.1', 'running', ?, 'actor-1', ?)`,
        )
        .run(timestamp, timestamp),
    'CHECK constraint failed',
  );
  database
    .prepare(
      `INSERT INTO exports (
        id, schema_version, status, revision, created_at, requested_by, updated_at,
        claim_token, claim_object_key
      ) VALUES ('export-running', '1.1', 'running', 2, ?, 'actor-1', ?, 'claim-a', 'exports/export-running/2-claim-a.json')`,
    )
    .run(timestamp, timestamp);
  expectFailure(
    () =>
      database
        .prepare(
          `UPDATE exports
              SET status = 'succeeded', r2_object_key = 'exports/export-running/2-claim-a.json'
            WHERE id = 'export-running'`,
        )
        .run(),
    'CHECK constraint failed',
  );
  database
    .prepare(
      `UPDATE exports
          SET status = 'succeeded', checksum = 'sha256:${'0'.repeat(64)}',
              r2_object_key = 'exports/export-running/2-claim-a.json', r2_claim_token = 'claim-a',
              claim_token = NULL, claim_object_key = NULL, completed_at = ?, updated_at = ?
        WHERE id = 'export-running'`,
    )
    .run(timestamp, timestamp);
  latestSchemaSignature = schemaSignature(database);
} finally {
  database.close();
}

assert(latestSchemaSignature !== undefined, 'Fresh database schema signature was not captured.');
verifyUpgradePath(migrations, latestSchemaSignature);

console.log(
  JSON.stringify(
    {
      migrations: migrations.map((migration) => migration.filename),
      frozenInitialSha256: initialMigration.sha256,
      upgradeMigrations: migrations.length - 1,
      tables: 23,
      triggers: triggerCount,
      freshDatabase: 'ok',
      existingDatabaseUpgrade: 'ok',
      foreignKeyCheck: 'ok',
    },
    null,
    2,
  ),
);

function insertActor(
  database: DatabaseSync,
  id: string,
  identity: string,
  role: string,
  actorId: string,
  timestamp: string,
): void {
  database
    .prepare(
      `INSERT INTO actors (id, identity, display_name, role, active, revision, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, 'A', ?, 1, 1, ?, ?, ?, ?)`,
    )
    .run(id, identity, role, timestamp, timestamp, actorId, actorId);
}

function rows(database: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return database.prepare(sql).all() as Array<Record<string, unknown>>;
}

function verifyUpgradePath(
  migrations: readonly Migration[],
  expectedSchemaSignature: string,
): void {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  try {
    const initial = migrations[0];
    assert(initial !== undefined, `Missing ${INITIAL_MIGRATION_FILE}.`);
    applyMigrations(database, [initial]);

    const timestamp = '2026-08-05T00:00:00.000Z';
    insertActor(
      database,
      'migration-upgrade-sentinel',
      'access:migration-upgrade-sentinel',
      'admin',
      'migration-upgrade-sentinel',
      timestamp,
    );

    applyMigrations(database, migrations.slice(1));
    assertDatabaseIntegrity(database, 'existing database upgrade');
    assert(
      schemaSignature(database) === expectedSchemaSignature,
      'Existing database upgrade did not produce the same schema as a fresh database.',
    );
    const sentinel = database
      .prepare('SELECT identity, role, active FROM actors WHERE id = ?')
      .get('migration-upgrade-sentinel');
    assert(
      sentinel?.identity === 'access:migration-upgrade-sentinel' &&
        sentinel.role === 'admin' &&
        sentinel.active === 1,
      'Existing data was not preserved across incremental migrations.',
    );
  } finally {
    database.close();
  }
}

function schemaSignature(database: DatabaseSync): string {
  return JSON.stringify(
    rows(
      database,
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    ),
  );
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function countMigrationCommands(source: string): number {
  return (source.match(/^CREATE (?:TABLE|(?:UNIQUE )?INDEX|TRIGGER)\b/gm) ?? []).length;
}

function expectFailure(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`Expected failure containing: ${message}`);
}
