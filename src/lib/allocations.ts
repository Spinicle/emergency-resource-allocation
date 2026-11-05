import "server-only";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { ActivityAction } from "@/lib/activity";
import type { AllocationRow, ItemState } from "@/lib/allocation-types";
import type { Session } from "@/lib/auth";
import { logActivities } from "@/lib/mongo";
import { query, queryOne } from "@/lib/mysql";

// Allocation reads shared by /api/allocations/* (P1.8) and dispatch/deliver
// (P1.9), so the activity entries and item state look the same everywhere
// (docs/HANDOFF.md 4.4, 4.9).

const ITEM_STATE_SQL = `
  SELECT ri.request_item_id, ri.request_id, rr.status AS request_status, ri.status AS item_status,
         ri.resource_id, r.name AS resource_name, r.unit,
         ri.quantity_requested, ri.quantity_allocated,
         GREATEST(ri.quantity_requested - ri.quantity_allocated, 0) AS quantity_remaining,
         ri.urgency, e.emergency_id, e.name AS emergency_name, e.status AS emergency_status, l.grid_id
    FROM request_item ri
    JOIN resource_request rr ON rr.request_id   = ri.request_id
    JOIN emergency_impact ei ON ei.impact_id    = rr.impact_id
    JOIN emergency e         ON e.emergency_id  = ei.emergency_id
    JOIN location l          ON l.location_id   = ei.location_id
    JOIN resource r          ON r.resource_id   = ri.resource_id
   WHERE ri.request_item_id = ?`;

/**
 * One item's status and quantities, or null if it doesn't exist. Pass conn to
 * read inside a transaction (it sees that transaction's own writes).
 */
export async function loadItemState(itemId: number, conn?: PoolConnection): Promise<ItemState | null> {
  if (!conn) return queryOne<ItemState>(ITEM_STATE_SQL, [itemId]);
  const [rows] = await conn.query<RowDataPacket[]>(ITEM_STATE_SQL, [itemId]);
  return (rows[0] as ItemState | undefined) ?? null;
}

const ALLOCATION_SQL = `
  SELECT a.allocation_id, a.request_item_id, a.stock_id, s.batch_code,
         s.center_id, c.name AS center_name, c.status AS center_status,
         a.status, a.quantity_allocated, a.allocated_at, u.name AS allocated_by
    FROM allocation a
    JOIN stock s           ON s.stock_id  = a.stock_id
    JOIN resource_center c ON c.center_id = s.center_id
    JOIN \`user\` u        ON u.user_id   = a.user_id`;

/** An item's allocations, oldest first. */
export function loadItemAllocations(itemId: number): Promise<AllocationRow[]> {
  return query<AllocationRow>(`${ALLOCATION_SQL} WHERE a.request_item_id = ? ORDER BY a.allocated_at, a.allocation_id`, [
    itemId,
  ]);
}

/** One allocation, or null. */
export function loadAllocation(allocationId: number): Promise<AllocationRow | null> {
  return queryOne<AllocationRow>(`${ALLOCATION_SQL} WHERE a.allocation_id = ?`, [allocationId]);
}

/** What an activity entry about an allocation needs: its refs and payload fields. */
export type AllocationEvent = {
  allocation_id: number;
  quantity: number;
  request_id: number;
  emergency_id: number;
  center_id: number;
  batch_code: string;
  resource: string;
  /** The allocation's ALLOCATION_CANCELLED ledger row; null until it's cancelled. */
  ledger_id: number | null;
  change_qty: number | null;
  balance_after: number | null;
};

/** Refs and payload fields for each allocation id, in id order. */
export function loadAllocationEvents(ids: number[]): Promise<AllocationEvent[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return query<AllocationEvent>(
    `SELECT a.allocation_id, a.quantity_allocated AS quantity, ri.request_id, ei.emergency_id,
            s.center_id, s.batch_code, res.name AS resource,
            sl.ledger_id, sl.change_qty, sl.balance_after
       FROM allocation a
       JOIN request_item ri     ON ri.request_item_id = a.request_item_id
       JOIN resource_request rr ON rr.request_id      = ri.request_id
       JOIN emergency_impact ei ON ei.impact_id       = rr.impact_id
       JOIN stock s             ON s.stock_id         = a.stock_id
       JOIN resource res        ON res.resource_id    = s.resource_id
       LEFT JOIN stock_ledger sl ON sl.allocation_id = a.allocation_id AND sl.reason = 'ALLOCATION_CANCELLED'
      WHERE a.allocation_id IN (?)
      ORDER BY a.allocation_id`,
    [ids],
  );
}

type AllocationAction = Extract<ActivityAction, `ALLOCATION_${string}`>;

/**
 * One activity_log entry per allocation, after the MySQL write has committed.
 * Same shapes as the seed backfill (db/mongo/activity_backfill.ts): entity
 * ALLOCATION, refs { request_id, emergency_id, center_id }, payload
 * { quantity, resource, batch_code }, or for ALLOCATION_CANCELLED the ledger
 * row's { ledger_id, change_qty, balance_after, batch_code, resource }.
 * Never throws: like logActivity, a failure is logged and the request carries on.
 */
export async function logAllocationEvents(actor: Session, action: AllocationAction, ids: number[]): Promise<void> {
  let events: AllocationEvent[];
  try {
    events = await loadAllocationEvents(ids);
  } catch (err) {
    console.error(`logAllocationEvents(${action}) couldn't load allocations ${ids.join(", ")}:`, (err as Error).message);
    return;
  }
  // One insert for all of them (in allocation_id order), so MongoDB being down costs one wait.
  await logActivities(
    actor,
    events.map((ev) => ({
      action,
      entity: { type: "ALLOCATION", id: ev.allocation_id },
      refs: { request_id: ev.request_id, emergency_id: ev.emergency_id, center_id: ev.center_id },
      payload:
        action === "ALLOCATION_CANCELLED"
          ? {
              ledger_id: ev.ledger_id,
              change_qty: ev.change_qty,
              balance_after: ev.balance_after,
              batch_code: ev.batch_code,
              resource: ev.resource,
            }
          : { quantity: ev.quantity, resource: ev.resource, batch_code: ev.batch_code },
    })),
  );
}
