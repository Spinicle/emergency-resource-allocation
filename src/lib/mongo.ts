import "server-only";
import { type Db, MongoClient } from "mongodb";
import { insertActivity } from "@db/mongo/activity_log";
import type { ActivityAction, ActivityEntityType, ActivityRefs } from "@/lib/activity";
import type { Session } from "@/lib/auth";
import { requireEnv } from "@/lib/env";

// MongoDB access for Route Handlers (docs/HANDOFF.md 4.5).

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

/**
 * Records what the signed-in user just did in activity_log, timestamped now.
 * Call it after the MySQL write has committed. Never throws: a failed write is
 * logged to the server console and the request carries on.
 *
 *   await logActivity({ actor: session, action: "REQUEST_CREATED",
 *     entity: { type: "REQUEST", id }, refs: { request_id: id, emergency_id } });
 */
export async function logActivity(e: {
  actor: Session;
  action: ActivityAction;
  entity: { type: ActivityEntityType; id: number };
  refs?: ActivityRefs;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await insertActivity(await getDb(), [
      {
        ts: new Date(),
        actor: { user_id: e.actor.userId, name: e.actor.name, role: e.actor.role },
        action: e.action,
        entity: e.entity,
        ...(e.refs && { refs: e.refs }),
        ...(e.payload && { payload: e.payload }),
      },
    ]);
  } catch (err) {
    const { name, message } = err instanceof Error ? err : { name: "Error", message: String(err) };
    console.error(`logActivity(${e.action}) failed:`, { name, message });
  }
}
