import { loadDashboard } from "@/lib/dashboard";
import { handle, ok } from "@/lib/http";
import { requireSession } from "@/lib/rbac";

// /api/dashboard (docs/HANDOFF.md P2.4)
//   GET -> DashboardData  (every role, scoped to it in lib/dashboard.ts)

export const GET = handle(async () => {
  const session = await requireSession();
  return ok(await loadDashboard(session));
});
