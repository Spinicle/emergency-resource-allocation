import type { ActivityAction, ActivityActor, ActivityEntry } from "../../src/lib/activity";
import type { Role } from "../../src/lib/enums";
import { istToDate } from "../../src/lib/ist";
import { type Queryable, selectRows } from "./queryable";

// ---------------------------------------------------------------------------
// activity_log's backfill from the seeded MySQL rows (docs/HANDOFF.md 4.4).
// db:reset runs it through activity_log.ts's setup; nothing else writes with it.
//
// Stored times become entries as they are: requests (requested_at),
// allocations (allocated_at) and ledger rows (changed_at), except ledger
// ALLOCATION rows, which are the allocation itself. Dispatch, deliver and
// request cancels have no stored time, so they get fixed, derived ones
// (payload.derived = true): no randomness, so every reset gives the same log.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Dispatch this long after the allocation, deliver this long after dispatch, if they fit. */
const DISPATCH_AFTER = 30 * MINUTE;
const DELIVER_AFTER = 3 * HOUR;
/** A request cancel with no allocation cancel to follow comes this long after its last stored event. */
const CANCEL_AFTER = 2 * HOUR;

/**
 * When 07_seed ran: the MYS-NR-MOHALLA emergency's end_time + 14 days (07_seed
 * closes it 14 days before the reset; t_seed.sql uses the same rule). Throws
 * if that row is missing, so a changed seed fails loudly instead of guessing.
 */
export async function seedTime(mysql: Queryable): Promise<Date> {
  const [row] = await selectRows<{ end_time: string | null }>(
    mysql,
    `SELECT MIN(e.end_time) AS end_time
       FROM emergency e
       JOIN emergency_impact ei ON ei.emergency_id = e.emergency_id
       JOIN location l          ON l.location_id   = ei.location_id
      WHERE l.grid_id = 'MYS-NR-MOHALLA'`,
  );
  if (!row?.end_time) {
    throw new Error(
      "Can't find the seed time: the MYS-NR-MOHALLA emergency or its end_time is missing (did 07_seed change?)",
    );
  }
  return new Date(istToDate(row.end_time).getTime() + 14 * 24 * HOUR);
}

type UserRow = { user_id: number; name: string; role_name: Role; center_id: number | null };
type RequestRow = { request_id: number; user_id: number; requested_at: string; status: string; emergency_id: number };
type AllocationRow = {
  allocation_id: number;
  user_id: number;
  allocated_at: string;
  status: string;
  quantity_allocated: number;
  request_id: number;
  emergency_id: number;
  center_id: number;
  batch_code: string;
  resource: string;
};
type LedgerRow = {
  ledger_id: number;
  stock_id: number;
  change_qty: number;
  balance_after: number;
  reason: string;
  allocation_id: number | null;
  changed_by: number | null;
  changed_at: string;
  center_id: number;
  batch_code: string;
  resource: string;
  request_id: number | null;
  emergency_id: number | null;
};

const LEDGER_ACTIONS: Record<string, ActivityAction> = {
  RECEIPT: "STOCK_RECEIVED",
  ADJUSTMENT: "STOCK_ADJUSTED",
  WRITE_OFF: "STOCK_WRITTEN_OFF",
  ALLOCATION_CANCELLED: "ALLOCATION_CANCELLED",
};

/** A change made outside the app (a ledger row with no changed_by). */
const CONSOLE_ACTOR: ActivityActor = { user_id: null, name: "Database console", role: null };

/** Every entry the seeded MySQL rows imply, oldest first. */
export async function seedActivity(mysql: Queryable): Promise<ActivityEntry[]> {
  const seededAt = await seedTime(mysql);
  const [users, requests, allocations, ledger] = await Promise.all([
    selectRows<UserRow>(
      mysql,
      "SELECT u.user_id, u.name, r.role_name, u.center_id FROM `user` u JOIN role r ON r.role_id = u.role_id ORDER BY u.user_id",
    ),
    selectRows<RequestRow>(
      mysql,
      `SELECT rr.request_id, rr.user_id, rr.requested_at, rr.status, ei.emergency_id
         FROM resource_request rr
         JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
        ORDER BY rr.request_id`,
    ),
    selectRows<AllocationRow>(
      mysql,
      `SELECT a.allocation_id, a.user_id, a.allocated_at, a.status, a.quantity_allocated,
              rr.request_id, ei.emergency_id, s.center_id, s.batch_code, res.name AS resource
         FROM allocation a
         JOIN request_item ri     ON ri.request_item_id = a.request_item_id
         JOIN resource_request rr ON rr.request_id      = ri.request_id
         JOIN emergency_impact ei ON ei.impact_id       = rr.impact_id
         JOIN stock s             ON s.stock_id         = a.stock_id
         JOIN resource res        ON res.resource_id    = s.resource_id
        ORDER BY a.allocation_id`,
    ),
    selectRows<LedgerRow>(
      mysql,
      `SELECT sl.ledger_id, sl.stock_id, sl.change_qty, sl.balance_after, sl.reason, sl.allocation_id,
              sl.changed_by, sl.changed_at, s.center_id, s.batch_code, res.name AS resource,
              rr.request_id, ei.emergency_id
         FROM stock_ledger sl
         JOIN stock s                  ON s.stock_id         = sl.stock_id
         JOIN resource res             ON res.resource_id    = s.resource_id
         LEFT JOIN allocation a        ON a.allocation_id    = sl.allocation_id
         LEFT JOIN request_item ri     ON ri.request_item_id = a.request_item_id
         LEFT JOIN resource_request rr ON rr.request_id      = ri.request_id
         LEFT JOIN emergency_impact ei ON ei.impact_id       = rr.impact_id
        WHERE sl.reason <> 'ALLOCATION'
        ORDER BY sl.changed_at, sl.ledger_id`,
    ),
  ]);

  const actors = new Map(users.map((u) => [u.user_id, { user_id: u.user_id, name: u.name, role: u.role_name }]));
  const actor = (id: number | null): ActivityActor => {
    if (id === null) return CONSOLE_ACTOR;
    const a = actors.get(id);
    if (!a) throw new Error(`activity backfill: no user ${id}`);
    return a;
  };
  const adminId = users.find((u) => u.role_name === "ADMIN")?.user_id;
  if (adminId === undefined) throw new Error("activity backfill: no ADMIN user");
  const managerOf = new Map<number, number>();
  for (const u of users) {
    if (u.role_name === "CENTER_MANAGER" && u.center_id !== null && !managerOf.has(u.center_id)) {
      managerOf.set(u.center_id, u.user_id);
    }
  }

  const entries: ActivityEntry[] = [];

  for (const r of requests) {
    entries.push({
      ts: istToDate(r.requested_at),
      actor: actor(r.user_id),
      action: "REQUEST_CREATED",
      entity: { type: "REQUEST", id: r.request_id },
      refs: { request_id: r.request_id, emergency_id: r.emergency_id },
    });
  }

  for (const l of ledger) {
    const action = LEDGER_ACTIONS[l.reason];
    if (!action) throw new Error(`activity backfill: unexpected ledger reason ${l.reason}`);
    const isCancel = action === "ALLOCATION_CANCELLED";
    entries.push({
      ts: istToDate(l.changed_at),
      actor: actor(l.changed_by),
      action,
      entity: isCancel ? { type: "ALLOCATION", id: l.allocation_id! } : { type: "STOCK", id: l.stock_id },
      refs: {
        ...(l.request_id !== null && { request_id: l.request_id }),
        ...(l.emergency_id !== null && { emergency_id: l.emergency_id }),
        center_id: l.center_id,
      },
      payload: {
        ledger_id: l.ledger_id,
        change_qty: l.change_qty,
        balance_after: l.balance_after,
        batch_code: l.batch_code,
        resource: l.resource,
      },
    });
  }

  // An allocation's cancel is its only later stored event; dispatch/deliver must come before it.
  const cancelledAt = new Map<number, Date>();
  for (const l of ledger) {
    if (l.reason === "ALLOCATION_CANCELLED") cancelledAt.set(l.allocation_id!, istToDate(l.changed_at));
  }

  for (const a of allocations) {
    const at = istToDate(a.allocated_at);
    const refs = { request_id: a.request_id, emergency_id: a.emergency_id, center_id: a.center_id };
    const payload = { quantity: a.quantity_allocated, resource: a.resource, batch_code: a.batch_code };
    const entity = { type: "ALLOCATION", id: a.allocation_id } as const;
    entries.push({ ts: at, actor: actor(a.user_id), action: "ALLOCATION_CREATED", entity, refs, payload });

    // Status only: an allocation dispatched and then cancelled reads as CANCELLED (no dispatch entry).
    if (a.status !== "DISPATCHED" && a.status !== "DELIVERED") continue;
    const bound = cancelledAt.get(a.allocation_id) ?? seededAt;
    const gap = bound.getTime() - at.getTime();
    if (gap <= 0) throw new Error(`activity backfill: allocation ${a.allocation_id} has no room after allocated_at`);
    const handler = actor(managerOf.get(a.center_id) ?? adminId);
    const dispatchedAt = wholeSecond(at.getTime() + Math.min(DISPATCH_AFTER, gap / 3));
    entries.push({
      ts: dispatchedAt,
      actor: handler,
      action: "ALLOCATION_DISPATCHED",
      entity,
      refs,
      payload: { ...payload, derived: true },
    });
    if (a.status === "DELIVERED") {
      entries.push({
        ts: wholeSecond(Math.min(dispatchedAt.getTime() + DELIVER_AFTER, at.getTime() + (2 * gap) / 3)),
        actor: handler,
        action: "ALLOCATION_DELIVERED",
        entity,
        refs,
        payload: { ...payload, derived: true },
      });
    }
  }

  for (const r of requests) {
    if (r.status !== "CANCELLED") continue;
    const own = allocations.filter((a) => a.request_id === r.request_id);
    const cancels = own.flatMap((a) => cancelledAt.get(a.allocation_id) ?? []);
    const stored = [istToDate(r.requested_at), ...own.map((a) => istToDate(a.allocated_at)), ...cancels];
    const anchor =
      cancels.length > 0
        ? Math.max(...cancels.map((d) => d.getTime())) + 1000 // right after the allocation cancel it follows
        : Math.max(...stored.map((d) => d.getTime())) + CANCEL_AFTER;
    entries.push({
      ts: new Date(Math.min(anchor, seededAt.getTime())),
      actor: actor(r.user_id), // nothing records who cancelled; the requester is the rule
      action: "REQUEST_CANCELLED",
      entity: { type: "REQUEST", id: r.request_id },
      refs: { request_id: r.request_id, emergency_id: r.emergency_id },
      payload: { derived: true },
    });
  }

  // Oldest first; ties keep the order above (stable sort).
  return entries.sort((x, y) => x.ts.getTime() - y.ts.getTime());
}

function wholeSecond(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}
