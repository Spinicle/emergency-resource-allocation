import { ACTIVITY_LOG } from "@db/mongo/activity_log";
import type { ActivityEntry } from "@/lib/activity";
import { handle, ok } from "@/lib/http";
import { dateToIst } from "@/lib/ist";
import { getDb } from "@/lib/mongo";
import { query } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import {
  type RequestAllocationRow,
  type RequestDetail,
  type RequestItemRow,
  TIMELINE_LIMIT,
  type TimelineEntry,
} from "@/lib/request-types";
import { requireRequestAccess } from "@/lib/requests";
import { requestIdParams } from "@/lib/validators/requests";

// GET /api/requests/[id] -> RequestDetail (docs/HANDOFF.md P2.2)
// ADMIN, COORDINATOR, and the FIELD_OFFICER who owns it.

/**
 * The request's history, newest first. refs.request_id also finds its
 * allocation events; index { "refs.request_id": 1, ts: -1 } serves both the
 * filter and the sort. MongoDB unreachable -> 503 through handle(), for the
 * whole route, as on every route (HANDOFF 4.6).
 */
async function loadTimeline(requestId: number): Promise<{ timeline: TimelineEntry[]; timeline_total: number }> {
  const db = await getDb();
  const log = db.collection<ActivityEntry>(ACTIVITY_LOG);
  const filter = { "refs.request_id": requestId };
  const [entries, timeline_total] = await Promise.all([
    log.find(filter).sort({ ts: -1 }).limit(TIMELINE_LIMIT).toArray(),
    log.countDocuments(filter),
  ]);
  return {
    timeline_total,
    timeline: entries.map((e) => ({
      // MongoDB holds a UTC instant; the page shows every time as IST wall clock.
      ts: dateToIst(e.ts),
      action: e.action,
      actor_name: e.actor.name,
      entity_id: e.entity.id,
      payload: e.payload ?? null,
    })),
  };
}

export const GET = handle<RouteContext<"/api/requests/[id]">>(async (_req, ctx) => {
  const session = await requireRole("ADMIN", "COORDINATOR", "FIELD_OFFICER");
  const { id } = requestIdParams.parse(await ctx.params);
  const request = await requireRequestAccess(session, id);

  const [items, allocations, history] = await Promise.all([
    // quantity_allocated is the sum of the item's non-cancelled allocations,
    // kept by the allocation triggers (HANDOFF 4.4), so there's nothing to re-sum.
    query<RequestItemRow>(
      `SELECT ri.request_item_id, ri.resource_id, res.name AS resource_name, res.unit,
              ri.quantity_requested, ri.quantity_allocated,
              ri.quantity_requested - ri.quantity_allocated AS quantity_remaining,
              ri.urgency, ri.status
         FROM request_item ri
         JOIN resource res ON res.resource_id = ri.resource_id
        WHERE ri.request_id = ?
        ORDER BY FIELD(ri.urgency, 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'), ri.request_item_id`,
      [id],
    ),
    query<RequestAllocationRow>(
      `SELECT a.allocation_id, a.request_item_id, res.name AS resource_name, res.unit,
              a.quantity_allocated, a.status, a.allocated_at,
              s.batch_code, s.expiry_date, c.name AS center_name, u.name AS allocated_by
         FROM allocation a
         JOIN request_item ri   ON ri.request_item_id = a.request_item_id
         JOIN resource res      ON res.resource_id    = ri.resource_id
         JOIN stock s           ON s.stock_id         = a.stock_id
         JOIN resource_center c ON c.center_id        = s.center_id
         JOIN \`user\` u        ON u.user_id          = a.user_id
        WHERE ri.request_id = ?
        ORDER BY a.allocated_at, a.allocation_id`,
      [id],
    ),
    loadTimeline(id),
  ]);

  return ok({ request, items, allocations, ...history } satisfies RequestDetail);
});
