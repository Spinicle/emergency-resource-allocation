import { loadFulfilment } from "@/lib/analytics";
import { handle, ok } from "@/lib/http";
import { requireRole } from "@/lib/rbac";

// GET /api/analytics/fulfilment -> FulfilmentRow[] (docs/HANDOFF.md P2.5)

export const GET = handle(async () => {
  await requireRole("ADMIN", "COORDINATOR");
  return ok(await loadFulfilment());
});
