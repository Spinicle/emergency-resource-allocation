import "server-only";
import type { Session } from "@/lib/auth";
import { HttpError } from "@/lib/http";
import { logActivity } from "@/lib/mongo";
import { queryOne } from "@/lib/mysql";
import type { RequestHeader } from "@/lib/request-types";

// Shared by /api/requests/[id] and its cancel route (docs/HANDOFF.md P2.2).

/**
 * The request's header if this user may see it: 404 if it doesn't exist, 403
 * for a Field Officer opening someone else's. A plain read, never a lock: the
 * owner and impact of a request never change, and locking here would put the
 * request row ahead of its items, against cancel's lock order.
 */
export async function requireRequestAccess(session: Session, id: number): Promise<RequestHeader> {
  const row = await queryOne<RequestHeader & { user_id: number }>(
    `SELECT r.request_id, r.user_id, r.status, r.requested_at, r.required_by, r.description, r.impact_id,
            l.grid_id, e.emergency_id, e.name AS emergency_name, e.status AS emergency_status,
            u.name AS requested_by
       FROM resource_request r
       JOIN emergency_impact ei ON ei.impact_id   = r.impact_id
       JOIN emergency e         ON e.emergency_id = ei.emergency_id
       JOIN location l          ON l.location_id  = ei.location_id
       JOIN \`user\` u          ON u.user_id      = r.user_id
      WHERE r.request_id = ?`,
    [id],
  );
  if (!row) throw new HttpError(404, `Request ${id} not found`);
  const { user_id: ownerId, ...header } = row;
  if (session.role === "FIELD_OFFICER" && ownerId !== session.userId) {
    throw new HttpError(403, "You don't have access to this");
  }
  return header;
}

/** One activity_log entry for a request, in the backfill's shape. After the commit; never throws. */
export function logRequestEvent(
  session: Session,
  action: "REQUEST_CREATED" | "REQUEST_CANCELLED",
  requestId: number,
  emergencyId: number,
): Promise<void> {
  return logActivity({
    actor: session,
    action,
    entity: { type: "REQUEST", id: requestId },
    refs: { request_id: requestId, emergency_id: emergencyId },
  });
}
