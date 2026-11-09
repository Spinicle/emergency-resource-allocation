import { deleteCenter, updateCenter } from "@/lib/admin-catalogue";
import { handle, ok, parseJson } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { adminIdParams, updateCenterSchema } from "@/lib/validators/admin";

// /api/admin/centers/[id] (docs/HANDOFF.md P2.6): PATCH, DELETE -> null

export const PATCH = handle(async (req, ctx: RouteContext<"/api/admin/centers/[id]">) => {
  const session = await requireRole("ADMIN");
  const { id } = adminIdParams.parse(await ctx.params);
  await updateCenter(session, id, await parseJson(req, updateCenterSchema));
  return ok(null);
});

export const DELETE = handle(async (_req, ctx: RouteContext<"/api/admin/centers/[id]">) => {
  const session = await requireRole("ADMIN");
  const { id } = adminIdParams.parse(await ctx.params);
  await deleteCenter(session, id);
  return ok(null);
});
