import type { RowDataPacket } from "mysql2/promise";
import { handle, HttpError, ok, parseJson, parseQuery } from "@/lib/http";
import { withTransaction } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { centerScope, listBatches, loadBatch, loadNewestLedgerRow, logStockEvent, receivingCenter } from "@/lib/stock";
import type { StockChangeResult } from "@/lib/stock-types";
import { receiveBatchSchema, stockListQuery } from "@/lib/validators/stock";

// /api/stock (docs/HANDOFF.md 4.10), ADMIN and CENTER_MANAGER (own center only)
//   GET  ?center=&resource=  -> batches, FEFO within each resource, with days_left and usable
//   POST                     -> 201 { batch, ledger }: receive a batch through sp_add_batch

export const GET = handle(async (req) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  const { center, resource } = parseQuery(req, stockListQuery);
  return ok(await listBatches(centerScope(session, center), resource ?? null));
});

/*
 * One transaction:
 *  1. The center, FOR SHARE: missing -> 404; CLOSED -> 409 (an app rule, like
 *     reports on a CLOSED emergency). The shared lock makes a concurrent close
 *     wait, so a batch can't land at a center that just closed. Allocations take
 *     the center shared too, so this adds no new way to deadlock.
 *  2. CALL sp_add_batch: one INSERT; trg_stock_ai writes the RECEIPT row with
 *     changed_by = the caller. A repeated batch code at the center is 1062
 *     (uq_stock_batch) -> 409 DUPLICATE; an unknown resource 1216 -> 409.
 *  3. The new batch and its RECEIPT row (the only ledger row a new batch has).
 */
export const POST = handle(async (req) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  const body = await parseJson(req, receiveBatchSchema);
  const centerId = receivingCenter(session, body.center_id);

  const result = await withTransaction<StockChangeResult>(async (conn) => {
    const [centers] = await conn.query<RowDataPacket[]>(
      "SELECT name, status FROM resource_center WHERE center_id = ? FOR SHARE",
      [centerId],
    );
    const center = centers[0] as { name: string; status: string } | undefined;
    if (!center) throw new HttpError(404, `Center ${centerId} not found`);
    if (center.status === "CLOSED") {
      throw new HttpError(409, `Center ${center.name} is CLOSED, so it can't receive stock`, { code: "RULE" });
    }

    await conn.query("CALL sp_add_batch(?, ?, ?, ?, ?, ?, @eras_stock_id)", [
      body.resource_id,
      centerId,
      body.batch_code,
      body.quantity,
      body.expiry_date ?? null,
      session.userId,
    ]);
    const [ids] = await conn.query<RowDataPacket[]>("SELECT @eras_stock_id AS stock_id");
    const stockId = Number(ids[0].stock_id);

    const batch = await loadBatch(stockId, conn);
    const ledger = await loadNewestLedgerRow(stockId, conn);
    if (!batch || ledger?.reason !== "RECEIPT") throw new Error(`Batch ${stockId} has no RECEIPT row after receiving`);
    return { batch, ledger };
  });

  await logStockEvent(session, result.batch, result.ledger);
  return ok(result, 201);
});
