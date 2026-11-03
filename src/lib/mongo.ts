import "server-only";
import { type Db, MongoClient } from "mongodb";
import { requireEnv } from "@/lib/env";

// MongoDB access for Route Handlers (docs/HANDOFF.md 4.5). logActivity() arrives in P1.7.

const cache = globalThis as typeof globalThis & { __erasMongoClient?: Promise<MongoClient> };

/**
 * The app's MongoDB database. One client per server process, kept on
 * globalThis so dev hot reload doesn't open new ones. A failed connect isn't
 * cached, so the next call tries again.
 */
export async function getDb(): Promise<Db> {
  cache.__erasMongoClient ??= new MongoClient(requireEnv("MONGODB_URI"), {
    serverSelectionTimeoutMS: 5000,
  })
    .connect()
    .catch((err: unknown) => {
      cache.__erasMongoClient = undefined;
      throw err;
    });
  const client = await cache.__erasMongoClient;
  return client.db(requireEnv("MONGODB_DB"));
}
