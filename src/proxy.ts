import { type NextRequest, NextResponse } from "next/server";
import { sectionFor } from "@/config/nav";
import type { ApiErrorBody } from "@/lib/api-contract";
import { SESSION_COOKIE, SIGNED_OUT_MESSAGE, verifySessionToken } from "@/lib/session-token";

// Runs before every page and /api request (docs/HANDOFF.md 4.6, 4.7). It only
// checks the session token: no database, so a deactivated user still gets
// past it, and getSession() in the (app) layout or requireRole in the handler
// turns them away.
//
// - /login, POST /api/auth/login and POST /api/auth/logout: always let through.
// - /api/*: no valid token -> 401 JSON. Roles are left to each handler's requireRole.
// - Pages: no valid token -> /login?next=<path>. A nav page (or one under it)
//   the role can't open -> /dashboard. A page outside nav.ts gets no role check here.

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isExempt(req.method, pathname)) return NextResponse.next();

  const claims = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    if (claims) return NextResponse.next();
    const error = { code: "UNAUTHENTICATED", message: SIGNED_OUT_MESSAGE } satisfies ApiErrorBody;
    return NextResponse.json({ error }, { status: 401 });
  }

  if (!claims) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", pathname + search);
    return NextResponse.redirect(login);
  }

  const section = sectionFor(pathname);
  if (section && !section.roles.includes(claims.role)) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }
  return NextResponse.next();
}

function isExempt(method: string, pathname: string): boolean {
  if (pathname === "/login") return true;
  return method === "POST" && (pathname === "/api/auth/login" || pathname === "/api/auth/logout");
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico).*)"],
};
