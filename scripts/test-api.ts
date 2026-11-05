/**
 * npm run api:test -- --base <url> --writes
 *
 * Checks the Part 1 API (docs/HANDOFF.md 4.5-4.10, Appendix A T14-T16) against
 * a running server: npm run dev, or npm run build + npm start. Both flags are
 * optional; --base defaults to http://localhost:3000. Pass them after a single
 * "--" (a second "--" would end the options).
 *
 * The default run writes nothing, so it's safe at any time:
 *   1. logins (every seeded user, the inactive one, a wrong password)
 *   2. T15 tokens: tampered, expired, alg none, HS512 and bad-role tokens
 *   3. the role matrix: every Part 1 route signed out and as each role. An
 *      allowed role proves it got past the role check without writing (a bad
 *      body -> 400, an unknown id -> 404); a refused role sends a valid request
 *      and gets 403 (T14 is field1's POST /api/allocations)
 *   4. T15 signed out, 5. T16 center scope, 6. page redirects by role
 *   7. validation, 8. reads (scope, order, shapes, ledger reconciliation)
 *   9. the seed scenario (SKIP unless the database is freshly seeded)
 *  10. nothing was written: MySQL row counts and activity_log unchanged
 *
 * --writes adds the P1.8/P1.9 behaviour checks (allocate, split, cancel,
 * receive, adjust, write-off refusals, dispatch/deliver, the ledger, the
 * activity_log entries) and T15's live sessions. It refuses to start unless
 * the database is freshly seeded, and changes it: run npm run db:reset after.
 *
 * It talks to the app over HTTP only: plain fetch with an explicit Cookie
 * header (so next start's Secure cookie works too), after one warm-up request
 * per route (next dev's first request to an uncompiled route can answer before
 * the route runs). It reads MySQL (as MYSQL_USER) and MongoDB directly, to find
 * rows by email, grid_id, batch_code or name (never by id) and to check what a
 * call wrote. Prints PASS / FAIL / SKIP per check; exits 1 on any FAIL.
 */
import { createHmac } from "node:crypto";
import { parseArgs } from "node:util";
import { type Db, MongoClient } from "mongodb";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { ROLES, type Role } from "../src/lib/enums";
import { AUTH_KEYS, loadEnv, MONGO_KEYS, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

const PASSWORD = "Eras@2026";
const MAX_ID = 2147483647; // a valid id no row has
const FORBIDDEN = "You don't have access to this";
const SIGNED_OUT = "Sign in to continue";
const USAGE = "Usage: npm run api:test -- [--base <url>] [--writes]";
const RESET_NOW = "\n--writes changed the database. Run npm run db:reset now.";

const EMAIL: Record<Role, string> = {
  ADMIN: "admin@eras.test",
  COORDINATOR: "coord@eras.test",
  FIELD_OFFICER: "field1@eras.test",
  CENTER_MANAGER: "cm.central@eras.test",
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (pass) passed++;
  else failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `  (${detail})` : ""}`);
}
function skip(name: string, why: string): void {
  skipped++;
  console.log(`  SKIP  ${name}  (${why})`);
}
const section = (title: string) => console.log(`\n${title}`);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Response bodies are checked field by field, so they stay loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
type Reply = { status: number; body: Body; location: string | null; setCookie: string[] };
type Cookie = string | null;

let BASE = "";

async function call(method: "GET" | "POST", path: string, cookie: Cookie = null, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed: Body = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, location: res.headers.get("location"), setCookie: res.headers.getSetCookie() };
}
const get = (path: string, cookie: Cookie = null) => call("GET", path, cookie);
const post = (path: string, cookie: Cookie = null, body?: unknown) => call("POST", path, cookie, body);

/** "401 UNAUTHENTICATED Sign in to continue", for FAIL details. */
function show(r: Reply): string {
  const e = r.body?.error;
  return [r.status, e?.code, e?.message ?? r.location].filter((x) => x !== undefined && x !== null).join(" ");
}
const isError = (r: Reply, status: number, code?: string, message?: string) =>
  r.status === status &&
  (code === undefined || r.body?.error?.code === code) &&
  (message === undefined || r.body?.error?.message === message);
/** The path a redirect points at, e.g. "/dashboard" or "/login?next=%2Fallocate". */
function redirectedTo(r: Reply): string | null {
  if (r.status < 300 || r.status > 399 || !r.location) return null;
  const u = new URL(r.location, BASE);
  return u.pathname + u.search;
}

type Session = { userId: number; name: string; role: Role; centerId: number | null };
const login = (email: string, password = PASSWORD) => post("/api/auth/login", null, { email, password });
/** "eras_session=<jwt>" from a login's Set-Cookie. */
function cookieOf(r: Reply): string {
  const c = r.setCookie.find((s) => s.startsWith("eras_session="));
  if (!c) throw new ScriptError(`login gave no eras_session cookie (${show(r)})`);
  return c.split(";")[0];
}

// ---------------------------------------------------------------------------
// MySQL and MongoDB reads
// ---------------------------------------------------------------------------

async function rows<T>(my: Connection, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await my.query<RowDataPacket[]>(sql, params);
  return r as T[];
}
async function one<T>(my: Connection, sql: string, params: unknown[] = [], what = "row"): Promise<T> {
  const [r] = await rows<T>(my, sql, params);
  if (r === undefined) throw new ScriptError(`${what} not found in the database; run npm run db:reset`);
  return r;
}

const TABLES = [
  "role", "user", "location", "emergency", "emergency_impact", "impact_observation", "resource",
  "resource_center", "stock", "stock_ledger", "resource_request", "request_item", "allocation",
] as const;

/** Row counts of every table plus activity_log, to prove a run wrote nothing. */
async function snapshot(my: Connection, db: Db): Promise<string> {
  const counts = await one<Record<string, number>>(
    my,
    `SELECT ${TABLES.map((t) => `(SELECT COUNT(*) FROM \`${t}\`) AS \`${t}\``).join(", ")}`,
  );
  const activity = await db.collection("activity_log").countDocuments();
  return JSON.stringify({ ...counts, activity_log: activity });
}

/** null when the database is as db:reset left it, else why not. */
async function staleness(my: Connection, db: Db): Promise<string | null> {
  const r = await one<{ allocations: number; ledger: number; zz: number }>(
    my,
    `SELECT (SELECT COUNT(*) FROM allocation) AS allocations,
            (SELECT COUNT(*) FROM stock_ledger) AS ledger,
            (SELECT COUNT(*) FROM \`user\` WHERE email LIKE 'zz\\_%')
          + (SELECT COUNT(*) FROM location WHERE grid_id LIKE 'zz\\_%')
          + (SELECT COUNT(*) FROM stock WHERE batch_code LIKE 'zz\\_%')
          + (SELECT COUNT(*) FROM resource WHERE name LIKE 'zz\\_%') AS zz`,
  );
  // P2.3's seed adds FIELD_REPORT_FILED entries; everything else is the backfill.
  const activity = await db.collection("activity_log").countDocuments({ action: { $ne: "FIELD_REPORT_FILED" } });
  const why: string[] = [];
  if (Number(r.allocations) !== 28) why.push(`${r.allocations} allocations, not 28`);
  if (Number(r.ledger) !== 115) why.push(`${r.ledger} ledger rows, not 115`);
  if (activity !== 170) why.push(`${activity} activity entries, not 170`);
  if (Number(r.zz) > 0) why.push(`${r.zz} zz_ rows`);
  return why.length > 0 ? why.join(", ") : null;
}

/** Ids of seeded rows, found by their natural keys. */
async function lookups(my: Connection) {
  const center = async (name: string) =>
    (await one<{ id: number }>(my, "SELECT center_id AS id FROM resource_center WHERE name = ?", [name], `center ${name}`)).id;
  const batch = async (code: string) =>
    (await one<{ id: number }>(my, "SELECT stock_id AS id FROM stock WHERE batch_code = ?", [code], `batch ${code}`)).id;
  const resource = async (name: string) =>
    (await one<{ id: number }>(my, "SELECT resource_id AS id FROM resource WHERE name = ?", [name], `resource ${name}`)).id;
  const impact = async (grid: string) =>
    (
      await one<{ id: number }>(
        my,
        `SELECT ei.impact_id AS id FROM emergency_impact ei JOIN location l ON l.location_id = ei.location_id
          WHERE l.grid_id = ?`,
        [grid],
        `impact ${grid}`,
      )
    ).id;
  /** The item for a grid and resource on a request that isn't CANCELLED. */
  const item = async (grid: string, res: string) =>
    (
      await one<{ id: number }>(
        my,
        `SELECT ri.request_item_id AS id
           FROM request_item ri
           JOIN resource_request rr ON rr.request_id = ri.request_id
           JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
           JOIN location l ON l.location_id = ei.location_id
           JOIN resource r ON r.resource_id = ri.resource_id
          WHERE l.grid_id = ? AND r.name = ? AND rr.status <> 'CANCELLED'
          ORDER BY ri.request_item_id LIMIT 1`,
        [grid, res],
        `item ${grid} / ${res}`,
      )
    ).id;
  /** The allocation from a batch to a grid's item. */
  const allocation = async (code: string, grid: string) =>
    (
      await one<{ id: number }>(
        my,
        `SELECT a.allocation_id AS id
           FROM allocation a
           JOIN stock s ON s.stock_id = a.stock_id
           JOIN request_item ri ON ri.request_item_id = a.request_item_id
           JOIN resource_request rr ON rr.request_id = ri.request_id
           JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
           JOIN location l ON l.location_id = ei.location_id
          WHERE s.batch_code = ? AND l.grid_id = ?
          ORDER BY a.allocation_id LIMIT 1`,
        [code, grid],
        `allocation ${code} -> ${grid}`,
      )
    ).id;

  return {
    blr: await center("Bengaluru Central Warehouse"),
    mdk: await center("Madikeri Relief Depot"),
    wfd: await center("Whitefield Relief Camp"),
    ksn: await center("Kushalnagar Relief Camp"),
    water: await resource("Drinking water"),
    bellandur: await impact("BLR-BELLANDUR"),
    jackets: await item("BLR-BELLANDUR", "Life jacket"),
    meals: await item("BLR-KORAMANGALA", "Ready-to-eat meal"),
    generators: await item("KDG-MADIKERI", "Portable generator 5 kVA"),
    rte01: await batch("BLR-RTE-01"),
    rice: await batch("BLR-RICE-01"),
    mdkRice: await batch("MDK-RICE-01"),
    mdkGen: await batch("MDK-GEN-01"),
    ksnGen: await batch("KSN-GEN-01"),
    blkt: await batch("BLR-BLKT-01"),
    genAlloc: await allocation("BLR-GEN-01", "BLR-MAHADEVAPURA"), // RESERVED on the seed
    ljAlloc: await allocation("BLR-LJ-01", "BLR-BELLANDUR"), // DISPATCHED on the seed
    blktAlloc: await allocation("BLR-BLKT-01", "BLR-MAHADEVAPURA"), // RESERVED on the seed
    orsAlloc: await allocation("BLR-ORS-01", "BLR-MAHADEVAPURA"), // RESERVED on the seed
  };
}
type Ids = Awaited<ReturnType<typeof lookups>>;

type Ctx = {
  my: Connection;
  db: Db;
  ids: Ids;
  /** One signed-in cookie per role (cm.central for CENTER_MANAGER), plus cm.kodagu. */
  as: Record<Role, string> & { kodagu: string };
  sessions: Record<Role, Session> & { kodagu: Session };
  jwtKey: Buffer;
  fresh: string | null;
};

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

function options(): { base: string; writes: boolean } {
  let values: { base?: string; writes?: boolean };
  try {
    ({ values } = parseArgs({
      options: { base: { type: "string" }, writes: { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new ScriptError(`${(err as Error).message}\n${USAGE}`);
  }
  const raw = values.base ?? "http://localhost:3000";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ScriptError(`--base ${raw} isn't a URL.\n${USAGE}`);
  }
  return { base: url.origin, writes: values.writes ?? false };
}

/** Fails fast with a clear message when nothing (or not ERAS) answers. */
async function reachable(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new ScriptError(`Nothing answered at ${BASE}. Start the app (npm run dev) or pass --base <url>.`);
  }
  const body = (await res.json().catch(() => null)) as Body;
  if (res.status !== 401 || body?.error?.code !== "UNAUTHENTICATED") {
    throw new ScriptError(`${BASE} answered, but it doesn't look like ERAS (GET /api/auth/me -> ${res.status}).`);
  }
}

/** One request per route and page, results ignored: next dev compiles a route on its first request. */
async function warmUp(admin: string): Promise<void> {
  const paths = [
    "/api/auth/me", "/api/auth/login", "/api/auth/logout", "/api/observations",
    "/api/allocations/queue", "/api/allocations/suggestions", "/api/allocations", `/api/allocations/${MAX_ID}/cancel`,
    "/api/resources", "/api/stock", `/api/stock/${MAX_ID}/adjust`, `/api/stock/${MAX_ID}/ledger`,
    "/api/stock/allocations", `/api/stock/allocations/${MAX_ID}/dispatch`, `/api/stock/allocations/${MAX_ID}/deliver`,
    "/api", "/api/zz-no-such-route", "/login", "/dashboard", "/allocate", "/inventory",
  ];
  // GET only: a POST-only route answers 405 and runs nothing.
  for (const p of paths) await get(p, admin).catch(() => null);
}

// ---------------------------------------------------------------------------
// 1. Logins
// ---------------------------------------------------------------------------

async function checkLogins(): Promise<{ as: Ctx["as"]; sessions: Ctx["sessions"] }> {
  section("1. Logins");
  const users: { email: string; role: Role; center?: string }[] = [
    { email: "admin@eras.test", role: "ADMIN" },
    { email: "coord@eras.test", role: "COORDINATOR" },
    { email: "field1@eras.test", role: "FIELD_OFFICER" },
    { email: "field2@eras.test", role: "FIELD_OFFICER" },
    { email: "cm.central@eras.test", role: "CENTER_MANAGER", center: "Bengaluru Central Warehouse" },
    { email: "cm.kodagu@eras.test", role: "CENTER_MANAGER", center: "Madikeri Relief Depot" },
  ];
  const cookies = new Map<string, string>();
  const sessions = new Map<string, Session>();
  for (const u of users) {
    const r = await login(u.email);
    const s = r.body?.data as Session | undefined;
    check(`${u.email} signs in as ${u.role}`, r.status === 200 && s?.role === u.role, show(r));
    if (r.status !== 200 || !s) throw new ScriptError(`can't continue without ${u.email}'s session`);
    cookies.set(u.email, cookieOf(r));
    sessions.set(u.email, s);
    if (u.center) check(`${u.email} has a center`, s.centerId !== null, JSON.stringify(s));
  }
  const flags = (await login("coord@eras.test")).setCookie.find((c) => c.startsWith("eras_session=")) ?? "";
  check(
    "session cookie is HttpOnly, SameSite=Lax, Path=/, Max-Age=28800",
    /HttpOnly/i.test(flags) && /SameSite=lax/i.test(flags) && /Path=\//.test(flags) && /Max-Age=28800/.test(flags),
    flags.replace(/eras_session=[^;]*/, "eras_session=…"),
  );
  check(
    "field3 (inactive) -> 403",
    isError(await login("field3@eras.test"), 403, "FORBIDDEN", "This account has been deactivated. Ask an admin to reactivate it."),
  );
  check("wrong password -> 401", isError(await login("admin@eras.test", "not-the-password"), 401, "UNAUTHENTICATED", "Email or password is incorrect"));
  check("unknown email -> 401, same message", isError(await login("nobody@eras.test"), 401, "UNAUTHENTICATED", "Email or password is incorrect"));
  check("email trimmed and lowercased", (await login("  Coord@ERAS.test ")).status === 200);
  check("bad email -> 400", isError(await login("not-an-email"), 400, "VALIDATION"));
  check("73-byte password -> 400", isError(await login("admin@eras.test", "a".repeat(73)), 400, "VALIDATION"));

  const byRole = (role: Role) => EMAIL[role];
  return {
    as: {
      ...(Object.fromEntries(ROLES.map((r) => [r, cookies.get(byRole(r))!])) as Record<Role, string>),
      kodagu: cookies.get("cm.kodagu@eras.test")!,
    },
    sessions: {
      ...(Object.fromEntries(ROLES.map((r) => [r, sessions.get(byRole(r))!])) as Record<Role, Session>),
      kodagu: sessions.get("cm.kodagu@eras.test")!,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Tokens (T15)
// ---------------------------------------------------------------------------

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
function jwt(key: Buffer, header: object, payload: object, hash: "sha256" | "sha512" | null): string {
  const data = `${b64(header)}.${b64(payload)}`;
  return `${data}.${hash ? createHmac(hash, key).update(data).digest("base64url") : ""}`;
}

async function checkTokens(c: Ctx): Promise<void> {
  section("2. Tokens (T15)");
  const s = c.sessions.FIELD_OFFICER;
  const now = Math.floor(Date.now() / 1000);
  const claims = { role: s.role, centerId: s.centerId, sub: String(s.userId), iat: now, exp: now + 3600 };
  const HS256 = { alg: "HS256" };
  const valid = jwt(c.jwtKey, HS256, claims, "sha256");
  const [h, p, sig] = valid.split(".");

  const me = await get("/api/auth/me", `eras_session=${valid}`);
  check("a token signed like the app's -> 200 (so the rejections below mean something)", me.status === 200 && me.body?.data?.userId === s.userId, show(me));

  const bad: [string, string][] = [
    ["tampered signature", `${h}.${p}.${(sig[0] === "A" ? "B" : "A") + sig.slice(1)}`],
    ["tampered payload (role ADMIN)", `${h}.${b64({ ...claims, role: "ADMIN" })}.${sig}`],
    ["expired", jwt(c.jwtKey, HS256, { ...claims, iat: now - 9 * 3600, exp: now - 3600 }, "sha256")],
    ["alg none", jwt(c.jwtKey, { alg: "none" }, claims, null)],
    ["HS512", jwt(c.jwtKey, { alg: "HS512" }, claims, "sha512")],
    ["bad role", jwt(c.jwtKey, HS256, { ...claims, role: "SUPERUSER" }, "sha256")],
  ];
  for (const [name, token] of bad) {
    const api = await get("/api/auth/me", `eras_session=${token}`);
    check(`${name} token: /api -> 401`, isError(api, 401, "UNAUTHENTICATED", SIGNED_OUT), show(api));
    const page = await get("/dashboard", `eras_session=${token}`);
    check(`${name} token: page -> /login`, redirectedTo(page) === "/login?next=%2Fdashboard", show(page));
  }
}

// ---------------------------------------------------------------------------
// 3. Role matrix
// ---------------------------------------------------------------------------

type Req = { method: "GET" | "POST"; path: string; body?: unknown };
type Endpoint = {
  label: string;
  allowed: readonly Role[];
  /** For an allowed role: must write nothing. */
  probe: Req;
  status: number;
  code?: string;
  verify?: (r: Reply, role: Role) => boolean;
  /** For refused roles and signed out: a valid request. Defaults to probe. */
  refused?: Req;
  tag?: Partial<Record<Role, string>>;
};
const send = (r: Req, cookie: Cookie) => call(r.method, r.path, cookie, r.body);

function endpoints(ids: Ids): Endpoint[] {
  const ALL = ROLES;
  const AC: Role[] = ["ADMIN", "COORDINATOR"];
  const AM: Role[] = ["ADMIN", "CENTER_MANAGER"];
  const G = (path: string): Req => ({ method: "GET", path });
  const P = (path: string, body?: unknown): Req => ({ method: "POST", path, body });
  const adjustBody = { delta: 1, reason: "ADJUSTMENT" };
  return [
    { label: "GET /api/auth/me", allowed: ALL, probe: G("/api/auth/me"), status: 200, verify: (r, role) => r.body?.data?.role === role },
    {
      label: "POST /api/observations",
      allowed: ["ADMIN", "COORDINATOR", "FIELD_OFFICER"],
      probe: P("/api/observations", {}),
      status: 400,
      code: "VALIDATION",
      refused: P("/api/observations", {
        impact_id: ids.bellandur,
        emergency_type: "FLOOD",
        affected_percentage: 10,
        severity: "LOW",
        details: { water_level_m: 1, roads_submerged: 0 },
      }),
    },
    { label: "GET /api/allocations/queue", allowed: AC, probe: G("/api/allocations/queue"), status: 200 },
    { label: "GET /api/allocations/suggestions", allowed: AC, probe: G(`/api/allocations/suggestions?item=${ids.jackets}`), status: 200 },
    {
      label: "GET /api/allocations?item=",
      allowed: AC,
      probe: G(`/api/allocations?item=${MAX_ID}`),
      status: 404,
      code: "NOT_FOUND",
      refused: G(`/api/allocations?item=${ids.jackets}`),
    },
    {
      label: "POST /api/allocations",
      allowed: AC,
      probe: P("/api/allocations", { request_item_id: ids.meals, batches: [] }),
      status: 400,
      code: "VALIDATION",
      refused: P("/api/allocations", { request_item_id: ids.meals, batches: [{ stock_id: ids.rte01, quantity: 1 }] }),
      tag: { FIELD_OFFICER: "T14" },
    },
    {
      // An unknown id is the procedure's 409 by contract (4.9), so the probe is a bad id.
      label: "POST /api/allocations/[id]/cancel",
      allowed: AC,
      probe: P("/api/allocations/0/cancel"),
      status: 400,
      code: "VALIDATION",
      refused: P(`/api/allocations/${ids.genAlloc}/cancel`),
    },
    { label: "GET /api/resources", allowed: ALL, probe: G("/api/resources"), status: 200 },
    { label: "GET /api/stock", allowed: AM, probe: G("/api/stock"), status: 200 },
    {
      label: "POST /api/stock",
      allowed: AM,
      probe: P("/api/stock", {}),
      status: 400,
      code: "VALIDATION",
      refused: P("/api/stock", { resource_id: ids.water, center_id: ids.blr, batch_code: "zz_api_refused", quantity: 1 }),
    },
    {
      label: "POST /api/stock/[id]/adjust",
      allowed: AM,
      probe: P(`/api/stock/${MAX_ID}/adjust`, adjustBody),
      status: 404,
      code: "NOT_FOUND",
      refused: P(`/api/stock/${ids.rice}/adjust`, adjustBody),
    },
    {
      label: "GET /api/stock/[id]/ledger",
      allowed: AM,
      probe: G(`/api/stock/${MAX_ID}/ledger`),
      status: 404,
      code: "NOT_FOUND",
      refused: G(`/api/stock/${ids.rice}/ledger`),
    },
    { label: "GET /api/stock/allocations", allowed: AM, probe: G("/api/stock/allocations"), status: 200 },
    {
      label: "POST /api/stock/allocations/[id]/dispatch",
      allowed: AM,
      probe: P(`/api/stock/allocations/${MAX_ID}/dispatch`),
      status: 404,
      code: "NOT_FOUND",
      refused: P(`/api/stock/allocations/${ids.genAlloc}/dispatch`),
    },
    {
      label: "POST /api/stock/allocations/[id]/deliver",
      allowed: AM,
      probe: P(`/api/stock/allocations/${MAX_ID}/deliver`),
      status: 404,
      code: "NOT_FOUND",
      refused: P(`/api/stock/allocations/${ids.ljAlloc}/deliver`),
    },
    { label: "GET /api/zz-no-such-route", allowed: ALL, probe: G("/api/zz-no-such-route"), status: 404, code: "NOT_FOUND" },
    { label: "GET /api", allowed: ALL, probe: G("/api"), status: 404, code: "NOT_FOUND" },
  ];
}

async function checkMatrix(c: Ctx): Promise<void> {
  const list = endpoints(c.ids);
  section(`3. Role matrix (${list.length} endpoints x signed out + ${ROLES.length} roles)`);
  for (const e of list) {
    const out = await send(e.refused ?? e.probe, null);
    check(`${e.label} signed out -> 401`, isError(out, 401, "UNAUTHENTICATED", SIGNED_OUT), show(out));
    for (const role of ROLES) {
      const tag = e.tag?.[role] ? ` (${e.tag[role]})` : "";
      if (e.allowed.includes(role)) {
        const r = await send(e.probe, c.as[role]);
        const ok = r.status === e.status && (e.code === undefined || r.body?.error?.code === e.code) && (!e.verify || e.verify(r, role));
        check(`${e.label} as ${role} -> ${e.status}${tag}`, ok, show(r));
      } else {
        const r = await send(e.refused ?? e.probe, c.as[role]);
        check(`${e.label} as ${role} -> 403${tag}`, isError(r, 403, "FORBIDDEN", FORBIDDEN), show(r));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4-6. T15 signed out, T16, page redirects
// ---------------------------------------------------------------------------

async function checkSignedOut(): Promise<void> {
  section("4. Signed out (T15)");
  const api = await get("/api/requests");
  check("GET /api/requests with no cookie -> 401", isError(api, 401, "UNAUTHENTICATED", SIGNED_OUT), show(api));
  const page = await get("/allocate");
  check("/allocate with no cookie -> 307 /login?next=%2Fallocate", page.status === 307 && redirectedTo(page) === "/login?next=%2Fallocate", show(page));
}

async function checkCenterScope(c: Ctx): Promise<void> {
  section("5. Center scope (T16)");
  const { ids, as, my } = c;
  const state = async () =>
    JSON.stringify(
      await one(
        my,
        `SELECT (SELECT quantity_available FROM stock WHERE stock_id = ?) AS qty,
                (SELECT COUNT(*) FROM stock_ledger WHERE stock_id = ?) AS ledger,
                (SELECT status FROM allocation WHERE allocation_id = ?) AS alloc,
                (SELECT COUNT(*) FROM stock WHERE batch_code = 'zz_api_t16') AS received`,
        [ids.mdkRice, ids.mdkRice, ids.genAlloc],
      ),
    );
  const before = await state();
  const t16 = async (name: string, r: Promise<Reply>) => {
    const res = await r;
    check(`T16 ${name} -> 403`, isError(res, 403, "FORBIDDEN", FORBIDDEN), show(res));
  };
  await t16("cm.central adjusting a Madikeri batch", post(`/api/stock/${ids.mdkRice}/adjust`, as.CENTER_MANAGER, { delta: 1, reason: "ADJUSTMENT" }));
  await t16("cm.central reading a Madikeri batch's ledger", get(`/api/stock/${ids.mdkRice}/ledger`, as.CENTER_MANAGER));
  await t16(
    "cm.central receiving at Madikeri",
    post("/api/stock", as.CENTER_MANAGER, { resource_id: ids.water, center_id: ids.mdk, batch_code: "zz_api_t16", quantity: 1 }),
  );
  await t16("cm.kodagu dispatching a Bengaluru Central allocation", post(`/api/stock/allocations/${ids.genAlloc}/dispatch`, as.kodagu));
  await t16("cm.central listing ?center=Madikeri batches", get(`/api/stock?center=${ids.mdk}`, as.CENTER_MANAGER));
  await t16("cm.central listing ?center=Madikeri allocations", get(`/api/stock/allocations?center=${ids.mdk}`, as.CENTER_MANAGER));
  const after = await state();
  check("T16 refused calls left the batch, its ledger and the allocation unchanged", before === after, `${before} -> ${after}`);
}

async function checkPages(c: Ctx): Promise<void> {
  section("6. Pages by role (proxy)");
  const to = async (name: string, path: string, cookie: string, where: string) => {
    const r = await get(path, cookie);
    check(`${name} opening ${path} -> ${where}`, redirectedTo(r) === where, show(r));
  };
  const opens = async (name: string, path: string, cookie: string) => {
    const r = await get(path, cookie);
    check(`${name} opening ${path} -> 200`, r.status === 200, show(r));
  };
  await to("field1", "/allocate", c.as.FIELD_OFFICER, "/dashboard");
  await to("cm.central", "/allocate", c.as.CENTER_MANAGER, "/dashboard");
  await to("coord", "/inventory", c.as.COORDINATOR, "/dashboard");
  await opens("admin", "/inventory", c.as.ADMIN);
  await opens("cm.central", "/inventory", c.as.CENTER_MANAGER);
  await opens("coord", "/allocate", c.as.COORDINATOR);
}

// ---------------------------------------------------------------------------
// 7. Validation (nothing reaches the database)
// ---------------------------------------------------------------------------

async function checkValidation(c: Ctx): Promise<void> {
  section("7. Validation (400s)");
  const { ids, as } = c;
  const v = async (name: string, r: Promise<Reply>, field?: string) => {
    const res = await r;
    check(
      `${name} -> 400${field ? ` on ${field}` : ""}`,
      isError(res, 400, "VALIDATION") && (field === undefined || res.body?.error?.fields?.[field] !== undefined),
      `${show(res)} ${JSON.stringify(res.body?.error?.fields ?? {})}`,
    );
  };
  const alloc = (batches: unknown) => post("/api/allocations", as.COORDINATOR, { request_item_id: ids.meals, batches });
  await v("suggestions ?item=abc", get("/api/allocations/suggestions?item=abc", as.COORDINATOR), "item");
  await v("allocations without ?item", get("/api/allocations", as.COORDINATOR), "item");
  await v("allocate the same batch twice", alloc([{ stock_id: ids.rte01, quantity: 1 }, { stock_id: ids.rte01, quantity: 2 }]), "batches");
  await v("allocate 1.005 (3 decimals)", alloc([{ stock_id: ids.rte01, quantity: 1.005 }]), "batches.0.quantity");
  await v("allocate from 11 batches", alloc(Array.from({ length: 11 }, (_, i) => ({ stock_id: i + 1, quantity: 1 }))), "batches");
  const badJson = await fetch(`${BASE}/api/allocations`, {
    method: "POST",
    headers: { Cookie: as.COORDINATOR, "Content-Type": "application/json" },
    body: "{",
  });
  const badBody = (await badJson.json().catch(() => null)) as Body;
  check(
    "a body that isn't JSON -> 400 INVALID_JSON",
    badJson.status === 400 && badBody?.error?.code === "INVALID_JSON",
    `${badJson.status} ${badBody?.error?.code}`,
  );
  await v("stock ?center=abc", get("/api/stock?center=abc", as.ADMIN), "center");
  await v("stock allocations ?status=BOGUS", get("/api/stock/allocations?status=BOGUS", as.CENTER_MANAGER), "status");
  const receive = (body: object) => post("/api/stock", as.CENTER_MANAGER, { resource_id: ids.water, batch_code: "zz_api_bad", quantity: 1, ...body });
  await v("receive with expiry 2026-02-30", receive({ expiry_date: "2026-02-30" }), "expiry_date");
  await v("receive quantity 0", receive({ quantity: 0 }), "quantity");
  await v("receive a blank batch code", receive({ batch_code: "   " }), "batch_code");
  await v(
    "admin receives without center_id",
    post("/api/stock", as.ADMIN, { resource_id: ids.water, batch_code: "zz_api_bad", quantity: 1 }),
    "center_id",
  );
  await v("adjust by 0", post(`/api/stock/${ids.rice}/adjust`, as.CENTER_MANAGER, { delta: 0, reason: "ADJUSTMENT" }), "delta");
  await v("adjust with reason RECEIPT", post(`/api/stock/${ids.rice}/adjust`, as.CENTER_MANAGER, { delta: 1, reason: "RECEIPT" }), "reason");
  await v("adjust id abc", post("/api/stock/abc/adjust", as.CENTER_MANAGER, { delta: 1, reason: "ADJUSTMENT" }), "id");
}

// ---------------------------------------------------------------------------
// 8. Reads that hold on any database
// ---------------------------------------------------------------------------

type StockRow = { stock_id: number; batch_code: string; resource_name: string; center_id: number; quantity_available: number; expiry_date: string | null; days_left: number | null; usable: boolean };
type LedgerRow = { change_qty: number; balance_after: number; reason: string; allocation_id: number | null; changed_by: string };

/** Every row's running sum equals balance_after, and the last balance equals the batch. */
function reconciles(ledger: LedgerRow[], quantity: number): boolean {
  let run = 0;
  const steps = ledger.every((r) => {
    run = Math.round((run + r.change_qty) * 100) / 100;
    return run === r.balance_after;
  });
  return steps && (ledger.at(-1)?.balance_after ?? 0) === quantity;
}

async function checkReads(c: Ctx): Promise<void> {
  section("8. Reads: scope, order and shape");
  const { ids, as, my } = c;

  const mine = await get("/api/stock", as.CENTER_MANAGER);
  const list = (mine.body?.data ?? []) as StockRow[];
  check("cm.central's batches are all their own center", mine.status === 200 && list.length > 0 && list.every((b) => b.center_id === ids.blr), show(mine));
  const fefo = list.every((b, i) => {
    const p = list[i - 1];
    if (!p || p.resource_name !== b.resource_name) return true;
    if (p.expiry_date === null) return b.expiry_date === null && p.batch_code <= b.batch_code;
    if (b.expiry_date === null) return true;
    return p.expiry_date < b.expiry_date || (p.expiry_date === b.expiry_date && p.batch_code <= b.batch_code);
  });
  check("batches are FEFO within each resource (no expiry last)", fefo);
  const order = (
    await rows<{ name: string }>(
      my,
      "SELECT DISTINCT r.name FROM stock s JOIN resource r ON r.resource_id = s.resource_id WHERE s.center_id = ? ORDER BY r.name",
      [ids.blr],
    )
  ).map((r) => r.name);
  check("batches are grouped by resource in name order", JSON.stringify([...new Set(list.map((b) => b.resource_name))]) === JSON.stringify(order));
  check(
    "batch rows carry days_left and a boolean usable",
    list.every((b) => typeof b.usable === "boolean" && "days_left" in b),
  );
  check("cm.central ?center=<own> -> 200", (await get(`/api/stock?center=${ids.blr}`, as.CENTER_MANAGER)).status === 200);

  const all = (await get("/api/stock", as.ADMIN)).body?.data as StockRow[];
  const empty = (await get("/api/stock?center=", as.ADMIN)).body?.data as StockRow[];
  const [{ n: batches }] = await rows<{ n: number }>(my, "SELECT COUNT(*) AS n FROM stock");
  check("admin sees every batch; ?center= (empty) means all", all?.length === Number(batches) && empty?.length === all.length, `${all?.length}/${empty?.length}/${batches}`);
  const wf = (await get(`/api/stock?center=${ids.wfd}`, as.ADMIN)).body?.data as StockRow[];
  check("admin ?center=Whitefield lists only Whitefield", wf?.length > 0 && wf.every((b) => b.center_id === ids.wfd));

  const res = await get("/api/resources", as.FIELD_OFFICER);
  const names = (await rows<{ name: string }>(my, "SELECT name FROM resource ORDER BY name")).map((r) => r.name);
  check(
    "field1 lists every resource, by name",
    res.status === 200 && JSON.stringify((res.body?.data ?? []).map((r: { name: string }) => r.name)) === JSON.stringify(names),
    show(res),
  );

  const al = await get("/api/stock/allocations", as.CENTER_MANAGER);
  const allocs = (al.body?.data ?? []) as { center_id: number; status: string; request_id: number; emergency_name: string; grid_id: string; resource_name: string; allocated_by: string }[];
  const open = (s: string) => s === "RESERVED" || s === "DISPATCHED";
  const firstClosed = allocs.findIndex((a) => !open(a.status));
  check("cm.central's allocations are all their own center", al.status === 200 && allocs.length > 0 && allocs.every((a) => a.center_id === ids.blr), show(al));
  check("RESERVED and DISPATCHED come first", firstClosed === -1 || allocs.slice(firstClosed).every((a) => !open(a.status)));
  check(
    "allocation rows carry request, emergency, grid, resource and who allocated",
    allocs.every((a) => a.request_id && a.emergency_name && a.grid_id && a.resource_name && a.allocated_by),
  );
  const reserved = (await get("/api/stock/allocations?status=RESERVED", as.CENTER_MANAGER)).body?.data as { status: string }[];
  check("?status=RESERVED filters", Array.isArray(reserved) && reserved.every((a) => a.status === "RESERVED"));

  const busiest = await one<{ id: number; qty: number }>(
    my,
    `SELECT s.stock_id AS id, s.quantity_available AS qty FROM stock s JOIN stock_ledger l ON l.stock_id = s.stock_id
      WHERE s.center_id = ? GROUP BY s.stock_id ORDER BY COUNT(*) DESC, s.stock_id LIMIT 1`,
    [ids.blr],
  );
  const lg = await get(`/api/stock/${busiest.id}/ledger`, as.CENTER_MANAGER);
  const ledger = (lg.body?.data ?? []) as LedgerRow[];
  check(
    `the busiest Bengaluru Central batch's ledger (${ledger.length} rows) reconciles`,
    lg.status === 200 && ledger.length > 1 && reconciles(ledger, busiest.qty),
    show(lg),
  );
  check(
    "ledger rows carry reason, allocation_id and a changed_by name",
    ledger.every((r) => r.reason && "allocation_id" in r && typeof r.changed_by === "string") && ledger.some((r) => r.allocation_id !== null),
  );
}

// ---------------------------------------------------------------------------
// 9. The seed scenario (HANDOFF 4.8)
// ---------------------------------------------------------------------------

async function checkSeed(c: Ctx): Promise<void> {
  section("9. Seed scenario");
  const names = [
    "queue: 19 rows, Bellandur life jackets first",
    "life jackets: no suggestions (none usable)",
    "Koramangala meals: BLR-RTE-01 suggested first",
    "cm.central sees 30 batches",
    "admin sees 80 batches, Whitefield 6",
    "/api/resources lists 25",
  ];
  if (c.fresh) {
    for (const n of names) skip(n, `${c.fresh}; run npm run db:reset`);
    return;
  }
  const { ids, as } = c;
  const queue = (await get("/api/allocations/queue", as.COORDINATOR)).body?.data as { grid_id: string; resource_name: string }[];
  check(names[0], queue?.length === 19 && queue[0].grid_id === "BLR-BELLANDUR" && queue[0].resource_name === "Life jacket", `${queue?.length} rows, top ${queue?.[0]?.grid_id} ${queue?.[0]?.resource_name}`);
  const js = await get(`/api/allocations/suggestions?item=${ids.jackets}`, as.COORDINATOR);
  check(names[1], js.status === 200 && js.body.data.length === 0, show(js));
  const ms = await get(`/api/allocations/suggestions?item=${ids.meals}`, as.COORDINATOR);
  check(names[2], ms.body?.data?.[0]?.batch_code === "BLR-RTE-01", ms.body?.data?.[0]?.batch_code);
  check(names[3], (await get("/api/stock", as.CENTER_MANAGER)).body?.data?.length === 30);
  const all = (await get("/api/stock", as.ADMIN)).body?.data?.length;
  const wf = (await get(`/api/stock?center=${ids.wfd}`, as.ADMIN)).body?.data?.length;
  check(names[4], all === 80 && wf === 6, `${all}, ${wf}`);
  check(names[5], (await get("/api/resources", as.FIELD_OFFICER)).body?.data?.length === 25);
}

// ---------------------------------------------------------------------------
// --writes: P1.8 / P1.9 behaviour and T15's live sessions
// ---------------------------------------------------------------------------

/** Entries a write logs: the backfill's shapes (HANDOFF 4.4). */
type Entry = {
  action: string;
  actor?: { user_id: number | null; name: string; role: string | null };
  entity?: { type: string; id: number };
  refs?: { request_id?: number; emergency_id?: number; center_id?: number };
  payload?: Record<string, unknown>;
};

async function checkWrites(c: Ctx): Promise<void> {
  const { ids, as, sessions, my, db } = c;
  const coord = sessions.COORDINATOR;
  const cm = sessions.CENTER_MANAGER;
  // Every entry this run logs is newer than this; the backfill's are older.
  const started = new Date(Date.now() - 1_000);
  const log = db.collection<Entry & { ts: Date }>("activity_log");
  const entry = (action: string, id: number) => log.findOne({ action, "entity.id": id, ts: { $gte: started } });
  const qty = async (id: number) =>
    (await one<{ q: number }>(my, "SELECT quantity_available AS q FROM stock WHERE stock_id = ?", [id])).q;
  const totals = async () =>
    JSON.stringify(
      await one(
        my,
        `SELECT (SELECT COUNT(*) FROM allocation) AS allocations, (SELECT COUNT(*) FROM stock_ledger) AS ledger,
                (SELECT SUM(quantity_available) FROM stock) AS stock`,
      ),
    );
  const batchState = async (id: number) =>
    JSON.stringify(
      await one(
        my,
        "SELECT quantity_available AS q, (SELECT COUNT(*) FROM stock_ledger WHERE stock_id = ?) AS n FROM stock WHERE stock_id = ?",
        [id, id],
      ),
    );
  const brief = (e: Entry | null) => JSON.stringify(e && { actor: e.actor, entity: e.entity, refs: e.refs, payload: e.payload });

  // ---- allocation ----
  section("W1. Allocation (P1.8)");
  const suggestions = (await get(`/api/allocations/suggestions?item=${ids.meals}`, as.COORDINATOR)).body?.data ?? [];
  const best = suggestions[0] as { stock_id: number; batch_code: string; suggested_qty: number } | undefined;
  if (best?.batch_code !== "BLR-RTE-01") throw new ScriptError(`Koramangala meals should suggest BLR-RTE-01 first, got ${best?.batch_code}`);
  const q0 = await qty(best.stock_id);
  const made = await post("/api/allocations", as.COORDINATOR, {
    request_item_id: ids.meals,
    batches: [{ stock_id: best.stock_id, quantity: best.suggested_qty }],
  });
  const item = made.body?.data?.item;
  const mealsAlloc = made.body?.data?.allocations?.[0]?.allocation_id as number;
  check("allocate Koramangala meals from BLR-RTE-01 -> 201", made.status === 201 && Number.isInteger(mealsAlloc), show(made));
  if (!Number.isInteger(mealsAlloc)) throw new ScriptError("can't continue without the meals allocation");
  check(
    "the item is FULFILLED with nothing left, and its request rolled up",
    item?.item_status === "FULFILLED" && item.quantity_remaining === 0 && item.request_status !== "OPEN",
    `${item?.item_status} ${item?.quantity_remaining} ${item?.request_status}`,
  );
  check(`the batch went down by ${best.suggested_qty}`, q0 - (await qty(best.stock_id)) === best.suggested_qty);
  const alloRows = await one<{ n: number }>(
    my,
    "SELECT COUNT(*) AS n FROM stock_ledger WHERE allocation_id = ? AND reason = 'ALLOCATION'",
    [mealsAlloc],
  );
  check("one ALLOCATION ledger row for it", Number(alloRows.n) === 1);
  const created = await entry("ALLOCATION_CREATED", mealsAlloc);
  check(
    "ALLOCATION_CREATED: coord, entity ALLOCATION, three refs, { quantity, resource, batch_code }",
    created?.actor?.user_id === coord.userId &&
      created.actor.role === "COORDINATOR" &&
      created.entity?.type === "ALLOCATION" &&
      created.refs?.request_id === item.request_id &&
      created.refs?.emergency_id === item.emergency_id &&
      created.refs?.center_id === ids.blr &&
      created.payload?.quantity === best.suggested_qty &&
      created.payload?.resource === "Ready-to-eat meal" &&
      created.payload?.batch_code === "BLR-RTE-01",
    brief(created),
  );

  const t0 = await totals();
  const tooBig = await post("/api/allocations", as.COORDINATOR, {
    request_item_id: ids.generators,
    batches: [{ stock_id: ids.mdkGen, quantity: 2 }, { stock_id: ids.ksnGen, quantity: 2 }],
  });
  check(
    "generators MDK-GEN-01 2 + KSN-GEN-01 2 -> 409 Insufficient stock in this batch",
    isError(tooBig, 409, "RULE", "Insufficient stock in this batch"),
    show(tooBig),
  );
  check("the refused split wrote nothing (allocations, ledger, stock)", t0 === (await totals()), `${t0} -> ${await totals()}`);
  const split = await post("/api/allocations", as.COORDINATOR, {
    request_item_id: ids.generators,
    batches: [{ stock_id: ids.ksnGen, quantity: 1 }, { stock_id: ids.mdkGen, quantity: 2 }],
  });
  const sd = split.body?.data;
  check(
    "generators MDK-GEN-01 2 + KSN-GEN-01 1 -> 201, two allocations, PARTIAL 3 of 5",
    split.status === 201 && sd.allocations.length === 2 && sd.item.item_status === "PARTIAL" &&
      sd.item.quantity_allocated === 3 && sd.item.quantity_requested === 5,
    show(split),
  );
  check("the split's allocations come back in stock_id order", sd?.allocations?.[0]?.stock_id < sd?.allocations?.[1]?.stock_id);

  const qb = await qty(best.stock_id);
  const cancel = await post(`/api/allocations/${mealsAlloc}/cancel`, as.COORDINATOR);
  check(
    "cancel the meals allocation -> 200 CANCELLED, item back to PENDING",
    cancel.status === 200 && cancel.body.data.allocation.status === "CANCELLED" && cancel.body.data.item.item_status === "PENDING",
    show(cancel),
  );
  check(`the cancel returned ${best.suggested_qty} to the batch`, (await qty(best.stock_id)) - qb === best.suggested_qty);
  const back = await one<{ ledger_id: number; change_qty: number; balance_after: number; changed_by: number }>(
    my,
    "SELECT ledger_id, change_qty, balance_after, changed_by FROM stock_ledger WHERE allocation_id = ? AND reason = 'ALLOCATION_CANCELLED'",
    [mealsAlloc],
  );
  check("an ALLOCATION_CANCELLED ledger row by the canceller", back.changed_by === coord.userId && back.change_qty === best.suggested_qty);
  const cancelled = await entry("ALLOCATION_CANCELLED", mealsAlloc);
  check(
    "ALLOCATION_CANCELLED carries its ledger row and the three refs",
    cancelled?.payload?.ledger_id === back.ledger_id &&
      cancelled.payload.change_qty === back.change_qty &&
      cancelled.payload.balance_after === back.balance_after &&
      cancelled.payload.batch_code === "BLR-RTE-01" &&
      cancelled.payload.resource === "Ready-to-eat meal" &&
      cancelled.refs?.request_id === item.request_id &&
      cancelled.refs?.center_id === ids.blr,
    brief(cancelled),
  );
  const twice = await post(`/api/allocations/${mealsAlloc}/cancel`, as.COORDINATOR);
  check("cancel it again -> 409", isError(twice, 409, "RULE", "Allocation is already CANCELLED"), show(twice));
  const ghost = await post(`/api/allocations/${MAX_ID}/cancel`, as.COORDINATOR);
  check("cancel an unknown allocation -> 409", isError(ghost, 409, "RULE", `Allocation ${MAX_ID} not found`), show(ghost));
  const history = await get(`/api/allocations?item=${ids.meals}`, as.COORDINATOR);
  const past = (history.body?.data?.allocations ?? []) as { status: string; allocated_by: string }[];
  check(
    "the item's allocations show the cancelled one and who allocated it",
    history.status === 200 && past.length === 1 && past[0].status === "CANCELLED" && past[0].allocated_by === coord.name,
    show(history),
  );

  // ---- stock ----
  section("W2. Stock (P1.9)");
  const inFuture = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  const receive = (cookie: string, body: object) => post("/api/stock", cookie, { resource_id: ids.water, quantity: 1, ...body });
  const recv = await receive(as.CENTER_MANAGER, { batch_code: "  zz_api_01 ", quantity: 250.5, expiry_date: inFuture });
  const nb = recv.body?.data?.batch as StockRow | undefined;
  check("cm.central receives a batch -> 201", recv.status === 201 && nb !== undefined, show(recv));
  if (!nb) throw new ScriptError("can't continue without the received batch");
  check(
    "it lands at their center with the code trimmed, usable",
    nb.center_id === ids.blr && nb.batch_code === "zz_api_01" && nb.quantity_available === 250.5 && nb.usable === true,
    JSON.stringify(nb),
  );
  const receipt = await one<{ ledger_id: number; reason: string; change_qty: number; changed_by: number }>(
    my,
    "SELECT ledger_id, reason, change_qty, changed_by FROM stock_ledger WHERE stock_id = ?",
    [nb.stock_id],
  );
  check(
    "one RECEIPT row by cm.central, and the response returns it",
    receipt.reason === "RECEIPT" && receipt.change_qty === 250.5 && receipt.changed_by === cm.userId &&
      recv.body.data.ledger.ledger_id === receipt.ledger_id && recv.body.data.ledger.changed_by === cm.name,
    JSON.stringify(receipt),
  );
  const received = await entry("STOCK_RECEIVED", nb.stock_id);
  check(
    "STOCK_RECEIVED: cm.central, entity STOCK, refs.center_id, the ledger row as payload",
    received?.actor?.user_id === cm.userId &&
      received.entity?.type === "STOCK" &&
      received.refs?.center_id === ids.blr &&
      received.payload?.ledger_id === receipt.ledger_id &&
      received.payload?.change_qty === 250.5 &&
      received.payload?.balance_after === 250.5 &&
      received.payload?.batch_code === "zz_api_01" &&
      received.payload?.resource === "Drinking water",
    brief(received),
  );
  const dup = await receive(as.CENTER_MANAGER, { batch_code: "zz_api_01" });
  check("the same batch code again -> 409 DUPLICATE", isError(dup, 409, "DUPLICATE"), show(dup));
  const closed = await receive(as.ADMIN, { center_id: ids.wfd, batch_code: "zz_api_wf", quantity: 10 });
  check(
    "admin receiving at CLOSED Whitefield -> 409",
    isError(closed, 409, "RULE", "Center Whitefield Relief Camp is CLOSED, so it can't receive stock"),
    show(closed),
  );
  const ks = await receive(as.ADMIN, { center_id: ids.ksn, batch_code: "zz_api_ksn", quantity: 10 });
  check("admin receiving at Kushalnagar (no manager) -> 201", ks.status === 201 && ks.body.data.batch.center_id === ids.ksn, show(ks));
  const old = await receive(as.CENTER_MANAGER, { batch_code: "zz_api_old", quantity: 5, expiry_date: "2025-01-01" });
  check(
    "a past expiry date is accepted, as an expired batch",
    old.status === 201 && old.body.data.batch.usable === false && old.body.data.batch.days_left < 0,
    show(old),
  );
  const noCenter = await receive(as.ADMIN, { center_id: MAX_ID, batch_code: "zz_api_u" });
  check("an unknown center -> 404", isError(noCenter, 404, "NOT_FOUND", `Center ${MAX_ID} not found`), show(noCenter));
  const noResource = await receive(as.CENTER_MANAGER, { resource_id: MAX_ID, batch_code: "zz_api_r" });
  check("an unknown resource -> 409 MISSING_REFERENCE", isError(noResource, 409, "MISSING_REFERENCE"), show(noResource));

  const sid = nb.stock_id;
  const adjust = (cookie: string, id: number, delta: number, reason: string) =>
    post(`/api/stock/${id}/adjust`, cookie, { delta, reason });
  const a1 = await adjust(as.CENTER_MANAGER, sid, 5, "ADJUSTMENT");
  check(
    "adjust +5 ADJUSTMENT -> 200, 255.5",
    a1.status === 200 && a1.body.data.batch.quantity_available === 255.5 && a1.body.data.ledger.reason === "ADJUSTMENT" &&
      a1.body.data.ledger.change_qty === 5,
    show(a1),
  );
  const a2 = await adjust(as.CENTER_MANAGER, sid, -3, "WRITE_OFF");
  check(
    "write off 3 -> 200, 252.5",
    a2.status === 200 && a2.body.data.batch.quantity_available === 252.5 && a2.body.data.ledger.reason === "WRITE_OFF" &&
      a2.body.data.ledger.balance_after === 252.5,
    show(a2),
  );
  const adjusted = await entry("STOCK_ADJUSTED", sid);
  const writtenOff = await entry("STOCK_WRITTEN_OFF", sid);
  check(
    "STOCK_ADJUSTED and STOCK_WRITTEN_OFF carry their ledger rows",
    adjusted?.payload?.ledger_id === a1.body.data.ledger.ledger_id && adjusted?.payload?.change_qty === 5 &&
      adjusted?.payload?.balance_after === 255.5 && writtenOff?.payload?.ledger_id === a2.body.data.ledger.ledger_id &&
      writtenOff?.payload?.change_qty === -3 && writtenOff?.refs?.center_id === ids.blr,
    `${brief(adjusted)} ${brief(writtenOff)}`,
  );
  const s0 = await batchState(sid);
  const up = await adjust(as.CENTER_MANAGER, sid, 3, "WRITE_OFF");
  check("write off +3 -> 409", isError(up, 409, "RULE", "A write-off must reduce the quantity"), show(up));
  const under = await adjust(as.CENTER_MANAGER, sid, -1000, "WRITE_OFF");
  check("write off more than the batch holds -> 409", isError(under, 409, "RULE", "Insufficient stock in this batch"), show(under));
  check("the refused write-offs wrote nothing", s0 === (await batchState(sid)));
  const wf = await one<{ id: number }>(
    my,
    "SELECT stock_id AS id FROM stock WHERE center_id = ? AND quantity_available > 1 ORDER BY stock_id LIMIT 1",
    [ids.wfd],
    "a Whitefield batch with stock",
  );
  const wfOff = await adjust(as.ADMIN, wf.id, -1, "WRITE_OFF");
  check("admin writes off 1 at CLOSED Whitefield -> 200", wfOff.status === 200, show(wfOff));

  const refs = await one<{ request_id: number; emergency_id: number }>(
    my,
    `SELECT ri.request_id, ei.emergency_id
       FROM allocation a
       JOIN request_item ri ON ri.request_item_id = a.request_item_id
       JOIN resource_request rr ON rr.request_id = ri.request_id
       JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
      WHERE a.allocation_id = ?`,
    [ids.blktAlloc],
  );
  const move = (id: number, to: "dispatch" | "deliver") => post(`/api/stock/allocations/${id}/${to}`, as.CENTER_MANAGER);
  const d1 = await move(ids.blktAlloc, "dispatch");
  check("dispatch Mahadevapura's blankets -> 200 DISPATCHED", d1.status === 200 && d1.body.data.allocation.status === "DISPATCHED", show(d1));
  const d2 = await move(ids.blktAlloc, "dispatch");
  check("dispatch it again -> 409", isError(d2, 409, "RULE", "Allocation is already DISPATCHED"), show(d2));
  const d3 = await move(ids.blktAlloc, "deliver");
  check("deliver it -> 200 DELIVERED", d3.status === 200 && d3.body.data.allocation.status === "DELIVERED", show(d3));
  const dispatched = await entry("ALLOCATION_DISPATCHED", ids.blktAlloc);
  const delivered = await entry("ALLOCATION_DELIVERED", ids.blktAlloc);
  check(
    "ALLOCATION_DISPATCHED and _DELIVERED: cm.central, three refs, the batch",
    [dispatched, delivered].every(
      (e) =>
        e?.actor?.user_id === cm.userId &&
        e.refs?.request_id === refs.request_id &&
        e.refs?.emergency_id === refs.emergency_id &&
        e.refs?.center_id === ids.blr &&
        e.payload?.batch_code === "BLR-BLKT-01" &&
        e.payload?.derived === undefined,
    ),
    `${brief(dispatched)} ${brief(delivered)}`,
  );
  const early = await move(ids.orsAlloc, "deliver");
  check("deliver a RESERVED allocation -> 409", isError(early, 409, "RULE", "Allocation can't go from RESERVED to DELIVERED"), show(early));
  const late = await post(`/api/allocations/${ids.blktAlloc}/cancel`, as.COORDINATOR);
  check("cancel a DELIVERED allocation -> 409", isError(late, 409, "RULE", "Allocation can't go from DELIVERED to CANCELLED"), show(late));

  // ---- the ledger ----
  section("W3. Ledger (T18)");
  const touched = [ids.rte01, ids.mdkGen, ids.ksnGen, ids.blkt, sid, ks.body?.data?.batch?.stock_id, old.body?.data?.batch?.stock_id, wf.id]
    .filter((id): id is number => Number.isInteger(id));
  const off: number[] = [];
  for (const id of touched) {
    const lg = await get(`/api/stock/${id}/ledger`, as.ADMIN);
    if (lg.status !== 200 || !reconciles(lg.body.data as LedgerRow[], await qty(id))) off.push(id);
  }
  check(`GET /ledger reconciles on all ${touched.length} batches this run touched`, touched.length === 8 && off.length === 0, `off: ${off.join(", ")}`);
  const q11 = await one<{ rows_off: number; batches_off: number }>(
    my,
    `SELECT (SELECT COUNT(*)
               FROM (SELECT l.balance_after,
                            SUM(l.change_qty) OVER (PARTITION BY l.stock_id ORDER BY l.changed_at, l.ledger_id) AS running
                       FROM stock_ledger l) AS x
              WHERE x.running <> x.balance_after) AS rows_off,
            (SELECT COUNT(*) FROM stock s
              WHERE s.quantity_available <> COALESCE((SELECT l.balance_after FROM stock_ledger l
                                                       WHERE l.stock_id = s.stock_id
                                                       ORDER BY l.changed_at DESC, l.ledger_id DESC LIMIT 1), 0)) AS batches_off`,
  );
  check(
    "query 11 on every batch: 0 running-total and 0 last-balance mismatches",
    Number(q11.rows_off) === 0 && Number(q11.batches_off) === 0,
    JSON.stringify(q11),
  );

  // ---- activity_log ----
  section("W4. activity_log");
  const grouped = await log
    .aggregate<{ _id: string; n: number }>([{ $match: { ts: { $gte: started } } }, { $group: { _id: "$action", n: { $sum: 1 } } }])
    .toArray();
  const got = JSON.stringify(Object.fromEntries(grouped.map((g) => [g._id, g.n]).sort()));
  const want = JSON.stringify({
    ALLOCATION_CANCELLED: 1,
    ALLOCATION_CREATED: 3,
    ALLOCATION_DELIVERED: 1,
    ALLOCATION_DISPATCHED: 1,
    STOCK_ADJUSTED: 1,
    STOCK_RECEIVED: 3,
    STOCK_WRITTEN_OFF: 2,
  });
  check("one entry per successful write, none for the refused ones", got === want, got);

  // ---- live sessions ----
  section("W5. Live sessions (T15)");
  const field1 = EMAIL.FIELD_OFFICER;
  const kodagu = "cm.kodagu@eras.test";
  const roleId = async (name: Role) =>
    (await one<{ id: number }>(my, "SELECT role_id AS id FROM role WHERE role_name = ?", [name])).id;

  const f = cookieOf(await login(field1));
  await my.query("UPDATE `user` SET is_active = FALSE WHERE email = ?", [field1]);
  try {
    check("field1 deactivated: the open session's /api calls -> 401", isError(await get("/api/auth/me", f), 401, "UNAUTHENTICATED"));
    const page = await get("/dashboard", f);
    check("field1 deactivated: a page sends them to /login", redirectedTo(page)?.startsWith("/login") ?? false, show(page));
    check("field1 deactivated: signing in -> 403", isError(await login(field1), 403, "FORBIDDEN"));
  } finally {
    await my.query("UPDATE `user` SET is_active = TRUE WHERE email = ?", [field1]);
  }

  const f2 = cookieOf(await login(field1));
  await my.query("UPDATE `user` SET role_id = ? WHERE email = ?", [await roleId("COORDINATOR"), field1]);
  try {
    check("field1's role changed: the open session -> 401", isError(await get("/api/auth/me", f2), 401, "UNAUTHENTICATED"));
    const again = await login(field1);
    check("field1 signs in again as COORDINATOR", again.status === 200 && again.body?.data?.role === "COORDINATOR", show(again));
  } finally {
    await my.query("UPDATE `user` SET role_id = ? WHERE email = ?", [await roleId("FIELD_OFFICER"), field1]);
  }

  const k = cookieOf(await login(kodagu));
  await my.query("UPDATE `user` SET center_id = NULL WHERE email = ?", [kodagu]);
  try {
    check("cm.kodagu's center removed: the open session -> 401", isError(await get("/api/auth/me", k), 401, "UNAUTHENTICATED"));
    check(
      "cm.kodagu signs in again -> 403",
      isError(await login(kodagu), 403, "FORBIDDEN", "Your account isn't linked to a resource center. Ask an admin to assign one."),
    );
  } finally {
    await my.query("UPDATE `user` SET center_id = ? WHERE email = ?", [ids.mdk, kodagu]);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { base, writes } = options();
  BASE = base;
  const env = loadEnv([...MYSQL_APP_KEYS, ...MONGO_KEYS, ...AUTH_KEYS]);
  if (!/^[0-9a-fA-F]{64}$/.test(env.JWT_SECRET)) throw new ScriptError("JWT_SECRET in .env.local must be 64 hex characters");
  console.log(`api:test against ${BASE}${writes ? " (--writes)" : ""}`);
  await reachable();

  const my = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    dateStrings: true,
    decimalNumbers: true,
  });
  const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
  let wrote = false;
  let finished = false;
  try {
    await mongo.connect();
    const db = mongo.db(env.MONGODB_DB);
    const fresh = await staleness(my, db);
    if (writes && fresh) {
      throw new ScriptError(`--writes needs a freshly seeded database (${fresh}). Run npm run db:reset first.`);
    }
    const before = await snapshot(my, db);
    const ids = await lookups(my);

    const { as, sessions } = await checkLogins();
    console.log("\n(warming up every route and page)");
    await warmUp(as.ADMIN);
    const c: Ctx = { my, db, ids, as, sessions, jwtKey: Buffer.from(env.JWT_SECRET, "hex"), fresh };

    await checkTokens(c);
    await checkMatrix(c);
    await checkSignedOut();
    await checkCenterScope(c);
    await checkPages(c);
    await checkValidation(c);
    await checkReads(c);
    await checkSeed(c);

    section("10. Nothing written");
    const after = await snapshot(my, db);
    check("MySQL row counts and activity_log are unchanged", before === after, `${before} -> ${after}`);

    if (writes) {
      wrote = true;
      await checkWrites(c);
    }
    finished = true;
  } finally {
    await my.end();
    await mongo.close();
    if (wrote && !finished) console.log(RESET_NOW); // stopped part-way through --writes
  }

  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  if (failed > 0) {
    if (wrote) console.log(RESET_NOW);
    throw new ScriptError(`${failed} check${failed === 1 ? "" : "s"} failed`);
  }
  console.log("api:test passed");
  if (wrote) console.log(RESET_NOW);
}

runScript("api:test", main);
