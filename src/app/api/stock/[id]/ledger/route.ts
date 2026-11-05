import { handle, ok } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { loadLedger, requireBatchAccess } from "@/lib/stock";
import { batchIdParams } from "@/lib/validators/stock";

// GET /api/stock/[id]/ledger (docs/HANDOFF.md 4.10): the batch's ledger, oldest
// first (changed_at, ledger_id). Running sum of change_qty = balance_after on
// every row; the last balance = the batch's quantity (query 11, T18).

export const GET = handle(async (_req, ctx: RouteContext<"/api/stock/[id]/ledger">) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  const { id } = batchIdParams.parse(await ctx.params);
  await requireBatchAccess(session, id);
  return ok(await loadLedger(id));
});
