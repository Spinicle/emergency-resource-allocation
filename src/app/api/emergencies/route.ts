import { fieldError, logEmergencyEvent, scopeParams, scopeSql } from "@/lib/emergencies";
import type { EmergencyCreated, EmergencyRow } from "@/lib/emergency-types";
import { handle, ok, parseJson, parseQuery } from "@/lib/http";
import { execute, query, queryOne } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { toBooleanQuery } from "@/lib/search";
import { createEmergencySchema, emergencyListQuery } from "@/lib/validators/emergencies";

// /api/emergencies (docs/HANDOFF.md P2.1)
//   GET  ?status=&type=&q=  -> EmergencyRow[]  (ADMIN, COORDINATOR, FIELD_OFFICER)
//   POST                    -> 201 { emergency_id }  (ADMIN, COORDINATOR)

export const GET = handle(async (req) => {
  const session = await requireRole("ADMIN", "COORDINATOR", "FIELD_OFFICER");
  const { status, type, q } = parseQuery(req, emergencyListQuery);

  // WHERE is built only from the constant fragments below; every user value
  // goes through a `?` placeholder.
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push("e.status = ?");
    params.push(status);
  }
  if (type) {
    where.push("e.type = ?");
    params.push(type);
  }
  if (q) {
    // Boolean mode has its own operator syntax (--, +, "…" are errors there), so
    // only the words are kept (lib/search.ts). Nothing searchable left, as with
    // T17's `' OR 1=1 --`: nothing can match, so no query runs.
    const terms = toBooleanQuery(q);
    if (!terms) return ok([]);
    where.push("MATCH(e.name, e.description) AGAINST (? IN BOOLEAN MODE)");
    params.push(terms);
  }

  // Correlated subqueries count per emergency; joining both child tables and
  // grouping would multiply the rows. A Field Officer counts only their own requests.
  const rows = await query<EmergencyRow>(
    `SELECT e.emergency_id, e.name, e.type, e.status, e.start_time, e.end_time,
            (SELECT COUNT(*) FROM emergency_impact ei
              WHERE ei.emergency_id = e.emergency_id) AS impact_count,
            (SELECT COUNT(*) FROM resource_request rr
               JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
              WHERE ei.emergency_id = e.emergency_id AND ${scopeSql("rr")}) AS request_count
       FROM emergency e
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.status = 'CLOSED', e.start_time DESC, e.emergency_id DESC`,
    [...scopeParams(session), ...params],
  );
  return ok(rows);
});

export const POST = handle(async (req) => {
  const session = await requireRole("ADMIN", "COORDINATOR");
  const { name, type, start_time, description } = await parseJson(req, createEmergencySchema);

  // Closing later sets end_time = NOW(), which chk_emergency_time needs to be
  // >= start_time, so a future start is refused. MySQL's clock decides.
  if (start_time) {
    const check = await queryOne<{ future: number }>("SELECT ? > NOW() AS future", [start_time]);
    if (check?.future) throw fieldError("start_time", "The start time can't be in the future");
  }

  const result = await execute(
    `INSERT INTO emergency (name, type, start_time, status, description)
     VALUES (?, ?, COALESCE(?, NOW()), 'ACTIVE', ?)`,
    [name, type, start_time ?? null, description ?? null],
  );
  const emergencyId = result.insertId;

  await logEmergencyEvent(session, "EMERGENCY_CREATED", { type: "EMERGENCY", id: emergencyId }, emergencyId, {
    name,
    type,
  });
  return ok({ emergency_id: emergencyId } satisfies EmergencyCreated, 201);
});
