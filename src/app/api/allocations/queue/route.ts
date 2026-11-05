import type { QueueRow } from "@/lib/allocation-types";
import { handle, ok } from "@/lib/http";
import { query } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";

// GET /api/allocations/queue (docs/HANDOFF.md 4.9): every open item, best first.
// Each part's contribution comes from fn_priority_from_parts with the other
// parts at 0, so the weights live only in SQL. usable_qty counts usable stock
// at centers that aren't CLOSED (the centers allocations may come from).

export const GET = handle(async () => {
  await requireRole("ADMIN", "COORDINATOR");
  const rows = await query<QueueRow>(
    `SELECT q.*,
            fn_priority_from_parts(q.u_part, 0, 0, 0, 0) AS u_points,
            fn_priority_from_parts(0, q.s_part, 0, 0, 0) AS s_points,
            fn_priority_from_parts(0, 0, q.a_part, 0, 0) AS a_points,
            fn_priority_from_parts(0, 0, 0, q.w_part, 0) AS w_points,
            fn_priority_from_parts(0, 0, 0, 0, q.d_part) AS d_points,
            COALESCE(av.usable_qty, 0) AS usable_qty
       FROM v_priority_queue q
       LEFT JOIN (SELECT resource_id, SUM(usable_quantity) AS usable_qty
                    FROM v_stock_availability
                   WHERE center_status <> 'CLOSED'
                   GROUP BY resource_id) av ON av.resource_id = q.resource_id
      ORDER BY q.priority_score DESC, q.required_by IS NULL, q.required_by, q.requested_at, q.request_item_id`,
  );
  return ok(rows);
});
