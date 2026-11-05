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

/** One thing the signed-in user did, for logActivity / logActivities. */
export type ActivityInput = {
  action: ActivityAction;
  entity: { type: ActivityEntityType; id: number };
  refs?: ActivityRefs;
  payload?: Record<string, unknown>;
};

/**
 * Records what the signed-in user just did in activity_log, timestamped now.
 * Call it after the MySQL write has committed. Never throws: a failed write is
 * logged to the server console and the request carries on.
 *
 *   await logActivity({ actor: session, action: "REQUEST_CREATED",
 *     entity: { type: "REQUEST", id }, refs: { request_id: id, emergency_id } });
 */
export async function logActivity({ actor, ...entry }: ActivityInput & { actor: Session }): Promise<void> {
  await logActivities(actor, [entry]);
}

/**
 * Several entries from one request (a split's allocations), in one ordered
 * insert, so an unreachable MongoDB costs one server-selection wait, not one
 * per entry. Entry i is timestamped now + i ms, so a feed sorted by ts shows
 * them in this order. Never throws, like logActivity.
 */
export async function logActivities(actor: Session, entries: ActivityInput[]): Promise<void> {
  if (entries.length === 0) return;
  const base = Date.now();
  const who = { user_id: actor.userId, name: actor.name, role: actor.role };
  try {
    await insertActivity(
      await getDb(),
      entries.map((e, i) => ({
        ts: new Date(base + i),
        actor: who,
        action: e.action,
        entity: e.entity,
        ...(e.refs && { refs: e.refs }),
        ...(e.payload && { payload: e.payload }),
      })),
    );
  } catch (err) {
    const { name, message } = err instanceof Error ? err : { name: "Error", message: String(err) };
    const actions = [...new Set(entries.map((e) => e.action))].join(", ");
    console.error(`logActivities(${actions}) failed (${entries.length} entries):`, { name, message });
  }
}
