import "server-only";
import type { PoolConnection } from "mysql2/promise";
import type { ActivityAction } from "@/lib/activity";
import type { AllocationRow } from "@/lib/allocation-types";
import { loadAllocation, logAllocationEvents } from "@/lib/allocations";
import type { Session } from "@/lib/auth";
import type { AllocationStatus, LedgerReason } from "@/lib/enums";
import { HttpError } from "@/lib/http";
import { logActivities } from "@/lib/mongo";
import { execute, query, queryOne, withTransaction } from "@/lib/mysql";
import type { CenterAllocationRow, LedgerRow, StockChangeResult, StockRow } from "@/lib/stock-types";
import type { AdjustStockInput, ReceiveBatchInput } from "@/lib/validators/stock";

// The stock API (docs/HANDOFF.md 4.10): center scope, reads, and the three
// writes (receive, adjust, dispatch/deliver). Route Handlers check the role and
// parse the request, then call one function here.
//
// Scope: a CENTER_MANAGER works only on session.centerId; ADMIN on any center
// (three seeded centers have no manager). The checks are plain reads, never
// locks: a batch's center can't change once it has allocations
// (trg_stock_bu), nothing in the app moves a batch, and a locking read of a
// stock row before UPDATE allocation would reverse the cancel path's lock order
// (allocation → item → request → stock) and could deadlock.

const FORBIDDEN = "You don't have access to this";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The center a request is limited to: a CENTER_MANAGER's own (naming another
 * is a 403), or for ADMIN the one named, null meaning every center.
 */
export function centerScope(session: Session, requested: number | undefined): number | null {
  if (session.role === "ADMIN") return requested ?? null;
  // getSession() signs out a CENTER_MANAGER without a center; refuse rather than widen to "every center".
  if (session.role !== "CENTER_MANAGER" || session.centerId === null) throw new HttpError(403, FORBIDDEN);
  if (requested !== undefined && requested !== session.centerId) throw new HttpError(403, FORBIDDEN);
  return session.centerId;
}

/** The center a row belongs to, by a SELECT returning center_id: 404 if missing, 403 if out of scope. */
async function requireRowCenter(session: Session, sql: string, id: number, notFound: string): Promise<number> {
  const row = await queryOne<{ center_id: number }>(sql, [id]);
  if (!row) throw new HttpError(404, notFound);
  centerScope(session, row.center_id);
  return row.center_id;
}

/** A batch the session may change or read (plain read; see above). */
export function requireBatchAccess(session: Session, stockId: number): Promise<number> {
  return requireRowCenter(session, "SELECT center_id FROM stock WHERE stock_id = ?", stockId, `Batch ${stockId} not found`);
}

/** An allocation the session may dispatch or deliver: its batch's center decides (plain read). */
export function requireAllocationAccess(session: Session, allocationId: number): Promise<number> {
  return requireRowCenter(
    session,
    "SELECT s.center_id FROM allocation a JOIN stock s ON s.stock_id = a.stock_id WHERE a.allocation_id = ?",
    allocationId,
    `Allocation ${allocationId} not found`,
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A batch row as MySQL returns it: the usable flag is 0/1. */
type BatchDbRow = Omit<StockRow, "usable"> & { usable: 0 | 1 };

const toBatch = (row: BatchDbRow): StockRow => ({ ...row, usable: row.usable === 1 });

const BATCH_SQL = `
  SELECT s.stock_id, s.batch_code, s.resource_id, r.name AS resource_name, r.category, r.unit,
         s.center_id, c.name AS center_name, c.status AS center_status,
         s.quantity_available, s.expiry_date, DATEDIFF(s.expiry_date, CURDATE()) AS days_left,
         (s.quantity_available > 0 AND (s.expiry_date IS NULL OR s.expiry_date >= CURDATE())) AS usable
    FROM stock s
    JOIN resource r        ON r.resource_id = s.resource_id
    JOIN resource_center c ON c.center_id   = s.center_id`;

/** Batches, FEFO within each resource: resource name, then earliest expiry (none last), then batch code. */
export async function listBatches(centerId: number | null, resourceId: number | null): Promise<StockRow[]> {
  const rows = await query<BatchDbRow>(
    `${BATCH_SQL}
      WHERE (? IS NULL OR s.center_id = ?) AND (? IS NULL OR s.resource_id = ?)
      ORDER BY r.name, s.expiry_date IS NULL, s.expiry_date, s.batch_code`,
    [centerId, centerId, resourceId, resourceId],
  );
  return rows.map(toBatch);
}

async function loadBatch(stockId: number, conn: PoolConnection): Promise<StockRow | null> {
  const row = await queryOne<BatchDbRow>(`${BATCH_SQL} WHERE s.stock_id = ?`, [stockId], conn);
  return row && toBatch(row);
}

const LEDGER_SQL = `
  SELECT sl.ledger_id, sl.stock_id, sl.changed_at, sl.reason, sl.change_qty, sl.balance_after,
         sl.allocation_id, COALESCE(u.name, 'Database console') AS changed_by
    FROM stock_ledger sl
    LEFT JOIN \`user\` u ON u.user_id = sl.changed_by`;

/** A batch's ledger, oldest first (changed_at, then ledger_id: many rows share a second; HANDOFF 8). */
export function loadLedger(stockId: number): Promise<LedgerRow[]> {
  return query<LedgerRow>(`${LEDGER_SQL} WHERE sl.stock_id = ? ORDER BY sl.changed_at, sl.ledger_id`, [stockId]);
}

/** A center's allocations (null = every center): RESERVED and DISPATCHED first, then newest first. */
export function listCenterAllocations(
  centerId: number | null,
  status: AllocationStatus | undefined,
): Promise<CenterAllocationRow[]> {
  const s = status ?? null;
  return query<CenterAllocationRow>(
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

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The activity action for a stock change, by its ledger reason (allocation rows aren't stock events). */
function stockAction(reason: LedgerReason): ActivityAction | null {
  switch (reason) {
    case "RECEIPT":
      return "STOCK_RECEIVED";
    case "ADJUSTMENT":
      return "STOCK_ADJUSTED";
    case "WRITE_OFF":
      return "STOCK_WRITTEN_OFF";
    default:
      return null;
  }
}

/**
 * One stock change: write(conn) runs the procedure in a transaction and returns
 * the batch's id; then the batch and its newest ledger row (by ledger_id; exact,
 * because the write holds the batch's row lock until commit) are read on the
 * same connection. After the commit, the backfill-shaped activity entry: entity
 * STOCK, refs { center_id }, payload { ledger_id, change_qty, balance_after,
 * batch_code, resource }. Logging never fails the request.
 */
async function changeStock(
  session: Session,
  write: (conn: PoolConnection) => Promise<number>,
): Promise<StockChangeResult> {
  const result = await withTransaction<StockChangeResult>(async (conn) => {
    const stockId = await write(conn);
    const batch = await loadBatch(stockId, conn);
    const ledger = await queryOne<LedgerRow>(
      `${LEDGER_SQL} WHERE sl.stock_id = ? ORDER BY sl.ledger_id DESC LIMIT 1`,
      [stockId],
      conn,
    );
    if (!batch || !ledger) throw new Error(`Batch ${stockId} has no ledger row after a stock change`);
    return { batch, ledger };
  });

  const { batch, ledger } = result;
  const action = stockAction(ledger.reason);
  if (action) {
    await logActivities(session, [
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
  return result;
}

/**
 * Receive a batch (ledger RECEIPT, changed_by = the caller). ADMIN must name the
 * center (400); a CENTER_MANAGER leaves it out or names their own (else 403).
 *  1. The center, FOR SHARE: missing -> 404; CLOSED -> 409 (an app rule, like
 *     reports on a CLOSED emergency). The shared lock makes a concurrent close
 *     wait; allocations take the center shared too, so nothing new can deadlock.
 *  2. CALL sp_add_batch. A repeated batch code at the center is 1062
 *     (uq_stock_batch) -> 409 DUPLICATE; an unknown resource 1216 -> 409.
 */
export function receiveBatch(session: Session, input: ReceiveBatchInput): Promise<StockChangeResult> {
  const centerId = centerScope(session, input.center_id);
  if (centerId === null) {
    throw new HttpError(400, "Check the highlighted fields", {
      code: "VALIDATION",
      fields: { center_id: "Choose the center receiving the batch" },
    });
  }

  return changeStock(session, async (conn) => {
    const center = await queryOne<{ name: string; status: string }>(
      "SELECT name, status FROM resource_center WHERE center_id = ? FOR SHARE",
      [centerId],
      conn,
    );
    if (!center) throw new HttpError(404, `Center ${centerId} not found`);
    if (center.status === "CLOSED") {
      throw new HttpError(409, `Center ${center.name} is CLOSED, so it can't receive stock`, { code: "RULE" });
    }
    await conn.query("CALL sp_add_batch(?, ?, ?, ?, ?, ?, @eras_stock_id)", [
      input.resource_id,
      centerId,
      input.batch_code,
      input.quantity,
      input.expiry_date ?? null,
      session.userId,
    ]);
    const out = await queryOne<{ stock_id: number }>("SELECT @eras_stock_id AS stock_id", [], conn);
    return Number(out?.stock_id);
  });
}

/**
 * Adjust or write off a batch through sp_adjust_stock (one UPDATE; the ledger
 * row's changed_by = the caller). Its refusals are 409s shown as-is ("A
 * write-off must reduce the quantity", "Insufficient stock in this batch").
 * Allowed at CLOSED centers (writing off a flooded camp's stock).
 */
export async function adjustBatch(session: Session, stockId: number, input: AdjustStockInput): Promise<StockChangeResult> {
  await requireBatchAccess(session, stockId);
  return changeStock(session, async (conn) => {
    await conn.query("CALL sp_adjust_stock(?, ?, ?, ?)", [stockId, input.delta, input.reason, session.userId]);
    return stockId;
  });
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
