import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

export const INITIAL_MIGRATION_FILE = '0001_initial.sql';
export const INITIAL_MIGRATION_SHA256 =
  '1d93f8b341e1298e56069fdae892ac3de360ff3a26de285e104100339ddec41f';

const migrationFilePattern = /^(?<sequence>\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export type Migration = Readonly<{
  filename: string;
  sequence: number;
  sql: string;
  sha256: string;
}>;

export async function loadMigrations(directory: URL | string): Promise<readonly Migration[]> {
  const directoryPath =
    directory instanceof URL ? fileURLToPath(directory) : path.resolve(directory);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const filenames: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`Migration entry must be a regular file: ${entry.name}`);
    }
    if (!entry.name.endsWith('.sql')) {
      throw new Error(`Unexpected non-SQL file in migrations directory: ${entry.name}`);
    }
    filenames.push(entry.name);
  }

  filenames.sort();
  if (filenames.length === 0 || filenames[0] !== INITIAL_MIGRATION_FILE) {
    throw new Error(`Migrations must start with frozen ${INITIAL_MIGRATION_FILE}.`);
  }

  const migrations: Migration[] = [];
  for (const [index, filename] of filenames.entries()) {
    const match = migrationFilePattern.exec(filename);
    if (match?.groups?.sequence === undefined) {
      throw new Error(`Invalid migration filename: ${filename}`);
    }
    const sequence = Number.parseInt(match.groups.sequence, 10);
    const expectedSequence = index + 1;
    if (sequence !== expectedSequence) {
      throw new Error(
        `Migration sequence must be contiguous: expected ${String(expectedSequence).padStart(4, '0')}, found ${filename}`,
      );
    }

    const sql = await readFile(path.join(directoryPath, filename), 'utf8');
    if (sql.trim().length === 0) {
      throw new Error(`Migration must not be empty: ${filename}`);
    }
    const sha256 = createHash('sha256').update(sql).digest('hex');
    migrations.push({ filename, sequence, sql, sha256 });
  }

  const initial = migrations[0];
  if (initial?.sha256 !== INITIAL_MIGRATION_SHA256) {
    throw new Error(
      `${INITIAL_MIGRATION_FILE} is frozen at sha256:${INITIAL_MIGRATION_SHA256}; found sha256:${initial?.sha256 ?? 'missing'}. Add a new migration instead of editing 0001.`,
    );
  }

  return migrations;
}

export function applyMigrations(database: DatabaseSync, migrations: readonly Migration[]): void {
  for (const migration of migrations) {
    database.exec(migration.sql);
  }
}

export function assertDatabaseIntegrity(database: DatabaseSync, label: string): void {
  assert(
    database.prepare('PRAGMA quick_check').get()?.quick_check === 'ok',
    `${label}: PRAGMA quick_check failed`,
  );
  assert(
    database.prepare('PRAGMA foreign_key_check').all().length === 0,
    `${label}: PRAGMA foreign_key_check failed`,
  );
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
