import type { LocationRow } from "@/lib/admin-types";
import { listLocations } from "@/lib/admin-catalogue";
import { handle, ok } from "@/lib/http";
import { requireRole } from "@/lib/rbac";

// GET /api/locations, ADMIN and COORDINATOR: every location, ordered by grid id,
// for the location picker (Add impact, admin Locations). The admin list's query
// without its usage counts.
//   GET -> LocationRow[]

export const GET = handle(async () => {
  await requireRole("ADMIN", "COORDINATOR");
  const rows = await listLocations();
  return ok(rows.map(({ location_id, grid_id, latitude, longitude }): LocationRow => ({ location_id, grid_id, latitude, longitude })));
});
