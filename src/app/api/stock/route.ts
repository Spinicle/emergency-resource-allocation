import { handle, ok, parseJson, parseQuery } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { centerScope, listBatches, receiveBatch } from "@/lib/stock";
import { receiveBatchSchema, stockListQuery } from "@/lib/validators/stock";

// /api/stock (docs/HANDOFF.md 4.10), ADMIN and CENTER_MANAGER (own center only)
//   GET  ?center=&resource=  -> batches, FEFO within each resource, with days_left and usable
//   POST                     -> 201 { batch, ledger }: receive a batch (receiveBatch in lib/stock.ts)

export const GET = handle(async (req) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  const { center, resource } = parseQuery(req, stockListQuery);
  return ok(await listBatches(centerScope(session, center), resource ?? null));
});

export const POST = handle(async (req) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  return ok(await receiveBatch(session, await parseJson(req, receiveBatchSchema)), 201);
});
