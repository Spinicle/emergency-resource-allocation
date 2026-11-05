import { handle, ok } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { moveAllocation } from "@/lib/stock";
import type { AllocationStatusResult } from "@/lib/stock-types";
import { allocationIdParams } from "@/lib/validators/allocations";

// POST /api/stock/allocations/[id]/dispatch (docs/HANDOFF.md 4.10) -> 200 { allocation }
// RESERVED -> DISPATCHED from the caller's center. Wrong transitions are the
// trigger's 409, as-is. Cancelling is /api/allocations/[id]/cancel (coordinators).

export const POST = handle(async (_req, ctx: RouteContext<"/api/stock/allocations/[id]/dispatch">) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  const { id } = allocationIdParams.parse(await ctx.params);
  return ok({ allocation: await moveAllocation(session, id, "DISPATCHED") } satisfies AllocationStatusResult);
});
