import "server-only";
import type { AdminCenterRow, AdminLocationRow, AdminResourceRow } from "@/lib/admin-types";
import type { Session } from "@/lib/auth";
import { HttpError } from "@/lib/http";
import { logActivity } from "@/lib/mongo";
import { execute, query, queryOne, withTransaction } from "@/lib/mysql";
import type {
  CreateCenterInput,
  CreateLocationInput,
  CreateResourceInput,
  UpdateCenterInput,
  UpdateLocationInput,
  UpdateResourceInput,
} from "@/lib/validators/admin";

// /api/admin/resources, /centers and /locations (docs/HANDOFF.md P2.6). A delete
// of a row still in use fails on its foreign key, which handle() maps to 409
// IN_USE (era_app gets error 1217). Edit locks are checked after a FOR UPDATE on
// the row: a concurrent insert of a child row takes a shared lock on it for its
// foreign key check, so it waits, and one already committed is seen.

const rule = (message: string) => new HttpError(409, message, { code: "RULE" });

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export function listResources(): Promise<AdminResourceRow[]> {
  return query<AdminResourceRow>(
    `SELECT r.resource_id, r.name, r.category, r.unit,
            (SELECT COUNT(*) FROM stock s WHERE s.resource_id = r.resource_id) AS stock_count,
            (SELECT COUNT(*) FROM request_item ri WHERE ri.resource_id = r.resource_id) AS item_count
       FROM resource r
      ORDER BY r.name`,
  );
}

export async function createResource(session: Session, input: CreateResourceInput): Promise<{ resource_id: number }> {
  const { insertId } = await execute("INSERT INTO resource (name, category, unit) VALUES (?, ?, ?)", [input.name, input.category, input.unit]);
  await logActivity({ actor: session, action: "RESOURCE_CREATED", entity: { type: "RESOURCE", id: insertId }, payload: { name: input.name } });
  return { resource_id: insertId };
}

/** Field reports and requests match a resource by name and unit, so both lock once it's used. */
export async function updateResource(session: Session, id: number, input: UpdateResourceInput): Promise<void> {
  const name = await withTransaction(async (conn) => {
    const current = await queryOne<{ name: string; unit: string }>("SELECT name, unit FROM resource WHERE resource_id = ? FOR UPDATE", [id], conn);
    if (!current) throw new HttpError(404, `Resource ${id} not found`);
    const changesIdentity = (input.name !== undefined && input.name !== current.name) || (input.unit !== undefined && input.unit !== current.unit);
    if (changesIdentity) {
      const used = await queryOne<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM stock WHERE resource_id = ?) + (SELECT COUNT(*) FROM request_item WHERE resource_id = ?) AS n`,
        [id, id],
        conn,
      );
      if (Number(used?.n ?? 0) > 0) throw rule("This resource has stock or requests, so its name and unit can't change");
    }
    await conn.query("UPDATE resource SET name = COALESCE(?, name), category = COALESCE(?, category), unit = COALESCE(?, unit) WHERE resource_id = ?", [
      input.name ?? null,
      input.category ?? null,
      input.unit ?? null,
      id,
    ]);
    return input.name ?? current.name;
  });
  await logActivity({ actor: session, action: "RESOURCE_UPDATED", entity: { type: "RESOURCE", id }, payload: { name } });
}

export async function deleteResource(session: Session, id: number): Promise<void> {
  const current = await queryOne<{ name: string }>("SELECT name FROM resource WHERE resource_id = ?", [id]);
  if (!current) throw new HttpError(404, `Resource ${id} not found`);
  const { affectedRows } = await execute("DELETE FROM resource WHERE resource_id = ?", [id]);
  if (affectedRows === 0) throw new HttpError(404, `Resource ${id} not found`);
  await logActivity({ actor: session, action: "RESOURCE_DELETED", entity: { type: "RESOURCE", id }, payload: { name: current.name } });
}

// ---------------------------------------------------------------------------
// Centers
// ---------------------------------------------------------------------------

export function listCenters(): Promise<AdminCenterRow[]> {
  return query<AdminCenterRow>(
    `SELECT c.center_id, c.name, c.center_type, c.status, c.location_id, l.grid_id,
            (SELECT COUNT(*) FROM stock s WHERE s.center_id = c.center_id) AS batch_count,
            (SELECT COUNT(*) FROM \`user\` u WHERE u.center_id = c.center_id) AS user_count
       FROM resource_center c
       JOIN location l ON l.location_id = c.location_id
      ORDER BY c.name`,
  );
}

export async function createCenter(session: Session, input: CreateCenterInput): Promise<{ center_id: number }> {
  const { insertId } = await execute("INSERT INTO resource_center (location_id, name, center_type, status) VALUES (?, ?, ?, ?)", [
    input.location_id,
    input.name,
    input.center_type,
    input.status,
  ]);
  await logActivity({
    actor: session,
    action: "CENTER_CREATED",
    entity: { type: "CENTER", id: insertId },
    refs: { center_id: insertId },
    payload: { name: input.name, status: input.status },
  });
  return { center_id: insertId };
}

/** Closing or reopening is a plain status change: the trigger and views read the status when they run. */
export async function updateCenter(session: Session, id: number, input: UpdateCenterInput): Promise<void> {
  const after = await withTransaction(async (conn) => {
    const current = await queryOne<{ name: string; status: string }>("SELECT name, status FROM resource_center WHERE center_id = ? FOR UPDATE", [id], conn);
    if (!current) throw new HttpError(404, `Center ${id} not found`);
    await conn.query("UPDATE resource_center SET name = COALESCE(?, name), center_type = COALESCE(?, center_type), status = COALESCE(?, status) WHERE center_id = ?", [
      input.name ?? null,
      input.center_type ?? null,
      input.status ?? null,
      id,
    ]);
    return { name: input.name ?? current.name, status: input.status ?? current.status };
  });
  await logActivity({ actor: session, action: "CENTER_UPDATED", entity: { type: "CENTER", id }, refs: { center_id: id }, payload: after });
}

/**
 * fk_user_center is ON DELETE SET NULL, so deleting a center with no stock would
 * quietly leave its manager unable to sign in. Refuse while anyone is assigned.
 */
export async function deleteCenter(session: Session, id: number): Promise<void> {
  const name = await withTransaction(async (conn) => {
    const current = await queryOne<{ name: string }>("SELECT name FROM resource_center WHERE center_id = ? FOR UPDATE", [id], conn);
    if (!current) throw new HttpError(404, `Center ${id} not found`);
    const assigned = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM `user` WHERE center_id = ? FOR SHARE", [id], conn);
    if (Number(assigned?.n ?? 0) > 0) throw rule("This center still has a manager assigned. Move them to another center first");
    await conn.query("DELETE FROM resource_center WHERE center_id = ?", [id]);
    return current.name;
  });
  await logActivity({ actor: session, action: "CENTER_DELETED", entity: { type: "CENTER", id }, refs: { center_id: id }, payload: { name } });
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export function listLocations(): Promise<AdminLocationRow[]> {
  return query<AdminLocationRow>(
    `SELECT l.location_id, l.grid_id, l.latitude, l.longitude,
            (SELECT COUNT(*) FROM resource_center c WHERE c.location_id = l.location_id) AS center_count,
            (SELECT COUNT(*) FROM emergency_impact ei WHERE ei.location_id = l.location_id) AS impact_count
       FROM location l
      ORDER BY l.grid_id`,
  );
}

export async function createLocation(session: Session, input: CreateLocationInput): Promise<{ location_id: number }> {
  const { insertId } = await execute("INSERT INTO location (grid_id, latitude, longitude) VALUES (?, ?, ?)", [input.grid_id, input.latitude, input.longitude]);
  await logActivity({ actor: session, action: "LOCATION_CREATED", entity: { type: "LOCATION", id: insertId }, payload: { name: input.grid_id } });
  return { location_id: insertId };
}

/** Distances and stored field reports depend on a used location, so it locks whole. */
export async function updateLocation(session: Session, id: number, input: UpdateLocationInput): Promise<void> {
  const gridId = await withTransaction(async (conn) => {
    const current = await queryOne<{ grid_id: string; latitude: number; longitude: number }>(
      "SELECT grid_id, latitude, longitude FROM location WHERE location_id = ? FOR UPDATE",
      [id],
      conn,
    );
    if (!current) throw new HttpError(404, `Location ${id} not found`);
    const changes =
      (input.grid_id !== undefined && input.grid_id !== current.grid_id) ||
      (input.latitude !== undefined && input.latitude !== current.latitude) ||
      (input.longitude !== undefined && input.longitude !== current.longitude);
    if (changes) {
      const used = await queryOne<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM resource_center WHERE location_id = ?) + (SELECT COUNT(*) FROM emergency_impact WHERE location_id = ?) AS n`,
        [id, id],
        conn,
      );
      if (Number(used?.n ?? 0) > 0) throw rule("This location is used by a center or an impact, so it can't change");
    }
    await conn.query("UPDATE location SET grid_id = COALESCE(?, grid_id), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude) WHERE location_id = ?", [
      input.grid_id ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      id,
    ]);
    return input.grid_id ?? current.grid_id;
  });
  await logActivity({ actor: session, action: "LOCATION_UPDATED", entity: { type: "LOCATION", id }, payload: { name: gridId } });
}

export async function deleteLocation(session: Session, id: number): Promise<void> {
  const current = await queryOne<{ grid_id: string }>("SELECT grid_id FROM location WHERE location_id = ?", [id]);
  if (!current) throw new HttpError(404, `Location ${id} not found`);
  const { affectedRows } = await execute("DELETE FROM location WHERE location_id = ?", [id]);
  if (affectedRows === 0) throw new HttpError(404, `Location ${id} not found`);
  await logActivity({ actor: session, action: "LOCATION_DELETED", entity: { type: "LOCATION", id }, payload: { name: current.grid_id } });
}
