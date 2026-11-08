import { handle, ok } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { loadReport } from "@/lib/reports";
import { reportIdParams } from "@/lib/validators/reports";

// GET /api/reports/[id] -> ReportDetail (docs/HANDOFF.md P2.3). id is the
// observation_id: the unique link to MySQL and the activity entity id.

export const GET = handle<RouteContext<"/api/reports/[id]">>(async (_req, ctx) => {
  await requireRole("ADMIN", "COORDINATOR", "FIELD_OFFICER");
  const { id } = reportIdParams.parse(await ctx.params);
  return ok(await loadReport(id));
});
