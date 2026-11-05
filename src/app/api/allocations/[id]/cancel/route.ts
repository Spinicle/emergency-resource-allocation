import type { CancelAllocationResult } from "@/lib/allocation-types";
import { loadAllocation, loadItemState, logAllocationEvents } from "@/lib/allocations";
import { handle, ok } from "@/lib/http";
import { execute } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { allocationIdParams } from "@/lib/validators/allocations";

// POST /api/allocations/[id]/cancel (docs/HANDOFF.md 4.9) -> 200 { allocation, item }
// sp_cancel_allocation in autocommit: the triggers check the transition, return
// the stock (ledger ALLOCATION_CANCELLED) and recompute the item and request.
// Refusals (not found, already CANCELLED, DELIVERED) are 45000 -> 409 as-is.

export const POST = handle(async (_req, ctx: RouteContext<"/api/allocations/[id]/cancel">) => {
  const session = await requireRole("ADMIN", "COORDINATOR");
  const { id } = allocationIdParams.parse(await ctx.params);

  await execute("CALL sp_cancel_allocation(?, ?)", [id, session.userId]);

  const allocation = await loadAllocation(id);
  const item = allocation && (await loadItemState(allocation.request_item_id));
  if (!allocation || !item) throw new Error(`Allocation ${id} vanished after cancelling`);

  await logAllocationEvents(session, "ALLOCATION_CANCELLED", [id]);
  return ok({ allocation, item } satisfies CancelAllocationResult);
});
