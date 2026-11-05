import { handle, ok, parseJson } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { adjustBatch } from "@/lib/stock";
import { adjustStockSchema, batchIdParams } from "@/lib/validators/stock";

// POST /api/stock/[id]/adjust (docs/HANDOFF.md 4.10) -> 200 { batch, ledger }
// Body { delta, reason: ADJUSTMENT | WRITE_OFF }; adjustBatch in lib/stock.ts.
// The procedure's refusals are 409s shown as-is. Allowed at CLOSED centers.

export const POST = handle(async (req, ctx: RouteContext<"/api/stock/[id]/adjust">) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  const { id } = batchIdParams.parse(await ctx.params);
  return ok(await adjustBatch(session, id, await parseJson(req, adjustStockSchema)));
});
