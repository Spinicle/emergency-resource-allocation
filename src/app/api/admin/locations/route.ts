import { createLocation, listLocations } from "@/lib/admin-catalogue";
import { handle, ok, parseJson } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { createLocationSchema } from "@/lib/validators/admin";

// /api/admin/locations (docs/HANDOFF.md P2.6)
//   GET  -> AdminLocationRow[]
//   POST -> 201 { location_id }

export const GET = handle(async () => {
  await requireRole("ADMIN");
  return ok(await listLocations());
});

export const POST = handle(async (req) => {
  const session = await requireRole("ADMIN");
  return ok(await createLocation(session, await parseJson(req, createLocationSchema)), 201);
});
