export type SqlValue = boolean | number | string | null;

export class D1Client {
  constructor(protected readonly db: D1Database) {}

  statement(sql: string, ...params: SqlValue[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(...params);
  }

  async first<T>(sql: string, ...params: SqlValue[]): Promise<T | null> {
    return this.statement(sql, ...params).first<T>();
  }

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    const result = await this.statement(sql, ...params).all<T>();
    return result.results;
  }
}
