import { handle, ok } from "@/lib/http";
import { requireSession } from "@/lib/rbac";

// GET /api/auth/me -> { data: Session }, or 401 if signed out.
export const GET = handle(async () => ok(await requireSession()));
