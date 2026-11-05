import "server-only";
import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { requireEnv } from "@/lib/env";

/*
 * MySQL access for Route Handlers (docs/HANDOFF.md 4.5), as the app user
 * (MYSQL_USER), never the admin account.
 *
 * - DECIMAL columns come back as numbers (decimalNumbers) and DATETIME / DATE
 *   as IST wall-clock strings (dateStrings). Never SET time_zone (HANDOFF 8).
 * - Every helper uses pool.query: client-side escaping, so `IN (?)` expands an
 *   array. (mysql2's prepared execute() does not.)
 * - Never set @ledger_*, @item_alloc_sync or any other session variable the
 *   procedures and triggers use. Connections are pooled and reused.
 * - Call sp_allocate in autocommit or as the first statement of a
 *   withTransaction, one item per transaction (HANDOFF 4.4).
 */

const cache = globalThis as typeof globalThis & { __erasMysqlPool?: Pool };

/**
 * One pool per server process; kept on globalThis so dev hot reload doesn't
 * leak pools. Created on first use. Exported for the shared db/mongo modules
 * that take a Queryable (fileFieldReport); Route Handlers use the helpers below.
 */
export function getPool(): Pool {
  cache.__erasMysqlPool ??= mysql.createPool({
    host: requireEnv("MYSQL_HOST"),
    port: Number(requireEnv("MYSQL_PORT")),
    user: requireEnv("MYSQL_USER"),
    password: requireEnv("MYSQL_PASSWORD"),
    database: requireEnv("MYSQL_DATABASE"),
    connectionLimit: 10,
    decimalNumbers: true,
    dateStrings: true,
  });
  return cache.__erasMysqlPool;
}

/** Rows of a SELECT. T describes one row; it isn't checked at runtime. */
export async function query<T = RowDataPacket>(sql: string, params?: unknown[]): Promise<T[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(sql, params);
  return rows as T[];
}

/** The first row of a SELECT, or null. */
export async function queryOne<T = RowDataPacket>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * The first result set of a CALL to a procedure that SELECTs (sp_suggest_batches).
 * query() would return every result set plus the CALL's own status.
 */
export async function callRows<T = RowDataPacket>(sql: string, params?: unknown[]): Promise<T[]> {
  const [sets] = await getPool().query<RowDataPacket[][]>(sql, params);
  return (sets[0] ?? []) as T[];
}

/** An INSERT / UPDATE / DELETE: affectedRows, insertId, … */
export async function execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
  const [result] = await getPool().query<ResultSetHeader>(sql, params);
  return result;
}

/**
 * Runs fn on one connection inside a transaction: commits if it resolves,
 * rolls back if it throws (and rethrows), and always gives the connection
 * back. A connection whose rollback failed is destroyed, not reused.
 */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  let reusable = true;
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      reusable = false;
      console.error("withTransaction: rollback failed:", (rollbackErr as Error).message);
    }
    throw err;
  } finally {
    if (reusable) conn.release();
    else conn.destroy();
  }
}
