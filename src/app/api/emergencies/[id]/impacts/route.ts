import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { emergencyNotFound, logEmergencyEvent } from "@/lib/emergencies";
import type { ImpactCreated } from "@/lib/emergency-types";
import { handle, HttpError, ok, parseJson } from "@/lib/http";
import { withTransaction } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { createImpactSchema, emergencyIdParams } from "@/lib/validators/emergencies";

// POST /api/emergencies/[id]/impacts (docs/HANDOFF.md P2.1), ADMIN and COORDINATOR.
//   { grid_id, latitude, longitude } -> 201 ImpactCreated

type LocationRow = RowDataPacket & { location_id: number; grid_id: string; latitude: number; longitude: number };

const FIND_LOCATION = "SELECT location_id, grid_id, latitude, longitude FROM location WHERE grid_id = ?";
const FIND_LOCATION_LOCKED = "SELECT location_id, grid_id, latitude, longitude FROM location WHERE grid_id = ? FOR SHARE";

const isDuplicate = (err: unknown) => (err as { errno?: unknown } | null)?.errno === 1062;

/*
 * One transaction: lock the emergency (FOR SHARE, so a concurrent close waits
 * and a CLOSED one is refused), find or create the location by grid_id, then
 * add the impact. If the impact fails, a location created for it rolls back too.
 *
 * An existing grid_id keeps its stored coordinates (a grid cell has one
 * position, and centers share the table); the response returns them and
 * location_created: false. Lookups ignore case, so the stored spelling is the one
 * reported and logged, not what was typed.
 */
export const POST = handle<RouteContext<"/api/emergencies/[id]/impacts">>(async (req, ctx) => {
  const session = await requireRole("ADMIN", "COORDINATOR");
  const { id: emergencyId } = emergencyIdParams.parse(await ctx.params);
  const { grid_id, latitude, longitude } = await parseJson(req, createImpactSchema);

  const created = await withTransaction<ImpactCreated>(async (conn) => {
    const [emergencies] = await conn.query<RowDataPacket[]>(
      "SELECT status FROM emergency WHERE emergency_id = ? FOR SHARE",
      [emergencyId],
    );
    if (emergencies.length === 0) throw emergencyNotFound(emergencyId);
    if (emergencies[0].status === "CLOSED") {
      throw new HttpError(409, "This emergency is closed, so it takes no new impacts", { code: "RULE" });
    }

    const findLocation = async (sql: string) => {
      const [rows] = await conn.query<LocationRow[]>(sql, [grid_id]);
      return rows[0];
    };

    let location = await findLocation(FIND_LOCATION);
    let locationCreated = false;
    if (!location) {
      try {
        const [inserted] = await conn.query<ResultSetHeader>(
          "INSERT INTO location (grid_id, latitude, longitude) VALUES (?, ?, ?)",
          [grid_id, latitude, longitude],
        );
        location = { location_id: inserted.insertId, grid_id, latitude, longitude } as LocationRow;
        locationCreated = true;
      } catch (err) {
        // Someone else created this grid_id since the SELECT. A failed statement
        // doesn't end the transaction; a locking read sees their committed row
        // (a plain one would read this transaction's older snapshot).
        if (!isDuplicate(err)) throw err;
        location = await findLocation(FIND_LOCATION_LOCKED);
        if (!location) throw err;
      }
    }

    try {
      const [impact] = await conn.query<ResultSetHeader>(
        "INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (?, ?, 'ACTIVE')",
        [emergencyId, location.location_id],
      );
      return {
        impact_id: impact.insertId,
        location_id: location.location_id,
        location_created: locationCreated,
        grid_id: location.grid_id,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
      };
    } catch (err) {
      // uq_emergency_location is the only unique key this INSERT can hit.
      if (isDuplicate(err)) {
        throw new HttpError(409, `${location.grid_id} is already an impact of this emergency`, { code: "DUPLICATE" });
      }
      throw err;
    }
  });

  await logEmergencyEvent(session, "IMPACT_ADDED", { type: "IMPACT", id: created.impact_id }, emergencyId, {
    grid_id: created.grid_id,
    location_created: created.location_created,
  });
  return ok(created, 201);
});
