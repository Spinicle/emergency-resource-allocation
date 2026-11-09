import { createUser, listUsers } from "@/lib/admin-users";
import { handle, ok, parseJson } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { createUserSchema } from "@/lib/validators/admin";

// /api/admin/users (docs/HANDOFF.md P2.6)
//   GET  -> AdminUserRow[]
//   POST -> 201 AdminUserRow

export const GET = handle(async () => {
  await requireRole("ADMIN");
  return ok(await listUsers());
});

export const POST = handle(async (req) => {
  const session = await requireRole("ADMIN");
  return ok(await createUser(session, await parseJson(req, createUserSchema)), 201);
});
