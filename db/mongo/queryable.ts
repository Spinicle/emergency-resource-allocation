// The MySQL side a db/mongo module may read or write. No imports, so scripts,
// tests and Route Handlers can all pass their own connection.

/**
 * A mysql2 Pool, Connection or PoolConnection all fit. Open it with
 * dateStrings: true (DATETIME as IST strings; see src/lib/ist.ts) and
 * decimalNumbers: true, like the app pool in src/lib/mysql.ts.
 */
export type Queryable = {
  query(sql: string, values?: unknown): Promise<[unknown, unknown]>;
};

/** Rows of a SELECT through a Queryable. T describes one row; it isn't checked at runtime. */
export async function selectRows<T>(mysql: Queryable, sql: string, values?: unknown[]): Promise<T[]> {
  const [rows] = await mysql.query(sql, values);
  return rows as T[];
}
