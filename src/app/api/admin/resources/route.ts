import { createResource, listResources } from "@/lib/admin-catalogue";
import { handle, ok, parseJson } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { createResourceSchema } from "@/lib/validators/admin";

// /api/admin/resources (docs/HANDOFF.md P2.6)
//   GET  -> AdminResourceRow[]
//   POST -> 201 { resource_id }

export const GET = handle(async () => {
  await requireRole("ADMIN");
  return ok(await listResources());
});

export const POST = handle(async (req) => {
  const session = await requireRole("ADMIN");
  return ok(await createResource(session, await parseJson(req, createResourceSchema)), 201);
});
