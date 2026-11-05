import "server-only";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { ActivityAction } from "@/lib/activity";
import type { AllocationRow } from "@/lib/allocation-types";
import { loadAllocation, logAllocationEvents } from "@/lib/allocations";
import type { Session } from "@/lib/auth";
import { HttpError } from "@/lib/http";
import { logActivities } from "@/lib/mongo";
import { execute, query, queryOne } from "@/lib/mysql";
import type { CenterAllocationRow, LedgerRow, StockRow } from "@/lib/stock-types";

// The stock API's shared pieces (docs/HANDOFF.md 4.10): center scope, batch and
// ledger reads, and the activity entries for stock changes.
//
// Scope: a CENTER_MANAGER works only on session.centerId; ADMIN on any center
// (three seeded centers have no manager). The checks are plain reads, never
// locks: a batch's center can't change once it has allocations
// (trg_stock_bu), nothing in the app moves a batch, and a locking read of a
// stock row before UPDATE allocation would reverse the cancel path's lock order
// (allocation → item → request → stock) and could deadlock.

const FORBIDDEN = "You don't have access to this";

/** Throws 403 unless the session may work on centerId. */
function assertCenter(session: Session, centerId: number): void {
  if (session.role === "ADMIN") return;
  if (session.role === "CENTER_MANAGER" && session.centerId === centerId) return;
  throw new HttpError(403, FORBIDDEN);
}

/** A batch the session may change or read: 404 if it doesn't exist, 403 if it's another center's (for a CM). */
export async function requireBatchAccess(session: Session, stockId: number): Promise<{ center_id: number }> {
  const batch = await queryOne<{ center_id: number }>("SELECT center_id FROM stock WHERE stock_id = ?", [stockId]);
  if (!batch) throw new HttpError(404, `Batch ${stockId} not found`);
  assertCenter(session, batch.center_id);
  return batch;
}

/** An allocation the session may dispatch or deliver: its batch's center decides, as above. */
export async function requireAllocationAccess(session: Session, allocationId: number): Promise<{ center_id: number }> {
  const row = await queryOne<{ center_id: number }>(
    "SELECT s.center_id FROM allocation a JOIN stock s ON s.stock_id = a.stock_id WHERE a.allocation_id = ?",
    [allocationId],
  );
  if (!row) throw new HttpError(404, `Allocation ${allocationId} not found`);
  assertCenter(session, row.center_id);
  return row;
}

/**
 * The center a list is limited to (?center=). A CENTER_MANAGER gets their own
 * (asking for another is a 403); ADMIN gets the one asked for, or null for all.
 */
export function centerScope(session: Session, requested: number | undefined): number | null {
  if (session.role === "CENTER_MANAGER") {
    if (requested !== undefined && requested !== session.centerId) throw new HttpError(403, FORBIDDEN);
    return session.centerId;
  }
  if (session.role === "ADMIN") return requested ?? null;
  throw new HttpError(403, FORBIDDEN);
}

/** The center a new batch goes to: ADMIN must name one; a CENTER_MANAGER leaves it out or names their own. */
export function receivingCenter(session: Session, requested: number | undefined): number {
  if (session.role === "CENTER_MANAGER") {
    if (requested !== undefined && requested !== session.centerId) throw new HttpError(403, FORBIDDEN);
    return session.centerId!;
  }
  if (session.role !== "ADMIN") throw new HttpError(403, FORBIDDEN);
  if (requested === undefined) {
    throw new HttpError(400, "Check the highlighted fields", {
      code: "VALIDATION",
      fields: { center_id: "Choose the center receiving the batch" },
    });
  }
  return requested;
}

/** Rows of a SELECT on conn (inside a transaction) or the pool. */
async function select<T>(sql: string, params: unknown[], conn?: PoolConnection): Promise<T[]> {
  if (!conn) return query<T>(sql, params);
  const [rows] = await conn.query<RowDataPacket[]>(sql, params);
  return rows as T[];
}

const BATCH_SQL = `
  SELECT s.stock_id, s.batch_code, s.resource_id, r.name AS resource_name, r.category, r.unit,
         s.center_id, c.name AS center_name, c.status AS center_status,
         s.quantity_available, s.expiry_date, DATEDIFF(s.expiry_date, CURDATE()) AS days_left,
         (s.quantity_available > 0 AND (s.expiry_date IS NULL OR s.expiry_date >= CURDATE())) AS usable
    FROM stock s
    JOIN resource r        ON r.resource_id = s.resource_id
    JOIN resource_center c ON c.center_id   = s.center_id`;

/** MySQL gives the usable flag as 0/1. */
const toBatch = (row: Omit<StockRow, "usable"> & { usable: number }): StockRow => ({ ...row, usable: row.usable === 1 });

/** Batches, FEFO within each resource: resource name, then earliest expiry (none last), then batch code. */
export async function listBatches(centerId: number | null, resourceId: number | null): Promise<StockRow[]> {
  const rows = await select<Omit<StockRow, "usable"> & { usable: number }>(
    `${BATCH_SQL}
      WHERE (? IS NULL OR s.center_id = ?) AND (? IS NULL OR s.resource_id = ?)
      ORDER BY r.name, s.expiry_date IS NULL, s.expiry_date, s.batch_code`,
    [centerId, centerId, resourceId, resourceId],
  );
  return rows.map(toBatch);
}

/** One batch, or null. Pass conn to read inside a transaction. */
export async function loadBatch(stockId: number, conn?: PoolConnection): Promise<StockRow | null> {
  const [row] = await select<Omit<StockRow, "usable"> & { usable: number }>(
    `${BATCH_SQL} WHERE s.stock_id = ?`,
    [stockId],
    conn,
  );
  return row ? toBatch(row) : null;
}

const LEDGER_SQL = `
  SELECT sl.ledger_id, sl.stock_id, sl.changed_at, sl.reason, sl.change_qty, sl.balance_after,
         sl.allocation_id, COALESCE(u.name, 'Database console') AS changed_by
    FROM stock_ledger sl
    LEFT JOIN \`user\` u ON u.user_id = sl.changed_by`;

/** A batch's ledger, oldest first (changed_at, then ledger_id: many rows share a second; HANDOFF 8). */
export function loadLedger(stockId: number): Promise<LedgerRow[]> {
  return select<LedgerRow>(`${LEDGER_SQL} WHERE sl.stock_id = ? ORDER BY sl.changed_at, sl.ledger_id`, [stockId]);
}

/**
 * The batch's newest ledger row, on conn right after the change that wrote it.
 * Exact: that change's UPDATE (or INSERT) holds the batch's row lock until
 * commit, so no other row for it can land in between, and ledger_id grows.
 */
export async function loadNewestLedgerRow(stockId: number, conn: PoolConnection): Promise<LedgerRow | null> {
  const [row] = await select<LedgerRow>(
    `${LEDGER_SQL} WHERE sl.stock_id = ? ORDER BY sl.ledger_id DESC LIMIT 1`,
    [stockId],
    conn,
  );
  return row ?? null;
}

/** A center's allocations (null = every center): RESERVED and DISPATCHED first, then newest first. */
export function listCenterAllocations(
  centerId: number | null,
  status: string | undefined,
): Promise<CenterAllocationRow[]> {
  const s = status ?? null;
  return select<CenterAllocationRow>(
    `SELECT a.allocation_id, a.request_item_id, ri.request_id, a.stock_id, s.batch_code,
            s.center_id, c.name AS center_name, r.name AS resource_name, r.unit,
            a.quantity_allocated, a.status, e.emergency_id, e.name AS emergency_name, l.grid_id,
            a.allocated_at, u.name AS allocated_by
       FROM allocation a
       JOIN stock s             ON s.stock_id         = a.stock_id
       JOIN resource_center c   ON c.center_id        = s.center_id
       JOIN resource r          ON r.resource_id      = s.resource_id
       JOIN request_item ri     ON ri.request_item_id = a.request_item_id
       JOIN resource_request rr ON rr.request_id      = ri.request_id
       JOIN emergency_impact ei ON ei.impact_id       = rr.impact_id
       JOIN emergency e         ON e.emergency_id     = ei.emergency_id
       JOIN location l          ON l.location_id      = ei.location_id
       JOIN \`user\` u          ON u.user_id          = a.user_id
      WHERE (? IS NULL OR s.center_id = ?) AND (? IS NULL OR a.status = ?)
      ORDER BY a.status IN ('RESERVED', 'DISPATCHED') DESC, a.allocated_at DESC, a.allocation_id DESC`,
    [centerId, centerId, s, s],
  );
}

const STOCK_ACTIONS = {
  RECEIPT: "STOCK_RECEIVED",
  ADJUSTMENT: "STOCK_ADJUSTED",
  WRITE_OFF: "STOCK_WRITTEN_OFF",
} as const satisfies Partial<Record<LedgerRow["reason"], ActivityAction>>;

/**
 * The activity_log entry for a receipt, adjustment or write-off, after the
 * commit. The seed backfill's shapes: entity STOCK (the batch), refs
 * { center_id }, payload { ledger_id, change_qty, balance_after, batch_code,
 * resource } from the ledger row. Never throws.
 */
export async function logStockEvent(actor: Session, batch: StockRow, ledger: LedgerRow): Promise<void> {
  const action = STOCK_ACTIONS[ledger.reason as keyof typeof STOCK_ACTIONS];
  if (!action) {
    console.error(`logStockEvent: ledger row ${ledger.ledger_id} is ${ledger.reason}, not a stock event`);
    return;
  }
  await logActivities(actor, [
    {
      action,
      entity: { type: "STOCK", id: batch.stock_id },
      refs: { center_id: batch.center_id },
      payload: {
        ledger_id: ledger.ledger_id,
        change_qty: ledger.change_qty,
        balance_after: ledger.balance_after,
        batch_code: batch.batch_code,
        resource: batch.resource_name,
      },
    },
  ]);
}

/**
 * Dispatch or deliver an allocation from the session's center: one plain
 * UPDATE in autocommit (HANDOFF 4.4). trg_allocation_bu refuses a wrong
 * transition (409, shown as-is). Then its ALLOCATION_DISPATCHED /
 * ALLOCATION_DELIVERED entry.
 */
export async function moveAllocation(
  session: Session,
  allocationId: number,
  to: "DISPATCHED" | "DELIVERED",
): Promise<AllocationRow> {
  await requireAllocationAccess(session, allocationId);
  await execute("UPDATE allocation SET status = ? WHERE allocation_id = ?", [to, allocationId]);
  const allocation = await loadAllocation(allocationId);
  if (!allocation) throw new Error(`Allocation ${allocationId} vanished after ${to}`);
  await logAllocationEvents(
    session,
    to === "DISPATCHED" ? "ALLOCATION_DISPATCHED" : "ALLOCATION_DELIVERED",
    [allocationId],
  );
  return allocation;
}
