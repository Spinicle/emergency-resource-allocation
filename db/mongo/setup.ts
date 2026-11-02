import type { Db } from "mongodb";

/** One MongoDB collection: creates it with its validator and indexes (and seed data, if any). */
export type CollectionModule = {
  name: string;
  setup: (db: Db) => Promise<void>;
};

/**
 * Every collection module, in the order db:reset runs them.
 * activity_log and field_reports (Part 1) and seed_field_reports (Part 2) register here.
 */
const modules: CollectionModule[] = [];

/** Called by scripts/reset-db.ts on a freshly dropped database. */
export async function setupMongo(db: Db): Promise<void> {
  for (const m of modules) {
    await m.setup(db);
  }
}
