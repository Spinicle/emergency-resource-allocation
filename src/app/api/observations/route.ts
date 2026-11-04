import { fileFieldReport } from "@db/mongo/field_reports";
import type { EmergencyStatus, EmergencyType } from "@/lib/enums";
import { handle, HttpError, ok, parseJson } from "@/lib/http";
import { getDb } from "@/lib/mongo";
import { getPool, queryOne } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { observationSchema } from "@/lib/validators/observations";

// POST /api/observations (docs/HANDOFF.md 4.4): a field report. Writes the
// impact_observation row in MySQL, then its field_reports document, undoing
// the row if the document fails. -> 201 { data: { observation_id, reported_at } }
//
// Errors from either database are mapped by handle(): MongoDB unreachable 503,
// validator 400, two reports for one impact in the same second 409 DUPLICATE.

type ImpactRow = {
  emergency_id: number;
  type: EmergencyType;
  status: EmergencyStatus;
  latitude: number;
  longitude: number;
};

export const POST = handle(async (req) => {
  const session = await requireRole("ADMIN", "COORDINATOR", "FIELD_OFFICER");
  const { impact_id, affected_percentage, severity, location, ...report } = await parseJson(req, observationSchema);

  const impact = await queryOne<ImpactRow>(
    `SELECT ei.emergency_id, e.type, e.status, l.latitude, l.longitude
       FROM emergency_impact ei
       JOIN emergency e ON e.emergency_id = ei.emergency_id
       JOIN location l  ON l.location_id  = ei.location_id
      WHERE ei.impact_id = ?`,
    [impact_id],
  );
  if (!impact) throw new HttpError(404, "That impact doesn't exist");
  if (report.emergency_type !== impact.type) {
    throw new HttpError(400, "Check the highlighted fields", {
      code: "VALIDATION",
      fields: { emergency_type: `This impact belongs to a ${impact.type} emergency` },
    });
  }
  // An app rule, not a DB one: a CLOSED emergency takes no new reports.
  if (impact.status === "CLOSED") {
    throw new HttpError(409, "This emergency is closed, so it takes no new reports", { code: "RULE" });
  }

  const filed = await fileFieldReport(await getDb(), getPool(), {
    impact_id,
    emergency_id: impact.emergency_id,
    affected_percentage,
    severity,
    reported_by: { user_id: session.userId, name: session.name, role: session.role },
    location: location ?? { lat: impact.latitude, lng: impact.longitude },
    report,
  });
  return ok(filed, 201);
});
