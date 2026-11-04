import type { Db } from "mongodb";
import { activityLog } from "./activity_log";

// MongoDB setup for db:reset (docs/HANDOFF.md 4.2, 4.4). No server-only
// imports in db/mongo: scripts, tests and Route Handlers all use these modules.

/**
 * The MySQL side a module may read or write: a mysql2 Pool, Connection or
 * PoolConnection all fit. It must be opened with dateStrings: true (DATETIME
 * as IST strings; see src/lib/ist.ts) and decimalNumbers: true.
 */
export type Queryable = {
  query(sql: string, values?: unknown): Promise<[unknown, unknown]>;
};

/** Rows of a SELECT through a Queryable. T describes one row; it isn't checked at runtime. */
export async function selectRows<T>(mysql: Queryable, sql: string, values?: unknown[]): Promise<T[]> {
  const [rows] = await mysql.query(sql, values);
  return rows as T[];
}

/** One MongoDB collection: creates it with its validator and indexes (and seed data, if any). */
export type CollectionModule = {
  name: string;
  setup: (db: Db, mysql: Queryable) => Promise<void>;
};

/**
 * Every collection module, in the order db:reset runs them.
 * Part 2 appends seed_field_reports after the Part 1 modules.
 */
const modules: CollectionModule[] = [activityLog];

/**
 * Called by scripts/reset-db.ts on a freshly dropped database, after the
 * MySQL seed. mysql is an era_app connection (the app's own privileges).
 */
export async function setupMongo(db: Db, mysql: Queryable): Promise<void> {
  for (const m of modules) {
    await m.setup(db, mysql);
  }
}
