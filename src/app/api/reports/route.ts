import { handle, ok, parseQuery } from "@/lib/http";
import { requireRole } from "@/lib/rbac";
import { listReports } from "@/lib/reports";
import { reportListQuery } from "@/lib/validators/reports";

// GET /api/reports?emergency=&type=&q=&near=lat,lng&km= -> ReportList
// (docs/HANDOFF.md P2.3). Every field-side role reads every report: field
// information is shared, unlike requests.

export const GET = handle(async (req) => {
  await requireRole("ADMIN", "COORDINATOR", "FIELD_OFFICER");
  return ok(await listReports(parseQuery(req, reportListQuery)));
});
