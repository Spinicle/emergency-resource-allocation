import { createCenter, listCenters } from "@/lib/admin-catalogue";
import { handle, ok, parseJson } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { createCenterSchema } from "@/lib/validators/admin";

// /api/admin/centers (docs/HANDOFF.md P2.6)
//   GET  -> AdminCenterRow[]
//   POST -> 201 { center_id }

export const GET = handle(async () => {
  await requireRole("ADMIN");
  return ok(await listCenters());
});

export const POST = handle(async (req) => {
  const session = await requireRole("ADMIN");
  return ok(await createCenter(session, await parseJson(req, createCenterSchema)), 201);
});
