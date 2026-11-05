import type { SuggestionRow } from "@/lib/allocation-types";
import { handle, ok, parseQuery } from "@/lib/http";
import { callRows } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import { itemQuery } from "@/lib/validators/allocations";

// GET /api/allocations/suggestions?item=<id> (docs/HANDOFF.md 4.9): usable
// batches for one item, nearest first then earliest expiry, with a suggested
// split. Empty when the item isn't open; an unknown item is the procedure's
// 409 "Request item <id> not found".

export const GET = handle(async (req) => {
  await requireRole("ADMIN", "COORDINATOR");
  const { item } = parseQuery(req, itemQuery);
  return ok(await callRows<SuggestionRow>("CALL sp_suggest_batches(?)", [item]));
});
