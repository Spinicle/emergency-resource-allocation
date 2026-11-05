import { handle, ok, parseJson } from "@/lib/http";
import { withTransaction } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { loadBatch, loadNewestLedgerRow, logStockEvent, requireBatchAccess } from "@/lib/stock";
import type { StockChangeResult } from "@/lib/stock-types";
import { adjustStockSchema, batchIdParams } from "@/lib/validators/stock";

// POST /api/stock/[id]/adjust (docs/HANDOFF.md 4.10) -> 200 { batch, ledger }
// Body { delta, reason: ADJUSTMENT | WRITE_OFF }. sp_adjust_stock runs one
// UPDATE; trg_stock_au writes the ledger row (changed_by = the caller). Its
// refusals are 409s shown as-is: "A write-off must reduce the quantity",
// "Insufficient stock in this batch" (below 0). Allowed at CLOSED centers
// (writing off a flooded camp's stock).

export const POST = handle(async (req, ctx: RouteContext<"/api/stock/[id]/adjust">) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  const { id } = batchIdParams.parse(await ctx.params);
  const { delta, reason } = await parseJson(req, adjustStockSchema);
  await requireBatchAccess(session, id);

  const result = await withTransaction<StockChangeResult>(async (conn) => {
    await conn.query("CALL sp_adjust_stock(?, ?, ?, ?)", [id, delta, reason, session.userId]);
    // Exact: the UPDATE above holds this batch's row lock until commit.
    const batch = await loadBatch(id, conn);
    const ledger = await loadNewestLedgerRow(id, conn);
    if (!batch || !ledger) throw new Error(`Batch ${id} has no ledger row after adjusting`);
    return { batch, ledger };
  });

  await logStockEvent(session, result.batch, result.ledger);
  return ok(result);
});
