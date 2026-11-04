import "server-only";
import { getSession, type Role, type Session } from "@/lib/auth";
import { HttpError } from "@/lib/http";

// Access checks for Route Handlers (docs/HANDOFF.md 4.5). Call one of these
// first in every handler, once per request: each reads the database.

/** The signed-in user. Throws HttpError 401 if there is none. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Sign in to continue");
  return session;
}

/**
 * The signed-in user, if their role is one of roles. Throws HttpError 401 if
 * signed out, 403 if the role isn't listed. ADMIN is never implied: list it.
 */
export async function requireRole(...roles: [Role, ...Role[]]): Promise<Session> {
  const session = await requireSession();
  if (!roles.includes(session.role)) throw new HttpError(403, "You don't have access to this");
  return session;
}
