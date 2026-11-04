import type { Db } from "mongodb";
import { activityLog } from "./activity_log";
import { fieldReports } from "./field_reports";
import type { Queryable } from "./queryable";

// MongoDB setup for db:reset (docs/HANDOFF.md 4.2, 4.4). No server-only
// imports in db/mongo: scripts, tests and Route Handlers all use these modules.

/** One MongoDB collection: creates it with its validator and indexes (and seed data, if any). */
export type CollectionModule = {
  name: string;
  setup: (db: Db, mysql: Queryable) => Promise<void>;
};

/**
 * Every collection module, in the order db:reset runs them.
 * Part 2 appends seed_field_reports after the Part 1 modules.
 */
const modules: CollectionModule[] = [activityLog, fieldReports];

/**
 * Called by scripts/reset-db.ts on a freshly dropped database, after the
 * MySQL seed. mysql is an era_app connection (the app's own privileges).
 */
export async function setupMongo(db: Db, mysql: Queryable): Promise<void> {
  for (const m of modules) {
    await m.setup(db, mysql);
  }
}
