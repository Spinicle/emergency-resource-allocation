import { loadGap } from "@/lib/analytics";
import { handle, ok, parseQuery } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { gapQuery } from "@/lib/validators/analytics";

// GET /api/analytics/gap?emergency= -> GapData (docs/HANDOFF.md P2.5)

export const GET = handle(async (req) => {
  await requireRole("ADMIN", "COORDINATOR");
  const { emergency } = parseQuery(req, gapQuery);
  return ok(await loadGap(emergency));
});
