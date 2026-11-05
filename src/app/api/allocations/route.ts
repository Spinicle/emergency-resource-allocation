import type { CreateAllocationsResult, ItemAllocations } from "@/lib/allocation-types";
import { loadItemAllocations, loadItemState, logAllocationEvents } from "@/lib/allocations";
import { handle, HttpError, ok, parseJson, parseQuery } from "@/lib/http";
import { queryOne, withTransaction } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { createAllocationsSchema, itemQuery } from "@/lib/validators/allocations";

// /api/allocations (docs/HANDOFF.md 4.9)
//   GET  ?item=<id>  -> { item, allocations }: the item's current state (in the queue or not) and its allocations
//   POST             -> 201 { allocations, item }: allocate one item from 1–10 batches, all or nothing

export const GET = handle(async (req) => {
  await requireRole("ADMIN", "COORDINATOR");
  const { item: itemId } = parseQuery(req, itemQuery);
  const [item, allocations] = await Promise.all([loadItemState(itemId), loadItemAllocations(itemId)]);
  if (!item) throw new HttpError(404, `Request item ${itemId} not found`);
  return ok({ item, allocations } satisfies ItemAllocations);
});

/*
 * One transaction for 1 to N batches. Every check, lock and side effect is in
 * the triggers behind sp_allocate; any refusal throws, withTransaction rolls
 * back every part, and handle() maps the error (45000 -> 409 with its message,
 * deadlock / lock wait -> 409 RETRY; no retry here).
 *
 * - With one batch the CALL is the transaction's first statement (HANDOFF 4.4's
 *   caller rule). With several it's the all-or-nothing split 4.4 allows.
 * - Batches go in ascending stock_id order, so two splits that share batches
 *   lock them in the same order and queue instead of deadlocking.
 */
export const POST = handle(async (req) => {
  const session = await requireRole("ADMIN", "COORDINATOR");
  const { request_item_id, batches } = await parseJson(req, createAllocationsSchema);
  const ordered = [...batches].sort((a, b) => a.stock_id - b.stock_id);

  const result = await withTransaction<CreateAllocationsResult>(async (conn) => {
    const allocations: CreateAllocationsResult["allocations"] = [];
    for (const { stock_id, quantity } of ordered) {
      await conn.query("CALL sp_allocate(?, ?, ?, ?, @eras_allocation_id)", [
        request_item_id,
        stock_id,
        quantity,
        session.userId,
      ]);
      const out = await queryOne<{ allocation_id: number }>("SELECT @eras_allocation_id AS allocation_id", [], conn);
      allocations.push({ allocation_id: Number(out?.allocation_id), stock_id, quantity });
    }
    // Read inside the transaction: this item and its request are locked by the CALLs above.
    const item = await loadItemState(request_item_id, conn);
    if (!item) throw new Error(`Request item ${request_item_id} vanished after allocating`);
    return { allocations, item };
  });

  await logAllocationEvents(
    session,
    "ALLOCATION_CREATED",
    result.allocations.map((a) => a.allocation_id),
  );
  return ok(result, 201);
});
