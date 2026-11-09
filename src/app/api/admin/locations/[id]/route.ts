import { deleteLocation, updateLocation } from "@/lib/admin-catalogue";
import { handle, ok, parseJson } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { adminIdParams, updateLocationSchema } from "@/lib/validators/admin";

// /api/admin/locations/[id] (docs/HANDOFF.md P2.6): PATCH, DELETE -> null

export const PATCH = handle(async (req, ctx: RouteContext<"/api/admin/locations/[id]">) => {
  const session = await requireRole("ADMIN");
  const { id } = adminIdParams.parse(await ctx.params);
  await updateLocation(session, id, await parseJson(req, updateLocationSchema));
  return ok(null);
});

export const DELETE = handle(async (_req, ctx: RouteContext<"/api/admin/locations/[id]">) => {
  const session = await requireRole("ADMIN");
  const { id } = adminIdParams.parse(await ctx.params);
  await deleteLocation(session, id);
  return ok(null);
});
