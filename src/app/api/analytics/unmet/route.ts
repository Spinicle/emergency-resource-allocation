import { loadUnmet } from "@/lib/analytics";
import { handle, ok, parseQuery } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { unmetQuery } from "@/lib/validators/analytics";

// GET /api/analytics/unmet?emergency= -> UnmetRow[] (docs/HANDOFF.md P2.5)

export const GET = handle(async (req) => {
  await requireRole("ADMIN", "COORDINATOR");
  const { emergency } = parseQuery(req, unmetQuery);
  return ok(await loadUnmet(emergency));
});
