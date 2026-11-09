import { deleteResource, updateResource } from "@/lib/admin-catalogue";
import { handle, ok, parseJson } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { adminIdParams, updateResourceSchema } from "@/lib/validators/admin";

// /api/admin/resources/[id] (docs/HANDOFF.md P2.6): PATCH, DELETE -> null

export const PATCH = handle(async (req, ctx: RouteContext<"/api/admin/resources/[id]">) => {
  const session = await requireRole("ADMIN");
  const { id } = adminIdParams.parse(await ctx.params);
  await updateResource(session, id, await parseJson(req, updateResourceSchema));
  return ok(null);
});

export const DELETE = handle(async (_req, ctx: RouteContext<"/api/admin/resources/[id]">) => {
  const session = await requireRole("ADMIN");
  const { id } = adminIdParams.parse(await ctx.params);
  await deleteResource(session, id);
  return ok(null);
});
