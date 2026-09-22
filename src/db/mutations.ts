import { conflict, databaseError, missing } from '../api/errors';
import type { Row, Table } from './types';
export function snapshot(
  columns: readonly string[],
  overrides: Record<string, string> = {},
): string {
  return `json_object(${columns.flatMap((column) => [`'${column}'`, overrides[column] ?? column]).join(',')})`;
}
export function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  table: Table,
  columns: readonly string[],
  where: string,
  bindings: unknown[],
  after: string,
  auditId = crypto.randomUUID(),
  afterBindings: unknown[] = [],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id,actor,action,entity_type,entity_id,before_json,after_json,created_at) SELECT (? || ':' || id),?,?,?,id,${action === 'create' || action === 'allocate' ? 'NULL' : snapshot(columns)},${after},? FROM ${table} WHERE ${where}`,
    )
    .bind(auditId, actor, action, table, ...afterBindings, new Date().toISOString(), ...bindings);
}
export async function batch(db: D1Database, statements: D1PreparedStatement[]) {
  try {
    return await db.batch(statements);
  } catch (error) {
    databaseError(error);
  }
}
export async function required(db: D1Database, sql: string, id: string): Promise<Row> {
  const row = await db.prepare(sql).bind(id).first<Row>();
  if (!row) throw missing();
  return row;
}
export function unchanged(row: Row, columns: readonly string[]) {
  return { sql: columns.map((c) => `${c} IS ?`).join(' AND '), values: columns.map((c) => row[c]) };
}
export function assertChanged(changes: number) {
  if (!changes)
    throw conflict('The entity or its relationships changed concurrently. Reload and retry.');
}
