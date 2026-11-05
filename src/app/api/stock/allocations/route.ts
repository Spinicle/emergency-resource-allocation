import { handle, ok, parseQuery } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { centerScope, listCenterAllocations } from "@/lib/stock";
import { centerAllocationsQuery } from "@/lib/validators/stock";

// GET /api/stock/allocations?center=&status= (docs/HANDOFF.md 4.10): allocations
// from a center's batches, RESERVED and DISPATCHED first, then newest first.
// A CENTER_MANAGER sees their own center; ADMIN any (all when center is left out).

export const GET = handle(async (req) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  const { center, status } = parseQuery(req, centerAllocationsQuery);
  return ok(await listCenterAllocations(centerScope(session, center), status));
});
