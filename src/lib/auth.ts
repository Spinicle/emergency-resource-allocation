import "server-only";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { cache } from "react";
import type { Role } from "@/lib/enums";
import { queryOne } from "@/lib/mysql";
import {
  expiredSessionCookie,
  SESSION_COOKIE,
  sessionCookie,
  signSessionToken,
  verifySessionToken,
} from "@/lib/session-token";

// Auth (docs/HANDOFF.md 4.5): the signed-in user, read from the session
// cookie and checked against the database, plus password hashing. Client code
// imports the types with `import type`, which is erased at build time.

export type { Role };

/** The signed-in user. centerId is set only for CENTER_MANAGER. */
export type Session = {
  userId: number;
  name: string;
  role: Role;
  centerId: number | null;
};

/** A user row as getSession and login read it. is_active is TINYINT(1): 0 or 1, not a boolean. */
type UserRow = {
  user_id: number;
  name: string;
  center_id: number | null;
  is_active: number;
  role_name: Role;
};

type LoginRow = UserRow & { password_hash: string };

const USER_COLUMNS = "u.user_id, u.name, u.center_id, u.is_active, r.role_name";
const USER_FROM = "FROM `user` u JOIN role r ON r.role_id = u.role_id";

/**
 * Why this account can't be signed in, or null if it can. Login shows the
 * message (403); getSession treats any problem as signed out.
 */
export function accountProblem(row: UserRow): string | null {
  if (!row.is_active) return "This account has been deactivated. Ask an admin to reactivate it.";
  if (row.role_name === "CENTER_MANAGER" && row.center_id === null) {
    return "Your account isn't linked to a resource center. Ask an admin to assign one.";
  }
  return null;
}

function toSession(row: UserRow): Session {
  return { userId: row.user_id, name: row.name, role: row.role_name, centerId: row.center_id };
}

/**
 * The signed-in user, or null. Checks the token, then the database, so a
 * deactivation, role change or center change ends the session at once.
 *
 * Deduped per render by React.cache(); in a Route Handler it's a plain call,
 * so call it once per request (requireSession / requireRole do).
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const claims = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!claims) return null;

  const row = await queryOne<UserRow>(`SELECT ${USER_COLUMNS} ${USER_FROM} WHERE u.user_id = ?`, [
    claims.userId,
  ]);
  if (!row || accountProblem(row)) return null;
  if (row.role_name !== claims.role || row.center_id !== claims.centerId) return null;
  return toSession(row);
});

/** The user with this email and their password hash, for POST /api/auth/login only. */
export async function findLoginUser(email: string): Promise<LoginRow | null> {
  return queryOne<LoginRow>(
    `SELECT ${USER_COLUMNS}, u.password_hash ${USER_FROM} WHERE u.email = ?`,
    [email],
  );
}

/** Signs the user in: sets the session cookie on the response. Returns their Session. */
export async function startSession(row: UserRow): Promise<Session> {
  const session = toSession(row);
  const token = await signSessionToken({
    userId: session.userId,
    role: session.role,
    centerId: session.centerId,
  });
  (await cookies()).set(sessionCookie(token));
  return session;
}

/** Signs the user out: replaces the session cookie with an expired one. */
export async function endSession(): Promise<void> {
  (await cookies()).set(expiredSessionCookie());
}

/** bcrypt only reads the first 72 bytes, so longer passwords are refused, not cut short. */
export const MAX_PASSWORD_BYTES = 72;

/** A bcrypt hash (cost 10) for user.password_hash. Throws if plain is over 72 UTF-8 bytes. */
export async function hashPassword(plain: string): Promise<string> {
  if (bcrypt.truncates(plain)) throw new Error("Passwords are at most 72 bytes");
  return bcrypt.hash(plain, 10);
}

/** Whether plain matches hash. Always false for a password over 72 bytes. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (bcrypt.truncates(plain)) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * A cost-10 hash of a random value no one knows. Login compares against it
 * when the email is unknown, so every attempt costs one bcrypt compare.
 */
export const DUMMY_HASH = "$2b$10$dcUT9CPTUx7jYjEnrgjVBufjqy4.6CHJVY0Mf9cZqoZG6ydLqbXvW";
