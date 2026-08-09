import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  applyMigrations,
  assertDatabaseIntegrity,
  INITIAL_MIGRATION_FILE,
  loadMigrations,
} from './migration-validation';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const initialMigrationPath = path.join(repositoryRoot, 'migrations', INITIAL_MIGRATION_FILE);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'global-registry-migrations-'));

try {
  await verifyIncrementalUpgrade();
  await verifyRejectedFixtures();
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(
  'Migration regression fixtures passed: fresh and existing databases converge after an incremental migration; modified 0001, gaps, invalid names, empty SQL, non-SQL files, and symbolic links are rejected.',
);

async function verifyIncrementalUpgrade(): Promise<void> {
  const directory = await createFixtureDirectory('incremental');
  await writeFile(
    path.join(directory, '0002_add_upgrade_probe.sql'),
    `CREATE TABLE migration_upgrade_probe (
  actor_id TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE RESTRICT,
  value TEXT NOT NULL
);
`,
  );
  const migrations = await loadMigrations(directory);
  assert(migrations.length === 2, 'Incremental fixture did not load both migrations.');

  const fresh = validationDatabase();
  const upgrade = validationDatabase();
  try {
    applyMigrations(fresh, migrations);
    assertDatabaseIntegrity(fresh, 'incremental fresh fixture');

    const initial = migrations[0];
    assert(initial !== undefined, 'Incremental fixture is missing 0001.');
    applyMigrations(upgrade, [initial]);
    upgrade
      .prepare(
        `INSERT INTO actors (
          id, identity, display_name, role, active, revision,
          created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?, ?)`,
      )
      .run(
        'upgrade-actor',
        'access:upgrade-actor',
        'Upgrade Actor',
        '2026-08-10T00:00:00.000Z',
        '2026-08-10T00:00:00.000Z',
        'upgrade-actor',
        'upgrade-actor',
      );
    applyMigrations(upgrade, migrations.slice(1));
    upgrade
      .prepare('INSERT INTO migration_upgrade_probe (actor_id, value) VALUES (?, ?)')
      .run('upgrade-actor', 'preserved');
    assertDatabaseIntegrity(upgrade, 'incremental existing fixture');

    const preserved = upgrade
      .prepare(
        `SELECT actors.identity, migration_upgrade_probe.value
           FROM actors
           JOIN migration_upgrade_probe ON migration_upgrade_probe.actor_id = actors.id
          WHERE actors.id = ?`,
      )
      .get('upgrade-actor');
    assert(
      preserved?.identity === 'access:upgrade-actor' && preserved.value === 'preserved',
      'Incremental migration did not preserve existing data.',
    );
    assert(
      schemaSignature(fresh) === schemaSignature(upgrade),
      'Fresh and upgraded fixture databases did not converge on the same schema.',
    );
  } finally {
    fresh.close();
    upgrade.close();
  }
}

async function verifyRejectedFixtures(): Promise<void> {
  const modifiedInitial = await createFixtureDirectory('modified-initial');
  await writeFile(
    path.join(modifiedInitial, INITIAL_MIGRATION_FILE),
    `${await readFile(initialMigrationPath, 'utf8')}\n-- modified\n`,
  );
  await expectRejected(modifiedInitial, 'is frozen');

  const gap = await createFixtureDirectory('gap');
  await writeFile(path.join(gap, '0003_gap.sql'), 'SELECT 1;\n');
  await expectRejected(gap, 'sequence must be contiguous');

  const invalidName = await createFixtureDirectory('invalid-name');
  await writeFile(path.join(invalidName, '0002-Bad.sql'), 'SELECT 1;\n');
  await expectRejected(invalidName, 'Invalid migration filename');

  const empty = await createFixtureDirectory('empty');
  await writeFile(path.join(empty, '0002_empty.sql'), ' \n');
  await expectRejected(empty, 'must not be empty');

  const nonSql = await createFixtureDirectory('non-sql');
  await writeFile(path.join(nonSql, 'README.md'), 'not a migration\n');
  await expectRejected(nonSql, 'Unexpected non-SQL file');

  const linked = await createFixtureDirectory('linked');
  await symlink(initialMigrationPath, path.join(linked, '0002_linked.sql'));
  await expectRejected(linked, 'must be a regular file');
}

async function createFixtureDirectory(name: string): Promise<string> {
  const directory = path.join(temporaryRoot, name);
  await mkdir(directory);
  await copyFile(initialMigrationPath, path.join(directory, INITIAL_MIGRATION_FILE));
  return directory;
}

async function expectRejected(directory: string, expected: string): Promise<void> {
  try {
    await loadMigrations(directory);
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) return;
    throw error;
  }
  throw new Error(`Expected migration fixture to be rejected with: ${expected}`);
}

function validationDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function schemaSignature(database: DatabaseSync): string {
  return JSON.stringify(
    database
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all(),
  );
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
