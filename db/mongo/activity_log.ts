import type { Db } from "mongodb";
import { ACTIVITY_ACTIONS, ACTIVITY_ENTITY_TYPES, type ActivityEntry } from "../../src/lib/activity";
import { ROLES } from "../../src/lib/enums";
import type { CollectionModule } from "./setup";

// activity_log (docs/HANDOFF.md 4.4): who did what, append-only. Only
// insertActivity writes to it, and nothing updates or deletes entries.

export const ACTIVITY_LOG = "activity_log";

const intRef = { bsonType: "int" } as const;

/** The validator. Its enums are the lists in src/lib/activity.ts and enums.ts. */
export const activityLogSchema = {
  bsonType: "object",
  required: ["ts", "actor", "action", "entity"],
  properties: {
    ts: { bsonType: "date" },
    actor: {
      bsonType: "object",
      required: ["user_id", "name", "role"],
      properties: {
        user_id: { bsonType: ["int", "null"] },
        name: { bsonType: "string", minLength: 1 },
        role: { enum: [...ROLES, null] },
      },
    },
    action: { enum: [...ACTIVITY_ACTIONS] },
    entity: {
      bsonType: "object",
      required: ["type", "id"],
      properties: {
        type: { enum: [...ACTIVITY_ENTITY_TYPES] },
        id: { bsonType: "int" },
      },
    },
    refs: {
      bsonType: "object",
      properties: { request_id: intRef, emergency_id: intRef, center_id: intRef },
    },
    payload: { bsonType: "object" },
  },
};

/** Writes entries, in order. The only writer of activity_log. Throws on failure. */
export async function insertActivity(db: Db, entries: ActivityEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.collection<ActivityEntry>(ACTIVITY_LOG).insertMany(entries);
}

async function setup(db: Db): Promise<void> {
  await db.createCollection(ACTIVITY_LOG, {
    validator: { $jsonSchema: activityLogSchema },
    validationLevel: "strict",
    validationAction: "error",
  });
  await db.collection(ACTIVITY_LOG).createIndexes([
    // An entity's history (a request, allocation or batch).
    { key: { "entity.type": 1, "entity.id": 1, ts: -1 } },
    // A user's own activity.
    { key: { "actor.user_id": 1, ts: -1 } },
    // A request's timeline: its allocations and stock events too (P2.2).
    { key: { "refs.request_id": 1, ts: -1 } },
    // A center's feed (P2.4, Center Managers).
    { key: { "refs.center_id": 1, ts: -1 } },
    // The latest entries, unfiltered (P2.4).
    { key: { ts: -1 } },
  ]);
}

export const activityLog: CollectionModule = { name: ACTIVITY_LOG, setup };
