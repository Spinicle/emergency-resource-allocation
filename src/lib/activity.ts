import type { Role } from "./enums";

// The activity_log vocabulary (docs/HANDOFF.md 4.4). The TypeScript types and
// the collection's validator (db/mongo/activity_log.ts) both come from these
// lists, so there is one definition. Part 2 adds its own actions and entity
// types here (e.g. EMERGENCY_CREATED, IMPACT, USER); db:reset applies them.
//
// Only a type import: this file is shared by server code, client code and scripts.

export const ACTIVITY_ACTIONS = [
  "REQUEST_CREATED",
  "REQUEST_CANCELLED",
  "ALLOCATION_CREATED",
  "ALLOCATION_DISPATCHED",
  "ALLOCATION_DELIVERED",
  "ALLOCATION_CANCELLED",
  "STOCK_RECEIVED",
  "STOCK_ADJUSTED",
  "STOCK_WRITTEN_OFF",
  "FIELD_REPORT_FILED",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/** What an entry is about. STOCK is one batch (stock_id); FIELD_REPORT is keyed by observation_id. */
export const ACTIVITY_ENTITY_TYPES = ["REQUEST", "ALLOCATION", "STOCK", "FIELD_REPORT"] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

/**
 * Who did it. user_id and role are null only for a change made outside the app
 * (a stock_ledger row with no changed_by), named "Database console".
 */
export type ActivityActor = { user_id: number | null; name: string; role: Role | null };

/** Ids that let a timeline or feed find the entry without knowing its entity type. */
export type ActivityRefs = { request_id?: number; emergency_id?: number; center_id?: number };

/** One activity_log document. ts is a UTC instant (MySQL times go through istToDate first). */
export type ActivityEntry = {
  ts: Date;
  actor: ActivityActor;
  action: ActivityAction;
  entity: { type: ActivityEntityType; id: number };
  refs?: ActivityRefs;
  payload?: Record<string, unknown>;
};
