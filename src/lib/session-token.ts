import "server-only";
import { jwtVerify, SignJWT } from "jose";
import { requireEnv } from "@/lib/env";
import { ROLES, type Role } from "@/lib/enums";

// The session JWT and its cookie (docs/HANDOFF.md 4.5). No database here:
// src/proxy.ts uses it to check the cookie on every request, and auth.ts
// builds getSession() on top of it.

export const SESSION_COOKIE = "eras_session";

/** 8 hours. Not refreshed: the user signs in again after it runs out. */
export const SESSION_TTL_S = 8 * 60 * 60;

/** What the token carries: sub (userId), role and centerId, nothing else. */
export type SessionClaims = { userId: number; role: Role; centerId: number | null };

let key: Uint8Array | undefined;

/** JWT_SECRET as 32 bytes. Read on first use; throws if it isn't 64 hex characters. */
function secretKey(): Uint8Array {
  if (key) return key;
  const hex = requireEnv("JWT_SECRET");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("JWT_SECRET in .env.local must be 64 hex characters");
  }
  key = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  return key;
}

export async function signSessionToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ role: claims.role, centerId: claims.centerId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(claims.userId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_S}s`)
    .sign(secretKey());
}

/**
 * The claims of a valid token, or null if it's missing, tampered, expired,
 * not HS256, or carries claims of the wrong shape.
 */
export async function verifySessionToken(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
      requiredClaims: ["sub", "iat", "exp"],
    }));
  } catch {
    return null;
  }

  const { sub, role, centerId } = payload;
  if (typeof sub !== "string" || !/^[1-9]\d*$/.test(sub)) return null;
  if (!ROLES.includes(role as Role)) return null;
  if (centerId !== null && !(Number.isSafeInteger(centerId) && (centerId as number) > 0)) return null;
  return { userId: Number(sub), role: role as Role, centerId: centerId as number | null };
}

type SessionCookie = {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
};

/** The cookie that carries a token. Secure under `next start` (NODE_ENV=production). */
export function sessionCookie(token: string): SessionCookie {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_S,
  };
}

/** The same cookie, emptied and expired, so the browser drops it. */
export function expiredSessionCookie(): SessionCookie {
  return { ...sessionCookie(""), maxAge: 0 };
}
