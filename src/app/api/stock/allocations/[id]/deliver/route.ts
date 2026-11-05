import { handle, ok } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { moveAllocation } from "@/lib/stock";
import type { AllocationStatusResult } from "@/lib/stock-types";
import { allocationIdParams } from "@/lib/validators/allocations";

// POST /api/stock/allocations/[id]/deliver (docs/HANDOFF.md 4.10) -> 200 { allocation }
// DISPATCHED -> DELIVERED from the caller's center. Wrong transitions are the
// trigger's 409, as-is ("Allocation can't go from RESERVED to DELIVERED").

export const POST = handle(async (_req, ctx: RouteContext<"/api/stock/allocations/[id]/deliver">) => {
  const session = await requireRole("ADMIN", "CENTER_MANAGER");
  const { id } = allocationIdParams.parse(await ctx.params);
  return ok({ allocation: await moveAllocation(session, id, "DELIVERED") } satisfies AllocationStatusResult);
});
