import type { Query } from '../api/schemas';
import type { Row } from './types';
// SQL expressions are supplied only by the concrete query functions, never by a request.
export async function list(
  db: D1Database,
  table: string,
  columns: string,
  query: Query,
  search: string[],
  filters: Record<string, string> = {},
) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (query.q) {
    clauses.push(`(${search.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    const term = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    values.push(...search.map(() => term));
  }
  for (const [parameter, column] of Object.entries(filters))
    if (query[parameter] !== undefined) {
      clauses.push(`${column} = ?`);
      values.push(query[parameter]);
    }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const [count, rows] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT count(*) AS total FROM ${table}${where}`).bind(...values),
    db
      .prepare(
        `SELECT ${columns} FROM ${table}${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...values, query.limit, query.offset),
  ]);
  return { items: rows!.results as Row[], total: Number(count!.results[0]!.total) };
}
