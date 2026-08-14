import { readdir } from 'node:fs/promises';
import path from 'node:path';

const migrationFilePattern = /^\d+_[a-z0-9_]+\.sql$/;

export async function loadAcceptedMigrationNames(migrationsDirectory: string): Promise<string[]> {
  const entries = await readdir(path.resolve(migrationsDirectory), { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && migrationFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareMigrationNames);
  if (names.length === 0) {
    throw new Error(`No migration files were found in ${migrationsDirectory}.`);
  }
  return names;
}

export function assertAppliedMigrationsCompatible(
  appliedMigrationNames: readonly string[],
  acceptedMigrationNames: readonly string[],
): void {
  const accepted = new Set(acceptedMigrationNames);
  const unknown = [...new Set(appliedMigrationNames)].filter((name) => !accepted.has(name));
  if (unknown.length === 0) return;
  throw new Error(
    [
      'Remote D1 contains migrations unknown to this Product release:',
      ...unknown.sort(compareMigrationNames).map((name) => `- ${name}`),
      'Deployment stopped before publishing; automatic rollback is not performed.',
    ].join('\n'),
  );
}

export function migrationNamesFromD1Response(output: string): string[] {
  return d1QueryRows(output).flatMap((row) => {
    if (!isRecord(row) || typeof row.name !== 'string') {
      throw new Error('D1 migration query returned a row without a string name.');
    }
    return [row.name];
  });
}

export function d1QueryRows(output: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error('Wrangler returned non-JSON output for the D1 migration query.', {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Wrangler returned an unexpected D1 migration query result.');
  }
  const statements = parsed as unknown[];
  const rows: unknown[] = [];
  for (const statement of statements) {
    if (!isRecord(statement)) throw new Error('D1 query result contains an invalid statement.');
    if (statement.success === false) throw new Error('Wrangler reported a failed D1 query.');
    if (statement.results !== undefined) {
      if (!Array.isArray(statement.results)) {
        throw new Error('D1 query result contains a non-array results field.');
      }
      rows.push(...statement.results);
    }
  }
  return rows;
}

function compareMigrationNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
