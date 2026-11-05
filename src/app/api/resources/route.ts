import { handle, ok } from "@/lib/http";
import { query } from "@/lib/mysql";
import { requireSession } from "@/lib/rbac";
import type { ResourceRow } from "@/lib/stock-types";

// GET /api/resources (docs/HANDOFF.md 4.10): the resource catalogue for forms
// (P2.2's request items, P2.6's add-batch). Any signed-in role; editing the
// catalogue is /api/admin/* (P2.6, ADMIN only).

export const GET = handle(async () => {
  await requireSession();
  return ok(await query<ResourceRow>("SELECT resource_id, name, category, unit FROM resource ORDER BY name"));
});
