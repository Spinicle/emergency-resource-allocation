import { updateUser } from "@/lib/admin-users";
import { handle, ok, parseJson } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { adminIdParams, updateUserSchema } from "@/lib/validators/admin";

// PATCH /api/admin/users/[id] { role, center_id } or { is_active } -> AdminUserRow

export const PATCH = handle(async (req, ctx: RouteContext<"/api/admin/users/[id]">) => {
  const session = await requireRole("ADMIN");
  const { id } = adminIdParams.parse(await ctx.params);
  return ok(await updateUser(session, id, await parseJson(req, updateUserSchema)));
});
