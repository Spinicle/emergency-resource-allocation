import { FIELD_REPORTS } from "@db/mongo/field_reports";
import type { RowDataPacket } from "mysql2/promise";
import {
  emergencyNotFound,
  fieldError,
  loadEmergencyHeader,
  logEmergencyEvent,
  scopeParams,
  scopeSql,
} from "@/lib/emergencies";
import {
  type EmergencyDetail,
  type EmergencyHeader,
  type ImpactRow,
  OBSERVATION_LIMIT,
  type ObservationRow,
} from "@/lib/emergency-types";
import { handle, HttpError, ok, parseJson } from "@/lib/http";
import { getDb } from "@/lib/mongo";
import { query, queryOne, withTransaction } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { emergencyIdParams, updateEmergencySchema } from "@/lib/validators/emergencies";

// /api/emergencies/[id] (docs/HANDOFF.md P2.1)
//   GET    -> EmergencyDetail  (ADMIN, COORDINATOR, FIELD_OFFICER)
//   PATCH  -> EmergencyHeader  (ADMIN, COORDINATOR): edit, or close with status "CLOSED"

type Ctx = RouteContext<"/api/emergencies/[id]">;

/** Columns PATCH may set from the body. A fixed list: column names never come from input. */
const EDITABLE = ["name", "type", "start_time", "description"] as const;

export const GET = handle<Ctx>(async (_req, ctx) => {
  const session = await requireRole("ADMIN", "COORDINATOR", "FIELD_OFFICER");
  const { id } = emergencyIdParams.parse(await ctx.params);

  const emergency = await loadEmergencyHeader(id);
  if (!emergency) throw emergencyNotFound(id);

  const scope = scopeParams(session);
  const [impacts, observations, observationTotal, counts, reports] = await Promise.all([
    // ROW_NUMBER numbers each impact's observations newest first, so rn = 1 is
    // the latest (uq_impact_observation_time makes it unique). The LEFT JOIN
    // keeps impacts with no observation yet: their latest_* are NULL.
    query<ImpactRow>(
      `WITH ranked AS (
         SELECT o.impact_id, o.severity, o.affected_percentage, o.observed_at,
                ROW_NUMBER() OVER (PARTITION BY o.impact_id ORDER BY o.observed_at DESC) AS rn
           FROM impact_observation o
           JOIN emergency_impact ei ON ei.impact_id = o.impact_id
          WHERE ei.emergency_id = ?
       )
       SELECT ei.impact_id, ei.status, l.location_id, l.grid_id, l.latitude, l.longitude,
              r.severity            AS latest_severity,
              r.affected_percentage AS latest_affected_pct,
              r.observed_at         AS latest_observed_at,
              (SELECT COUNT(*) FROM resource_request rr
                WHERE rr.impact_id = ei.impact_id AND ${scopeSql("rr")}) AS request_count
         FROM emergency_impact ei
         JOIN location l    ON l.location_id = ei.location_id
         LEFT JOIN ranked r ON r.impact_id = ei.impact_id AND r.rn = 1
        WHERE ei.emergency_id = ?
        ORDER BY l.grid_id`,
      [id, ...scope, id],
    ),
    query<ObservationRow>(
      `SELECT o.observation_id, o.impact_id, l.grid_id, o.observed_at, o.severity,
              o.affected_percentage, u.name AS observed_by
         FROM impact_observation o
         JOIN emergency_impact ei ON ei.impact_id  = o.impact_id
         JOIN location l          ON l.location_id = ei.location_id
         JOIN \`user\` u          ON u.user_id     = o.user_id
        WHERE ei.emergency_id = ?
        ORDER BY o.observed_at DESC, o.observation_id DESC
        LIMIT ?`,
      [id, OBSERVATION_LIMIT],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM impact_observation o
         JOIN emergency_impact ei ON ei.impact_id = o.impact_id
        WHERE ei.emergency_id = ?`,
      [id],
    ),
    // open_items: what leaves the allocation queue if the emergency closes.
    queryOne<{ requests: number; open_items: number }>(
      `SELECT COUNT(DISTINCT rr.request_id) AS requests,
              COUNT(CASE WHEN ri.status IN ('PENDING', 'PARTIAL') THEN 1 END) AS open_items
         FROM resource_request rr
         JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
         LEFT JOIN request_item ri ON ri.request_id = rr.request_id
        WHERE ei.emergency_id = ? AND ${scopeSql("rr")}`,
      [id, ...scope],
    ),
    // MongoDB unreachable -> 503 through handle() (HANDOFF 4.6), like every route.
    getDb().then((db) => db.collection(FIELD_REPORTS).countDocuments({ emergency_id: id })),
  ]);

  return ok({
    emergency,
    impacts,
    observations,
    counts: {
      observations: Number(observationTotal?.n ?? 0),
      requests: Number(counts?.requests ?? 0),
      open_items: Number(counts?.open_items ?? 0),
      reports,
    },
  } satisfies EmergencyDetail);
});

/*
 * One transaction with the emergency row locked (FOR UPDATE), so two edits,
 * or an edit and a new impact (which takes it FOR SHARE), queue.
 *
 * - CLOSED is final: a closed emergency can't change (its end_time also anchors
 *   the seed time that t_seed and mongo:test read for the Mysuru outbreak).
 * - The type is fixed once any impact has an observation: field reports store
 *   it and POST /api/observations requires a match. That route reads the type
 *   without a lock, so a report filed in the same instant as a type change can
 *   still slip through (known gap; closing it would mean changing Part 1's route).
 * - Times are compared by MySQL's clock. chk_emergency_time needs end_time >=
 *   start_time, so a future start is refused, and so is closing before the start.
 * - start_time can't move past the first observation: P2.3 keeps reports inside
 *   [start_time, end_time]. A report filed meanwhile is dated NOW(), which is
 *   never before an accepted start_time, so this needs no lock on observations.
 */
export const PATCH = handle<Ctx>(async (req, ctx) => {
  const session = await requireRole("ADMIN", "COORDINATOR");
  const { id } = emergencyIdParams.parse(await ctx.params);
  const body = await parseJson(req, updateEmergencySchema);

  const result = await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT name, type, status, start_time, description,
              start_time > NOW()                 AS not_started,
              (? IS NOT NULL AND ? > NOW())      AS new_start_future
         FROM emergency WHERE emergency_id = ? FOR UPDATE`,
      [body.start_time ?? null, body.start_time ?? null, id],
    );
    const current = rows[0] as
      | (Omit<EmergencyHeader, "emergency_id" | "end_time"> & { not_started: number; new_start_future: number })
      | undefined;
    if (!current) throw emergencyNotFound(id);
    if (current.status === "CLOSED") {
      throw new HttpError(409, "This emergency is closed, so it can't be changed", { code: "RULE" });
    }

    // Only fields that actually differ count as changes.
    const changed = EDITABLE.filter((c) => body[c] !== undefined && body[c] !== current[c]);
    const statusChanges = body.status !== undefined && body.status !== current.status;

    if (changed.includes("start_time") && current.new_start_future) {
      throw fieldError("start_time", "The start time can't be in the future");
    }
    if (changed.includes("start_time")) {
      // No observations: MIN is NULL, so nothing to refuse.
      const [first] = await conn.query<RowDataPacket[]>(
        `SELECT ? > MIN(o.observed_at) AS after_first
           FROM impact_observation o
           JOIN emergency_impact ei ON ei.impact_id = o.impact_id
          WHERE ei.emergency_id = ?`,
        [body.start_time, id],
      );
      if (first[0].after_first) {
        throw fieldError("start_time", "The start time can't be after the first observation");
      }
    }
    if (changed.includes("type")) {
      const [observed] = await conn.query<RowDataPacket[]>(
        `SELECT 1 FROM impact_observation o
           JOIN emergency_impact ei ON ei.impact_id = o.impact_id
          WHERE ei.emergency_id = ? LIMIT 1`,
        [id],
      );
      if (observed.length > 0) {
        throw new HttpError(409, "This emergency already has field observations, so its type can't change", {
          code: "RULE",
        });
      }
    }
    const closing = statusChanges && body.status === "CLOSED";
    // A new start_time here is already known not to be in the future.
    if (closing && !changed.includes("start_time") && current.not_started) {
      throw new HttpError(409, "This emergency hasn't started yet, so it can't be closed", { code: "RULE" });
    }

    const sets = changed.map((c) => `${c} = ?`);
    const params: unknown[] = changed.map((c) => body[c]);
    if (statusChanges) {
      sets.push("status = ?");
      params.push(body.status);
      if (closing) sets.push("end_time = NOW()");
    }
    if (sets.length > 0) {
      await conn.query(`UPDATE emergency SET ${sets.join(", ")} WHERE emergency_id = ?`, [...params, id]);
    }
    const header = await loadEmergencyHeader(id, conn);
    if (!header) throw emergencyNotFound(id); // unreachable: the row is locked
    return {
      header,
      changed: statusChanges ? [...changed, "status"] : [...changed],
      closing,
      status: statusChanges ? { from: current.status, to: header.status } : undefined,
    };
  });

  // Nothing differed: no write, no entry.
  if (result.changed.length > 0) {
    await logEmergencyEvent(
      session,
      result.closing ? "EMERGENCY_CLOSED" : "EMERGENCY_UPDATED",
      { type: "EMERGENCY", id },
      id,
      { name: result.header.name, changed: result.changed, ...(result.status && result.status) },
    );
  }
  return ok(result.header);
});
