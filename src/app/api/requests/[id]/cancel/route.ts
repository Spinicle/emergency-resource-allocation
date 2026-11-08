import type { RowDataPacket } from "mysql2/promise";
import type { EmergencyStatus, RequestStatus } from "@/lib/enums";
import { handle, HttpError, ok } from "@/lib/http";
import { withTransaction } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import type { RequestCancelled } from "@/lib/request-types";
import { logRequestEvent, requireRequestAccess } from "@/lib/requests";
import { requestIdParams } from "@/lib/validators/requests";

// POST /api/requests/[id]/cancel -> RequestCancelled (docs/HANDOFF.md P2.2)
// ADMIN, COORDINATOR, and the FIELD_OFFICER who owns it.

type ItemLock = RowDataPacket & { quantity_allocated: number };
type RequestState = RowDataPacket & { status: RequestStatus; emergency_status: EmergencyStatus };

/*
 * One transaction, locking in the same order as an allocation (HANDOFF 4.4):
 * items -> request -> emergency (shared). Cancelling with a bare UPDATE would
 * lock items one by one with the request in between, and deadlock against an
 * allocation to one of them, so every item is locked first.
 *
 * Once the items are locked, quantity_allocated can't change: an allocation
 * has either committed (a locking read sees it) or is waiting behind these
 * locks. That makes it a safe test for "any RESERVED, DISPATCHED or DELIVERED
 * allocation", and it needs no read of allocation. It's checked here rather
 * than left to trg_item_bu for the wording: the trigger says to cancel the
 * allocations first, which a DELIVERED one can't be. The trigger stays as the
 * backstop.
 *
 * Only the items are written. trg_item_au rolls the request up to CANCELLED.
 */
export const POST = handle<RouteContext<"/api/requests/[id]/cancel">>(async (_req, ctx) => {
  const session = await requireRole("ADMIN", "COORDINATOR", "FIELD_OFFICER");
  const { id } = requestIdParams.parse(await ctx.params);
  const { emergency_id: emergencyId } = await requireRequestAccess(session, id);

  await withTransaction(async (conn) => {
    const [items] = await conn.query<ItemLock[]>(
      "SELECT request_item_id, quantity_allocated FROM request_item WHERE request_id = ? ORDER BY request_item_id FOR UPDATE",
      [id],
    );
    const [states] = await conn.query<RequestState[]>(
      `SELECT r.status, e.status AS emergency_status
         FROM resource_request r
         JOIN emergency_impact ei ON ei.impact_id   = r.impact_id
         JOIN emergency e         ON e.emergency_id = ei.emergency_id
        WHERE r.request_id = ?
          FOR UPDATE OF r
          FOR SHARE OF e`,
      [id],
    );
    const state = states[0];
    if (!state) throw new HttpError(404, `Request ${id} not found`); // requests are never deleted by the app

    // The trigger treats CANCELLED -> CANCELLED as a no-op, so only this check refuses a repeat.
    if (state.status === "CANCELLED") {
      throw new HttpError(409, "This request is already cancelled", { code: "RULE" });
    }
    // CLOSED is final (P2.1): a closed emergency's records don't change.
    if (state.emergency_status === "CLOSED") {
      throw new HttpError(409, "This emergency is closed, so its requests can't be cancelled", { code: "RULE" });
    }
    if (items.some((item) => item.quantity_allocated > 0)) {
      throw new HttpError(409, "This request has reserved, dispatched or delivered allocations, so it can't be cancelled.", {
        code: "RULE",
      });
    }

    await conn.query("UPDATE request_item SET status = 'CANCELLED' WHERE request_id = ?", [id]);
  });

  await logRequestEvent(session, "REQUEST_CANCELLED", id, emergencyId);
  return ok({ request_id: id, status: "CANCELLED" } satisfies RequestCancelled);
});
