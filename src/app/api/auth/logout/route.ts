import { endSession } from "@/lib/auth";
import { handle, ok } from "@/lib/http";

// POST /api/auth/logout -> { data: null } and an expired session cookie.
// Exempt from the proxy's sign-in check, so a bad or expired cookie can still be cleared.
export const POST = handle(async () => {
  await endSession();
  return ok(null);
});
