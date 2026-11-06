/**
 * api:test's plumbing: PASS / FAIL / SKIP output, HTTP calls to the running
 * app, and plain MySQL reads.
 */
import type { Connection, RowDataPacket } from "mysql2/promise";
import type { Role } from "../../src/lib/enums";
import { ScriptError } from "../lib/script";

export const PASSWORD = "Eras@2026";
export const MAX_ID = 2147483647; // a valid id no row has
export const FORBIDDEN = "You don't have access to this";
export const SIGNED_OUT = "Sign in to continue";

/** The account each role signs in as (cm.central for CENTER_MANAGER). */
export const EMAIL: Record<Role, string> = {
  ADMIN: "admin@eras.test",
  COORDINATOR: "coord@eras.test",
  FIELD_OFFICER: "field1@eras.test",
  CENTER_MANAGER: "cm.central@eras.test",
};
/** The second center manager, for cross-center checks. */
export const KODAGU = "cm.kodagu@eras.test";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const tally = { passed: 0, failed: 0, skipped: 0 };

export function check(name: string, pass: boolean, detail = ""): void {
  if (pass) tally.passed++;
  else tally.failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `  (${detail})` : ""}`);
}
export function skip(name: string, why: string): void {
  tally.skipped++;
  console.log(`  SKIP  ${name}  (${why})`);
}
export const section = (title: string) => console.log(`\n${title}`);
export const results = () => ({ ...tally });

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Response bodies are checked field by field, so they stay loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = any;
export type Reply = { status: number; body: Body; location: string | null; setCookie: string[] };
export type Cookie = string | null;
export type Req = { method: "GET" | "POST"; path: string; body?: unknown };

let base = "";
export function setBase(origin: string): void {
  base = origin;
}

/** fetch against the app, never following redirects. */
export function fetchApp(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<Response> {
  return fetch(base + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
}

export async function call(method: Req["method"], path: string, cookie: Cookie = null, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchApp(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: Body = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, location: res.headers.get("location"), setCookie: res.headers.getSetCookie() };
}
export const get = (path: string, cookie: Cookie = null) => call("GET", path, cookie);
export const post = (path: string, cookie: Cookie = null, body?: unknown) => call("POST", path, cookie, body);
export const send = (r: Req, cookie: Cookie) => call(r.method, r.path, cookie, r.body);

/** "401 UNAUTHENTICATED Sign in to continue", for FAIL details. */
export function show(r: Reply): string {
  const e = r.body?.error;
  return [r.status, e?.code, e?.message ?? r.location].filter((x) => x !== undefined && x !== null).join(" ");
}
export const isError = (r: Reply, status: number, code?: string, message?: string) =>
  r.status === status &&
  (code === undefined || r.body?.error?.code === code) &&
  (message === undefined || r.body?.error?.message === message);
/** The path a redirect points at, e.g. "/dashboard" or "/login?next=%2Fallocate". */
export function redirectedTo(r: Reply): string | null {
  if (r.status < 300 || r.status > 399 || !r.location) return null;
  const u = new URL(r.location, base);
  return u.pathname + u.search;
}

export const login = (email: string, password = PASSWORD) => post("/api/auth/login", null, { email, password });
/** "eras_session=<jwt>" from a login's Set-Cookie. */
export function cookieOf(r: Reply): string {
  const c = r.setCookie.find((s) => s.startsWith("eras_session="));
  if (!c) throw new ScriptError(`login gave no eras_session cookie (${show(r)})`);
  return c.split(";")[0];
}

// ---------------------------------------------------------------------------
// MySQL reads
// ---------------------------------------------------------------------------

export async function rows<T>(my: Connection, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await my.query<RowDataPacket[]>(sql, params);
  return r as T[];
}
export async function one<T>(my: Connection, sql: string, params: unknown[] = [], what = "row"): Promise<T> {
  const [r] = await rows<T>(my, sql, params);
  if (r === undefined) throw new ScriptError(`${what} not found in the database; run npm run db:reset`);
  return r;
}
/** One row as a string, to compare before and after a call that must write nothing. */
export const state = async (my: Connection, sql: string, params: unknown[] = []) => JSON.stringify(await one(my, sql, params));
