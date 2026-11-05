import type { RowDataPacket } from "mysql2/promise";
import { logEmergencyEvent } from "@/lib/emergencies";
import type { ImpactUpdated } from "@/lib/emergency-types";
import type { EmergencyStatus, ImpactStatus } from "@/lib/enums";
import { handle, HttpError, ok, parseJson } from "@/lib/http";
import { withTransaction } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { impactIdParams, updateImpactSchema } from "@/lib/validators/emergencies";

// PATCH /api/impacts/[id] (docs/HANDOFF.md P2.1), ADMIN and COORDINATOR.
//   { status } -> ImpactUpdated

type Row = RowDataPacket & {
  emergency_id: number;
  status: ImpactStatus;
  emergency_status: EmergencyStatus;
  grid_id: string;
};

/*
 * One transaction: the impact row FOR UPDATE and its emergency FOR SHARE (so a
 * concurrent close waits). A CLOSED emergency's impacts are frozen, like the
 * emergency itself. Setting the status it already has is a no-op.
 */
export const PATCH = handle<RouteContext<"/api/impacts/[id]">>(async (req, ctx) => {
  const session = await requireRole("ADMIN", "COORDINATOR");
  const { id } = impactIdParams.parse(await ctx.params);
  const { status } = await parseJson(req, updateImpactSchema);

  const result = await withTransaction(async (conn) => {
    const [rows] = await conn.query<Row[]>(
      `SELECT ei.emergency_id, ei.status, e.status AS emergency_status, l.grid_id
         FROM emergency_impact ei
         JOIN emergency e ON e.emergency_id = ei.emergency_id
         JOIN location l  ON l.location_id  = ei.location_id
        WHERE ei.impact_id = ?
          FOR UPDATE OF ei
          FOR SHARE OF e`,
      [id],
    );
    const impact = rows[0];
    if (!impact) throw new HttpError(404, `Impact ${id} not found`);
    if (impact.emergency_status === "CLOSED") {
      throw new HttpError(409, "This emergency is closed, so its impacts can't change", { code: "RULE" });
    }
    if (impact.status !== status) {
      await conn.query("UPDATE emergency_impact SET status = ? WHERE impact_id = ?", [status, id]);
    }
    return impact;
  });

  if (result.status !== status) {
    await logEmergencyEvent(session, "IMPACT_UPDATED", { type: "IMPACT", id }, result.emergency_id, {
      grid_id: result.grid_id,
      from: result.status,
      to: status,
    });
  }
  return ok({ impact_id: id, status } satisfies ImpactUpdated);
});
