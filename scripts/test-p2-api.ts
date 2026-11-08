/**
 * npm run api:test:p2
 *
 * End-to-end checks of the Part 2 API against the running app: real HTTP, real
 * cookies, real MySQL and MongoDB. P2.1: each "Done when", RBAC, filters,
 * full-text search and T17, the CLOSED and type rules. P2.2: the /allocate rank
 * of a new CRITICAL item, rollback, create and cancel rules, roles, filters.
 * P2.3: the field report seed, the read API, and a report filed for every
 * emergency type then found by emergency, distance and text. P2.4: the dashboard
 * for every role: KPIs, scoping, pipeline shapes and a warm timing check.
 *
 *   1. npm run db:reset       (the rank check expects the seeded queue)
 *   2. npm run dev            (in a second terminal)
 *   3. npm run api:test:p2    (API_BASE_URL if the app isn't on http://localhost:3000)
 *
 * Fixtures use zz_p21_ / zz_p22_ / zz_p23_ names and are removed at the end (also after a
 * failure, and left-overs from an aborted run at the start), so db:test stays green.
 * Exits 1 if any check fails.
 */
import { type Db, MongoClient } from "mongodb";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { seedTime } from "../db/mongo/activity_backfill";
import { ACTIVITY_ENTITY_TYPES } from "../src/lib/activity";
import { ACTIVITY_FEED_LIMIT, LATEST_REPORTS_LIMIT, REPORT_WINDOW_DAYS, TOP_NEEDS_LIMIT } from "../src/lib/dashboard-types";
import { EMERGENCY_TYPES } from "../src/lib/enums";
import { dateToIst, istToDate } from "../src/lib/ist";
import { appConnection } from "./lib/app-connection";
import { loadEnv, MONGO_KEYS, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

const BASE = process.env.API_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "Eras@2026"; // the seeded local-dev password (HANDOFF 4.8)
const ZZ = "zz_p21_"; // fixture prefix: emergency names and grid ids
const ZZ_REQ = "zz_p22_"; // P2.2's prefix: those, and request descriptions
const ZZ_REP = "zz_p23_"; // P2.3's prefix: emergency names and grid ids
const RUN = Date.now().toString(36); // unique per run, for search terms and grid ids

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; data: any; error: any };
type Call = (method: string, path: string, body?: unknown) => Promise<Res>;

let failures = 0;

/** Prints one result and counts failures, so one problem doesn't hide the rest. */
function check(name: string, passed: boolean, detail?: unknown): void {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}`);
  if (!passed) {
    failures += 1;
    if (detail !== undefined) console.log(`        got: ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

/** A client that sends `cookie` with every call; no cookie means signed out. */
function client(cookie?: string): Call {
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: "manual",
      headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: unknown; error?: unknown };
    return { status: res.status, data: json.data, error: json.error };
  };
}

/** Signs in through the real login route; the client holds its session cookie. */
async function signIn(email: string): Promise<Call> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!res.ok || !cookie) throw new ScriptError(`couldn't sign in as ${email} (HTTP ${res.status})`);
  return client(cookie);
}

/** Valid text but invalid boolean-mode syntax, plus T17's injection attempt. */
const HOSTILE_SEARCHES = ["' OR 1=1 --", "' OR_1=1 --", "--", "+", "+-", '"', "(((", "a* *b", "@3", "<>~", "%", "\\", "_", "___"];

async function testEmergencies(my: Connection): Promise<void> {
  console.log("\nP2.1 Emergencies and impacts");
  const coord = await signIn("coord@eras.test");
  const field1 = await signIn("field1@eras.test");
  const field2 = await signIn("field2@eras.test");
  const manager = await signIn("cm.central@eras.test");
  const anonymous = client();

  check("signed out -> 401", (await anonymous("GET", "/api/emergencies")).status === 401);
  check("Center Manager list -> 403", (await manager("GET", "/api/emergencies")).status === 403);
  check("Center Manager detail -> 403", (await manager("GET", "/api/emergencies/1")).status === 403);

  // Done when: a Coordinator creates an emergency and adds two impacts.
  const created = await coord("POST", "/api/emergencies", {
    // A space before "cyclone": InnoDB's full-text parser counts _ as part of a word.
    name: `${ZZ}${RUN} cyclone`,
    type: "CYCLONE",
    description: `Gale damage ${RUN}`,
  });
  check("Coordinator creates an emergency -> 201", created.status === 201, created);
  const id: number = created.data?.emergency_id;

  const grid1 = `${ZZ}${RUN}-1`;
  const impact1 = await coord("POST", `/api/emergencies/${id}/impacts`, { grid_id: grid1, latitude: 12.9, longitude: 77.6 });
  check("adds a first impact on a new grid -> 201, location created",
    impact1.status === 201 && impact1.data?.location_created === true, impact1);
  // An existing grid (a center's location) keeps its stored coordinates.
  // Lookups ignore case, so this finds BLR-PEENYA; the stored spelling comes back.
  const impact2 = await coord("POST", `/api/emergencies/${id}/impacts`, { grid_id: "blr-peenya", latitude: 1, longitude: 1 });
  check("adds a second impact on an existing grid -> 201, stored coordinates and spelling",
    impact2.status === 201 && impact2.data?.location_created === false && impact2.data?.latitude !== 1 &&
      impact2.data?.grid_id === "BLR-PEENYA", impact2);
  const repeatLower = await coord("POST", `/api/emergencies/${id}/impacts`, { grid_id: "blr-peenya", latitude: 1, longitude: 1 });
  check("a repeat names the stored spelling in its 409",
    repeatLower.status === 409 && /BLR-PEENYA/.test(repeatLower.error?.message ?? ""), repeatLower);

  const repeat = await coord("POST", `/api/emergencies/${id}/impacts`, { grid_id: grid1, latitude: 12.9, longitude: 77.6 });
  check("the same grid twice -> 409 DUPLICATE", repeat.status === 409 && repeat.error?.code === "DUPLICATE", repeat);
  const tooPrecise = await coord("POST", `/api/emergencies/${id}/impacts`, { grid_id: `${ZZ}x`, latitude: 1.123456789, longitude: 1 });
  check("8 decimal places -> 400 on latitude", tooPrecise.status === 400 && !!tooPrecise.error?.fields?.latitude, tooPrecise);

  const bad = await coord("POST", "/api/emergencies", { name: "", type: "METEOR" });
  check("invalid body -> 400 with fields", bad.status === 400 && !!bad.error?.fields?.name && !!bad.error?.fields?.type, bad);
  const future = await coord("POST", "/api/emergencies", { name: `${ZZ}future`, type: "FIRE", start_time: "2099-01-01T10:00" });
  check("a future start_time -> 400 on start_time", future.status === 400 && !!future.error?.fields?.start_time, future);

  const detail = await coord("GET", `/api/emergencies/${id}`);
  check("detail lists both impacts", detail.status === 200 && detail.data?.impacts?.length === 2, detail);
  check("new impacts have no severity yet",
    detail.data?.impacts?.every((i: { latest_severity: unknown }) => i.latest_severity === null), detail.data?.impacts);

  // Done when: a Field Officer can view but gets 403 on every write.
  check("Field Officer list -> 200", (await field1("GET", "/api/emergencies")).status === 200);
  check("Field Officer detail -> 200", (await field1("GET", `/api/emergencies/${id}`)).status === 200);
  const impactId: number = impact1.data?.impact_id;
  const writes: [string, string, unknown][] = [
    ["POST", "/api/emergencies", { name: `${ZZ}x`, type: "FIRE" }],
    ["PATCH", `/api/emergencies/${id}`, { name: `${ZZ}x` }],
    ["POST", `/api/emergencies/${id}/impacts`, { grid_id: `${ZZ}x`, latitude: 1, longitude: 1 }],
    ["PATCH", `/api/impacts/${impactId}`, { status: "RESOLVED" }],
  ];
  for (const [method, path, body] of writes) {
    check(`Field Officer ${method} ${path} -> 403`, (await field1(method, path, body)).status === 403);
  }

  // Request counts: a Field Officer sees only their own requests, a Coordinator all.
  const [flood] = await my.query<RowDataPacket[]>(
    `SELECT e.emergency_id,
            COUNT(rr.request_id) AS total,
            SUM(u.email = 'field1@eras.test') AS field1,
            SUM(u.email = 'field2@eras.test') AS field2
       FROM emergency e
       JOIN emergency_impact ei ON ei.emergency_id = e.emergency_id
       JOIN location l          ON l.location_id   = ei.location_id
       JOIN resource_request rr ON rr.impact_id    = ei.impact_id
       JOIN \`user\` u          ON u.user_id       = rr.user_id
      WHERE e.emergency_id = (SELECT ei2.emergency_id FROM emergency_impact ei2
                                JOIN location l2 ON l2.location_id = ei2.location_id
                               WHERE l2.grid_id = 'BLR-BELLANDUR')
      GROUP BY e.emergency_id`,
  );
  const want = flood[0] as { emergency_id: number; total: number; field1: number; field2: number };
  const floodCount = async (who: Call) => (await who("GET", `/api/emergencies/${want.emergency_id}`)).data?.counts?.requests;
  const listCount = async (who: Call) =>
    (await who("GET", "/api/emergencies")).data?.find((e: { emergency_id: number }) => e.emergency_id === want.emergency_id)
      ?.request_count;
  check(`flood requests: Coordinator sees all ${want.total}`, (await floodCount(coord)) === Number(want.total));
  check(`flood requests: field1 sees own ${want.field1}`, (await floodCount(field1)) === Number(want.field1));
  check(`flood requests: field2 sees own ${want.field2}`, (await floodCount(field2)) === Number(want.field2));
  check("list request_count is scoped the same way",
    (await listCount(coord)) === Number(want.total) && (await listCount(field1)) === Number(want.field1));

  // Filters, ids and full-text search.
  const inList = (r: Res) => (r.data ?? []).some((e: { emergency_id: number }) => e.emergency_id === id);
  check("blank filters (?status=&type=&q=) -> 200", (await coord("GET", "/api/emergencies?status=&type=&q=")).status === 200);
  check("status + type filter finds it", inList(await coord("GET", "/api/emergencies?status=ACTIVE&type=CYCLONE")));
  check("an invalid filter -> 400", (await coord("GET", "/api/emergencies?status=NOPE")).status === 400);
  check("full-text search finds it by description", inList(await coord("GET", `/api/emergencies?q=${RUN}`)));
  check("full-text prefix match works", inList(await coord("GET", "/api/emergencies?q=cyclon")));
  // The name's first word holds underscores: InnoDB indexes it as one token.
  const underscored = await coord("GET", `/api/emergencies?q=${ZZ}${RUN}`);
  check("an underscore term -> 200 and finds it", underscored.status === 200 && inList(underscored), underscored);
  for (const text of HOSTILE_SEARCHES) {
    const r = await coord("GET", `/api/emergencies?q=${encodeURIComponent(text)}`);
    check(`T17 search ${JSON.stringify(text)} -> 200, no rows`, r.status === 200 && r.data?.length === 0, r);
  }
  for (const bad of ["abc", "0", "1e3", "-1", "99999999999"]) {
    check(`/api/emergencies/${bad} -> 400`, (await coord("GET", `/api/emergencies/${bad}`)).status === 400);
  }
  check("an unknown emergency -> 404", (await coord("GET", "/api/emergencies/99999999")).status === 404);
  check("an unknown impact -> 404", (await coord("PATCH", "/api/impacts/99999999", { status: "ACTIVE" })).status === 404);

  // Editing.
  const renamed = await coord("PATCH", `/api/emergencies/${id}`, { name: `${ZZ}renamed ${RUN}`, description: "" });
  check("edit name, blank description -> null",
    renamed.status === 200 && renamed.data?.name === `${ZZ}renamed ${RUN}` && renamed.data?.description === null, renamed);
  const futureEdit = await coord("PATCH", `/api/emergencies/${id}`, { start_time: "2099-01-01T10:00" });
  check("edit to a future start_time -> 400", futureEdit.status === 400 && !!futureEdit.error?.fields?.start_time, futureEdit);
  const empty = await coord("PATCH", `/api/emergencies/${id}`, {});
  check("an empty PATCH -> 400", empty.status === 400, empty);
  const stabilised = await coord("PATCH", `/api/impacts/${impactId}`, { status: "STABILISED" });
  check("impact status -> STABILISED", stabilised.status === 200 && stabilised.data?.status === "STABILISED", stabilised);

  // The type is fixed once the emergency has an observation (filed through Part 1's route).
  const filed = await coord("POST", "/api/observations", {
    impact_id: impactId,
    emergency_type: "CYCLONE",
    affected_percentage: 20,
    severity: "MODERATE",
    details: {},
  });
  check("file one observation -> 201", filed.status === 201, filed);
  const typeChange = await coord("PATCH", `/api/emergencies/${id}`, { type: "FIRE" });
  check("type change once observed -> 409 RULE", typeChange.status === 409 && typeChange.error?.code === "RULE", typeChange);
  const latest = (await coord("GET", `/api/emergencies/${id}`)).data;
  check("detail shows the latest severity and the timeline",
    latest?.impacts?.some((i: { latest_severity: string }) => i.latest_severity === "MODERATE") &&
      latest?.observations?.length === 1 && latest?.counts?.observations === 1 && latest?.counts?.reports === 1, latest);

  // start_time can't move past the first observation. A refused PATCH writes
  // nothing, so the seeded flood is safe to try it on: its first observation is
  // old enough that an hour later is still in the past.
  const [firstRows] = await my.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(MIN(o.observed_at) + INTERVAL 1 HOUR, '%Y-%m-%d %H:%i:%s') AS after_first
       FROM impact_observation o
       JOIN emergency_impact ei ON ei.impact_id = o.impact_id
      WHERE ei.emergency_id = ?`,
    [want.emergency_id],
  );
  const floodPath = `/api/emergencies/${want.emergency_id}`;
  const floodStart = (await coord("GET", floodPath)).data?.emergency?.start_time;
  const pastFirst = await coord("PATCH", floodPath, { start_time: firstRows[0].after_first });
  check("start_time after the first observation -> 400 on start_time",
    pastFirst.status === 400 && /first observation/.test(pastFirst.error?.fields?.start_time ?? ""), pastFirst);
  check("...and the start_time is unchanged", (await coord("GET", floodPath)).data?.emergency?.start_time === floodStart);
  const atFirst = await coord("PATCH", `/api/emergencies/${id}`, { start_time: latest?.observations?.[0]?.observed_at });
  check("start_time equal to the first observation -> 200", atFirst.status === 200, atFirst);

  // Closing is final.
  const closed = await coord("PATCH", `/api/emergencies/${id}`, { status: "CLOSED" });
  check("close sets status and end_time", closed.data?.status === "CLOSED" && !!closed.data?.end_time, closed);
  for (const [what, method, path, body] of [
    ["reopen", "PATCH", `/api/emergencies/${id}`, { status: "ACTIVE" }],
    ["edit", "PATCH", `/api/emergencies/${id}`, { name: `${ZZ}late` }],
    ["new impact", "POST", `/api/emergencies/${id}/impacts`, { grid_id: `${ZZ}${RUN}-3`, latitude: 1, longitude: 1 }],
    ["impact status", "PATCH", `/api/impacts/${impactId}`, { status: "RESOLVED" }],
  ] as const) {
    const r = await coord(method, path, body);
    check(`closed emergency refuses ${what} -> 409 RULE`, r.status === 409 && r.error?.code === "RULE", r);
  }
}

const HAS_ALLOCATIONS = "This request has reserved, dispatched or delivered allocations, so it can't be cancelled.";
const FAR_ID = 2147483646; // a valid id that no row will have

/** resource_request and request_item row counts, and activity entries: what a rollback must leave alone. */
async function rowCounts(my: Connection, db: Db): Promise<string> {
  const [[row]] = await my.query<RowDataPacket[]>(
    "SELECT (SELECT COUNT(*) FROM resource_request) AS requests, (SELECT COUNT(*) FROM request_item) AS items",
  );
  return `${row.requests}/${row.items}/${await db.collection("activity_log").countDocuments()}`;
}

/** One column of the first row, or a failed run if the seed doesn't have it. */
async function lookup(my: Connection, what: string, sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await my.query<RowDataPacket[]>(sql, params);
  if (rows.length === 0) throw new ScriptError(`the seed has no ${what}. Run npm run db:reset`);
  return Object.values(rows[0])[0] as number;
}

const IMPACT_BY_GRID = `SELECT ei.impact_id FROM emergency_impact ei
                          JOIN location l ON l.location_id = ei.location_id WHERE l.grid_id = ?`;

async function testRequests(my: Connection, db: Db): Promise<void> {
  console.log("\nP2.2 Requests");
  const [coord, admin, field1, field2, manager] = await Promise.all(
    ["coord@eras.test", "admin@eras.test", "field1@eras.test", "field2@eras.test", "cm.central@eras.test"].map(signIn),
  );
  const anonymous = client();

  const [resources] = await my.query<RowDataPacket[]>("SELECT resource_id FROM resource ORDER BY name LIMIT 2");
  const [r1, r2]: number[] = resources.map((r) => r.resource_id);
  const bellandur = await lookup(my, "BLR-BELLANDUR impact", IMPACT_BY_GRID, ["BLR-BELLANDUR"]);
  const item = (resource_id: number, urgency = "HIGH") => ({ resource_id, quantity_requested: 10, urgency });
  const description = (what: string) => `${ZZ_REQ}${RUN} ${what}`;

  // First, before anything else creates CRITICAL items that could push it down.
  // Done when: a new CRITICAL request shows near the top of /allocate. It has
  // waited 0 s (W = 0), on the seed's worst impact, due within 6 h (D = 1).
  const [[{ soon }]] = await my.query<RowDataPacket[]>(
    "SELECT DATE_FORMAT(NOW() + INTERVAL 3 HOUR, '%Y-%m-%dT%H:%i') AS soon",
  );
  const urgent = await field1("POST", "/api/requests", {
    impact_id: bellandur,
    required_by: soon,
    description: description("rank check"),
    items: [item(r1, "CRITICAL")],
  });
  check("a Field Officer creates a CRITICAL request -> 201", urgent.status === 201, urgent);
  const urgentId: number = urgent.data?.request_id;
  const queue = await coord("GET", "/api/allocations/queue");
  const rank = (queue.data ?? []).findIndex((row: { request_id: number }) => row.request_id === urgentId) + 1;
  console.log(
    `        /allocate: new item scores ${queue.data?.[rank - 1]?.priority_score}, rank ${rank} of ${queue.data?.length}; ` +
      `top score ${queue.data?.[0]?.priority_score}`,
  );
  check("the new CRITICAL item is near the top of the queue (rank <= 3)", rank >= 1 && rank <= 3, rank);

  // Done when: a request whose second item is invalid leaves no rows behind.
  // These two reach MySQL with the first item already inserted, so they prove
  // the rollback; invalid urgency below stops at Zod and proves only that.
  const before = await rowCounts(my, db);
  const repeated = await field1("POST", "/api/requests", {
    impact_id: bellandur,
    description: description("repeat"),
    items: [item(r1), item(r1)],
  });
  check("a repeated resource -> 409 DUPLICATE on the second item",
    repeated.status === 409 && repeated.error?.code === "DUPLICATE" && !!repeated.error?.fields?.["items.1.resource_id"], repeated);
  check("the repeated resource left no rows behind", (await rowCounts(my, db)) === before);
  const unknown = await field1("POST", "/api/requests", {
    impact_id: bellandur,
    description: description("unknown"),
    items: [item(r1), item(FAR_ID)],
  });
  check("an unknown resource_id -> 409 MISSING_REFERENCE on the second item",
    unknown.status === 409 && unknown.error?.code === "MISSING_REFERENCE" && !!unknown.error?.fields?.["items.1.resource_id"], unknown);
  check("the unknown resource left no rows behind", (await rowCounts(my, db)) === before);
  const badUrgency = await field1("POST", "/api/requests", {
    impact_id: bellandur,
    items: [item(r1), item(r2, "URGENT")],
  });
  check("an invalid urgency -> 400 on items.1.urgency",
    badUrgency.status === 400 && !!badUrgency.error?.fields?.["items.1.urgency"], badUrgency);

  // Create rules.
  const closedImpact = await lookup(my, "MYS-NR-MOHALLA impact", IMPACT_BY_GRID, ["MYS-NR-MOHALLA"]);
  const resolvedImpact = await lookup(my, "BLR-YELAHANKA impact", IMPACT_BY_GRID, ["BLR-YELAHANKA"]);
  for (const [what, impact_id, pattern] of [
    ["a CLOSED emergency", closedImpact, /closed/i],
    ["a RESOLVED impact", resolvedImpact, /resolved/i],
  ] as const) {
    const r = await field1("POST", "/api/requests", { impact_id, items: [item(r1)] });
    check(`${what} refuses a request -> 409 RULE`,
      r.status === 409 && r.error?.code === "RULE" && pattern.test(r.error?.message ?? ""), r);
  }
  check("those refusals left no rows behind", (await rowCounts(my, db)) === before);
  const past = await field1("POST", "/api/requests", { impact_id: bellandur, required_by: "2020-01-01T10:00", items: [item(r1)] });
  check("a past required_by -> 400 on required_by", past.status === 400 && !!past.error?.fields?.required_by, past);
  const noImpact = await field1("POST", "/api/requests", { impact_id: FAR_ID, items: [item(r1)] });
  check("an unknown impact -> 404", noImpact.status === 404, noImpact);
  const noItems = await field1("POST", "/api/requests", { impact_id: bellandur, items: [] });
  check("no items -> 400 on items", noItems.status === 400 && !!noItems.error?.fields?.items, noItems);

  const emergency = await coord("POST", "/api/emergencies", { name: `${ZZ_REQ}${RUN} storm`, type: "CYCLONE" });
  const emergencyId: number = emergency.data?.emergency_id;
  const impact = await coord("POST", `/api/emergencies/${emergencyId}/impacts`, {
    grid_id: `${ZZ_REQ}${RUN}-1`,
    latitude: 12.9,
    longitude: 77.6,
  });
  const contain = await coord("PATCH", `/api/emergencies/${emergencyId}`, { status: "CONTAINED" });
  check("fixture emergency is CONTAINED", contain.status === 200 && impact.status === 201, [contain, impact]);
  const searchWord = `medicine${RUN}`;
  const contained = await field1("POST", "/api/requests", {
    impact_id: impact.data?.impact_id,
    description: description(`${searchWord} for the camp`),
    items: [item(r1, "CRITICAL"), item(r2, "LOW")],
  });
  check("a CONTAINED emergency takes a request -> 201", contained.status === 201, contained);
  const ownId: number = contained.data?.request_id;

  // A new request starts as the triggers expect, with its timeline.
  const detail = await field1("GET", `/api/requests/${ownId}`);
  check("the request starts OPEN", detail.data?.request?.status === "OPEN", detail.data?.request);
  check("items start PENDING with everything remaining",
    detail.data?.items?.length === 2 && detail.data.items.every(
      (i: { status: string; quantity_remaining: number; quantity_requested: number; quantity_allocated: number }) =>
        i.status === "PENDING" && i.quantity_allocated === 0 && i.quantity_remaining === i.quantity_requested,
    ), detail.data?.items);
  const created = detail.data?.timeline?.find((e: { action: string }) => e.action === "REQUEST_CREATED");
  check("the timeline shows REQUEST_CREATED, in IST wall-clock form",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(created?.ts ?? "") && created?.actor_name, detail.data?.timeline);
  check("timeline_total counts the request's entries", detail.data?.timeline_total === 1, detail.data?.timeline_total);

  // Roles and ids.
  for (const [method, path, body] of [
    ["GET", "/api/requests", undefined],
    ["POST", "/api/requests", { impact_id: bellandur, items: [item(r1)] }],
    ["GET", `/api/requests/${ownId}`, undefined],
    ["POST", `/api/requests/${ownId}/cancel`, undefined],
  ] as const) {
    check(`signed out ${method} ${path} -> 401`, (await anonymous(method, path, body)).status === 401);
    check(`Center Manager ${method} ${path} -> 403`, (await manager(method, path, body)).status === 403);
  }
  const adminCreate = await admin("POST", "/api/requests", { impact_id: bellandur, items: [item(r1)] });
  check("Admin create -> 403", adminCreate.status === 403, adminCreate);
  check("another Field Officer reading it -> 403", (await field2("GET", `/api/requests/${ownId}`)).status === 403);
  check("another Field Officer cancelling it -> 403", (await field2("POST", `/api/requests/${ownId}/cancel`)).status === 403);
  check("a Coordinator can read it", (await coord("GET", `/api/requests/${ownId}`)).status === 200);
  check("an Admin can read it", (await admin("GET", `/api/requests/${ownId}`)).status === 200);
  check("a missing id GET -> 404", (await coord("GET", `/api/requests/${FAR_ID}`)).status === 404);
  check("a missing id cancel -> 404", (await coord("POST", `/api/requests/${FAR_ID}/cancel`)).status === 404);
  check("a malformed id GET -> 400", (await coord("GET", "/api/requests/abc")).status === 400);
  check("a malformed id cancel -> 400", (await coord("POST", "/api/requests/abc/cancel")).status === 400);

  // Lists: scope, each filter, search.
  const hasId = (r: Res, id: number) => (r.data ?? []).some((x: { request_id: number }) => x.request_id === id);
  const count = (sql: string, params: unknown[] = []) => lookup(my, "count", sql, params);
  const all = await coord("GET", "/api/requests");
  check("a Coordinator lists every request",
    all.data?.length === (await count("SELECT COUNT(*) FROM resource_request")), all.data?.length);
  const mine = await field1("GET", "/api/requests");
  check("a Field Officer lists only their own",
    mine.data?.length === (await count(
      "SELECT COUNT(*) FROM resource_request r JOIN `user` u ON u.user_id = r.user_id WHERE u.email = 'field1@eras.test'",
    )) && hasId(mine, ownId), mine.data?.length);
  check("another Field Officer doesn't see it", !hasId(await field2("GET", "/api/requests"), ownId));
  const blank = await coord("GET", "/api/requests?emergency=&status=&urgency=&q=");
  check("untouched filters -> every request", blank.status === 200 && blank.data?.length === all.data?.length, blank.status);
  const byStatus = await coord("GET", "/api/requests?status=OPEN");
  check("status filter", byStatus.data?.length > 0 && byStatus.data.every((r: { status: string }) => r.status === "OPEN"));
  const byEmergency = await coord("GET", `/api/requests?emergency=${emergencyId}`);
  check("emergency filter", byEmergency.data?.length === 1 && hasId(byEmergency, ownId), byEmergency.data);
  const byUrgency = await coord("GET", "/api/requests?urgency=LOW");
  check("urgency filter matches any item once",
    byUrgency.data?.length === (await count("SELECT COUNT(DISTINCT request_id) FROM request_item WHERE urgency = 'LOW'")) &&
      hasId(byUrgency, ownId), byUrgency.data?.length);
  check("the rollup shows the top urgency, not the alphabetical max",
    byEmergency.data?.[0]?.top_urgency === "CRITICAL" && byEmergency.data?.[0]?.item_count === 2, byEmergency.data);
  check("a bad status -> 400", (await coord("GET", "/api/requests?status=NOPE")).status === 400);
  check("a bad emergency -> 400", (await coord("GET", "/api/requests?emergency=abc")).status === 400);

  check("full-text search finds it", hasId(await coord("GET", `/api/requests?q=${searchWord}`), ownId));
  check("its owner can search for it", hasId(await field1("GET", `/api/requests?q=${searchWord}`), ownId));
  const otherSearch = await field2("GET", `/api/requests?q=${searchWord}`);
  check("another Field Officer's search doesn't find it", otherSearch.status === 200 && otherSearch.data?.length === 0, otherSearch);
  for (const text of HOSTILE_SEARCHES) {
    const r = await coord("GET", `/api/requests?q=${encodeURIComponent(text)}`);
    check(`T17 requests search ${JSON.stringify(text)} -> 200, no rows`, r.status === 200 && r.data?.length === 0, r);
  }

  // Cancel refusals, on seeded requests so nothing has to be built or undone.
  const snapshot = async (id: number) => {
    const [[row]] = await my.query<RowDataPacket[]>(
      `SELECT r.status, (SELECT GROUP_CONCAT(i.status ORDER BY i.request_item_id) FROM request_item i
                          WHERE i.request_id = r.request_id) AS items
         FROM resource_request r WHERE r.request_id = ?`,
      [id],
    );
    return `${row.status}:${row.items}`;
  };
  for (const status of ["RESERVED", "DISPATCHED", "DELIVERED"]) {
    const id = await lookup(
      my,
      `open-emergency request with a ${status} allocation`,
      `SELECT ri.request_id FROM allocation a
         JOIN request_item ri     ON ri.request_item_id = a.request_item_id
         JOIN resource_request r  ON r.request_id = ri.request_id
         JOIN emergency_impact ei ON ei.impact_id = r.impact_id
         JOIN emergency e         ON e.emergency_id = ei.emergency_id
        WHERE a.status = ? AND e.status <> 'CLOSED' AND r.status <> 'CANCELLED'
        LIMIT 1`,
      [status],
    );
    const was = await snapshot(id);
    const r = await coord("POST", `/api/requests/${id}/cancel`);
    check(`a ${status} allocation blocks cancel -> 409 with the request-level message`,
      r.status === 409 && r.error?.code === "RULE" && r.error?.message === HAS_ALLOCATIONS, r);
    check(`the ${status} refusal changed nothing`, (await snapshot(id)) === was);
  }
  const closedRequest = await lookup(
    my,
    "open request on a CLOSED emergency",
    `SELECT r.request_id FROM resource_request r
       JOIN emergency_impact ei ON ei.impact_id = r.impact_id
       JOIN emergency e         ON e.emergency_id = ei.emergency_id
      WHERE e.status = 'CLOSED' AND r.status <> 'CANCELLED' LIMIT 1`,
  );
  const wasClosed = await snapshot(closedRequest);
  const onClosed = await coord("POST", `/api/requests/${closedRequest}/cancel`);
  check("a CLOSED emergency blocks cancel -> 409 RULE",
    onClosed.status === 409 && onClosed.error?.code === "RULE" && /closed/i.test(onClosed.error?.message ?? ""), onClosed);
  check("the CLOSED refusal changed nothing", (await snapshot(closedRequest)) === wasClosed);

  // The app can't make an empty request, so this one is written directly.
  await my.query(
    "INSERT INTO resource_request (impact_id, user_id, description) VALUES (?, (SELECT user_id FROM `user` WHERE email = 'field1@eras.test'), ?)",
    [bellandur, description("no items")],
  );
  const emptyId = await lookup(my, "empty fixture", "SELECT LAST_INSERT_ID()");
  const onEmpty = await coord("POST", `/api/requests/${emptyId}/cancel`);
  check("a request with no items -> 409 RULE, still OPEN",
    onEmpty.status === 409 && onEmpty.error?.code === "RULE" && (await snapshot(emptyId)) === "OPEN:null", onEmpty);

  // Successful cancels: the owner, a Coordinator and an Admin.
  for (const [who, canceller] of [["the owner", field1], ["a Coordinator", coord], ["an Admin", admin]] as const) {
    const made = await field1("POST", "/api/requests", {
      impact_id: bellandur,
      description: description(`cancel by ${who}`),
      items: [item(r1), item(r2)],
    });
    const id: number = made.data?.request_id;
    const cancelled = await canceller("POST", `/api/requests/${id}/cancel`);
    check(`${who} cancels -> 200`, cancelled.status === 200 && cancelled.data?.status === "CANCELLED", cancelled);
    check("items and request are CANCELLED (the trigger rolled it up)",
      (await snapshot(id)) === "CANCELLED:CANCELLED,CANCELLED", await snapshot(id));
    check("it's gone from v_priority_queue",
      (await count("SELECT COUNT(*) FROM v_priority_queue WHERE request_id = ?", [id])) === 0);
    const after = await canceller("GET", `/api/requests/${id}`);
    check("the timeline shows REQUEST_CANCELLED",
      after.data?.timeline?.some((e: { action: string }) => e.action === "REQUEST_CANCELLED"), after.data?.timeline);
    const again = await canceller("POST", `/api/requests/${id}/cancel`);
    check("cancelling again -> 409 RULE", again.status === 409 && again.error?.code === "RULE", again);
  }
}

/** Removes zz_p22_ requests with their items and entries. Runs before the emergencies they hang off. */
async function cleanupRequests(my: Connection, db: Db): Promise<void> {
  const [rows] = await my.query<RowDataPacket[]>(
    "SELECT request_id FROM resource_request WHERE description LIKE ?",
    [`${ZZ_REQ.replaceAll("_", "\\_")}%`],
  );
  const ids = rows.map((r) => r.request_id as number);
  if (ids.length === 0) return;
  // Test fixtures only: activity_log is otherwise never deleted from.
  await db.collection("activity_log").deleteMany({ "refs.request_id": { $in: ids } });
  await my.query("DELETE FROM request_item WHERE request_id IN (?)", [ids]);
  await my.query("DELETE FROM resource_request WHERE request_id IN (?)", [ids]);
}

/** Great-circle distance in km, R = 6371 like fn_distance_km. */
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** 07_seed's two latest observations per impact, newest first, as affected/severity. */
const SEEDED_LATEST: Record<string, string> = {
  "BLR-BELLANDUR": "70/CRITICAL 55/HIGH",
  "BLR-KORAMANGALA": "12/LOW 25/MODERATE",
  "BLR-MAHADEVAPURA": "42/HIGH 30/MODERATE",
  "BLR-YELAHANKA": "2/LOW 6/LOW",
  "KDG-BHAGAMANDALA": "25/MODERATE 15/LOW",
  "KDG-MADIKERI": "55/CRITICAL 40/HIGH",
  "KDG-MAKKANDUR": "65/HIGH 75/CRITICAL",
  "MYS-NANJANGUD": "4/LOW 12/MODERATE",
  "MYS-NR-MOHALLA": "5/LOW 20/MODERATE",
};

/**
 * The seed's reports against MySQL. Only non-fixture rows from before the seed
 * time count, so a report filed through the form later can't fail these.
 */
async function testReportSeed(my: Connection, db: Db): Promise<void> {
  console.log("\nP2.3 Field report seed");
  const seededAt = await seedTime(my);
  const cutoff = dateToIst(seededAt);

  const [rows] = await my.query<RowDataPacket[]>(
    `SELECT o.observation_id, o.impact_id, ei.emergency_id, e.type, e.name, l.grid_id, l.latitude, l.longitude
       FROM impact_observation o
       JOIN emergency_impact ei ON ei.impact_id   = o.impact_id
       JOIN emergency e         ON e.emergency_id = ei.emergency_id
       JOIN location l          ON l.location_id  = ei.location_id
      WHERE e.name NOT LIKE 'zz\\_%' AND o.observed_at <= ?`,
    [cutoff],
  );
  const docs = await db.collection("field_reports").find({ reported_at: { $lte: seededAt } }).toArray();
  const byObservation = new Map(rows.map((r) => [r.observation_id as number, r]));

  check("field_reports count = impact_observation count", docs.length === rows.length, { docs: docs.length, rows: rows.length });
  const missing = docs.filter((d) => !byObservation.has(d.observation_id)).map((d) => d.observation_id);
  const docIds = new Set(docs.map((d) => d.observation_id as number));
  const noReport = rows.filter((r) => !docIds.has(r.observation_id)).map((r) => r.observation_id);
  check("every report has its observation and every observation its report", missing.length === 0 && noReport.length === 0, { missing, noReport });

  const mismatched = docs.filter((d) => {
    const row = byObservation.get(d.observation_id);
    return !row || row.emergency_id !== d.emergency_id || row.impact_id !== d.impact_id || row.type !== d.emergency_type;
  });
  check("each report's emergency, impact and type match MySQL", mismatched.length === 0, mismatched.map((d) => d.observation_id));

  const far = docs.filter((d) => {
    const row = byObservation.get(d.observation_id);
    if (!row) return false;
    const [lng, lat] = d.location.coordinates as [number, number];
    return distanceKm(Number(row.latitude), Number(row.longitude), lat, lng) > 2.05;
  });
  check("every point is within 2.05 km of its impact", far.length === 0, far.map((d) => d.observation_id));

  check("nothing on KDG-NAPOKLU", rows.every((r) => r.grid_id !== "KDG-NAPOKLU"));
  const mysuru = docs.filter((d) => byObservation.get(d.observation_id)?.name === "Mysuru Dengue Outbreak");
  check("Mysuru has exactly 9 reports", mysuru.length === 9, mysuru.length);
  const filed = await db.collection("activity_log").countDocuments({ action: "FIELD_REPORT_FILED", ts: { $lte: seededAt } });
  check("FIELD_REPORT_FILED entries = report count", filed === docs.length, { filed, docs: docs.length });

  const [[{ later }]] = await my.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS later
       FROM impact_observation o
       JOIN emergency_impact ei ON ei.impact_id   = o.impact_id
       JOIN emergency e         ON e.emergency_id = ei.emergency_id
      WHERE e.name NOT LIKE 'zz\\_%' AND o.observed_at > ?`,
    [cutoff],
  );
  if (Number(later) > 0) {
    console.log(`  SKIP  each impact's two latest observations (${later} observations filed since the seed; run db:reset)`);
    return;
  }
  const [latest] = await my.query<RowDataPacket[]>(
    `WITH ranked AS (
       SELECT l.grid_id, o.affected_percentage, o.severity,
              ROW_NUMBER() OVER (PARTITION BY o.impact_id ORDER BY o.observed_at DESC) AS rn
         FROM impact_observation o
         JOIN emergency_impact ei ON ei.impact_id   = o.impact_id
         JOIN emergency e         ON e.emergency_id = ei.emergency_id
         JOIN location l          ON l.location_id  = ei.location_id
        WHERE e.name NOT LIKE 'zz\\_%')
     SELECT grid_id, affected_percentage, severity FROM ranked WHERE rn <= 2 ORDER BY grid_id, rn`,
  );
  const actual: Record<string, string> = {};
  for (const r of latest) {
    const value = `${Number(r.affected_percentage)}/${r.severity}`;
    actual[r.grid_id] = actual[r.grid_id] ? `${actual[r.grid_id]} ${value}` : value;
  }
  check("each impact's two latest observations are still 07_seed's", JSON.stringify(actual) === JSON.stringify(SEEDED_LATEST), actual);
}

/** details that satisfy each emergency type's rules. */
function detailsForType(type: string): Record<string, unknown> {
  if (type === "FLOOD") return { water_level_m: 1.2, roads_submerged: 2, trend: "RISING" };
  if (type === "EARTHQUAKE") return { magnitude: 5.5, buildings_collapsed: 1, trend: "STEADY" };
  if (type === "EPIDEMIC") return { new_cases: 3, deaths: 0, trend: "FALLING" };
  return { checked_by: "zz test", spread_km: 3 };
}

async function testReports(my: Connection, db: Db): Promise<void> {
  console.log("\nP2.3 Field report API");
  const coord = await signIn("coord@eras.test");
  const admin = await signIn("admin@eras.test");
  const field1 = await signIn("field1@eras.test");
  const manager = await signIn("cm.central@eras.test");
  const anonymous = client();

  const [[bellandur]] = await my.query<RowDataPacket[]>(
    `SELECT ei.emergency_id, ei.impact_id, l.latitude, l.longitude
       FROM emergency_impact ei JOIN location l ON l.location_id = ei.location_id
      WHERE l.grid_id = 'BLR-BELLANDUR'`,
  );
  const [[sample]] = await my.query<RowDataPacket[]>(
    "SELECT MIN(observation_id) AS id FROM impact_observation WHERE impact_id = ?",
    [bellandur.impact_id],
  );
  const lat = Number(bellandur.latitude);
  const lng = Number(bellandur.longitude);
  const reports = db.collection("field_reports");

  // Roles, on both routes.
  for (const path of ["/api/reports", `/api/reports/${sample.id}`]) {
    check(`signed out ${path} -> 401`, (await anonymous("GET", path)).status === 401);
    check(`Center Manager ${path} -> 403`, (await manager("GET", path)).status === 403);
    for (const [who, call] of [["Admin", admin], ["Coordinator", coord], ["Field Officer", field1]] as const) {
      check(`${who} ${path} -> 200`, (await call("GET", path)).status === 200);
    }
  }

  // The plain list, and what MySQL adds to it.
  const all = await field1("GET", "/api/reports");
  check("the plain list isn't capped and its total matches", all.data?.capped === false && all.data?.total === all.data?.reports?.length, all.data?.total);
  const times: string[] = all.data?.reports?.map((r: { reported_at: string }) => r.reported_at) ?? [];
  check("the plain list is newest first", times.every((t, i) => i === 0 || times[i - 1] >= t));
  const first = all.data?.reports?.[0];
  check("rows are enriched from MySQL",
    all.data?.reports?.every((r: Record<string, unknown>) =>
      r.grid_id && r.severity && r.emergency_name && r.emergency_status && r.reporter && r.observed_at && r.affected_percentage !== null), first);
  check("times are IST strings and no Mongo _id leaks", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(first?.reported_at ?? "") && !("_id" in (first ?? {})), first);
  check("distance is null outside a near search", first?.distance_m === null, first);

  // Filters.
  const byEmergency = await coord("GET", `/api/reports?emergency=${bellandur.emergency_id}`);
  check("?emergency= returns only that emergency, with the right total",
    byEmergency.data?.reports?.every((r: { emergency_id: number }) => r.emergency_id === bellandur.emergency_id) &&
      byEmergency.data?.total === (await reports.countDocuments({ emergency_id: bellandur.emergency_id })), byEmergency.data?.total);
  const byType = await coord("GET", "/api/reports?type=EPIDEMIC");
  check("?type= returns only that type", byType.data?.reports?.length > 0 && byType.data.reports.every((r: { emergency_type: string }) => r.emergency_type === "EPIDEMIC"), byType.data?.total);
  const neither = await coord("GET", `/api/reports?emergency=${bellandur.emergency_id}&type=EPIDEMIC`);
  check("filters combine", neither.status === 200 && neither.data?.total === 0, neither.data?.total);

  // Near.
  const near = await coord("GET", `/api/reports?near=${lat},${lng}&km=1.5`);
  const distances: number[] = near.data?.reports?.map((r: { distance_m: number }) => r.distance_m) ?? [];
  check("near finds reports, all within km", distances.length > 0 && distances.every((d) => d <= 1500), distances.slice(-3));
  check("near is sorted by distance", distances.every((d, i) => i === 0 || distances[i - 1] <= d));
  const nearDefault = await coord("GET", `/api/reports?near=${lat},${lng}`);
  check("near defaults to 5 km", nearDefault.data?.reports?.every((r: { distance_m: number }) => r.distance_m <= 5000) && nearDefault.data?.total >= near.data?.total, nearDefault.data?.total);
  const nearOther = await coord("GET", `/api/reports?near=${lat},${lng}&type=EPIDEMIC`);
  check("near applies the filters", nearOther.status === 200 && nearOther.data?.total === 0, nearOther.data?.total);
  const blankQ = await coord("GET", `/api/reports?q=&near=${lat},${lng}`);
  check("a blank q doesn't conflict with near", blankQ.status === 200, blankQ.error);

  // Text.
  const text = await coord("GET", "/api/reports?q=evacuation");
  check("q finds a known word, with the right total",
    text.data?.reports?.length > 0 && text.data?.total === (await reports.countDocuments({ $text: { $search: "evacuation" } })), text.data?.total);
  const textType = await coord("GET", "/api/reports?q=landslide&type=LANDSLIDE");
  check("q applies the filters", textType.data?.reports?.length > 0 && textType.data.reports.every((r: { emergency_type: string }) => r.emergency_type === "LANDSLIDE"), textType.data?.total);
  const phrase = await coord("GET", `/api/reports?q=${encodeURIComponent('"drinking water"')}`);
  check("a quoted phrase is searched", phrase.status === 200 && phrase.data?.total > 0, phrase.data?.total);
  for (const term of HOSTILE_SEARCHES) {
    const res = await coord("GET", `/api/reports?q=${encodeURIComponent(term)}`);
    check(`hostile search ${JSON.stringify(term)} -> 200`, res.status === 200, res);
  }

  // Refusals.
  const both = await coord("GET", `/api/reports?q=water&near=${lat},${lng}`);
  check("q + near -> 400 on near", both.status === 400 && both.error?.code === "VALIDATION" && !!both.error?.fields?.near, both);
  for (const bad of ["abc", "12.9", "91,77", "12,181", "12,abc", "1e1,77", "12.9,"]) {
    const res = await coord("GET", `/api/reports?near=${encodeURIComponent(bad)}`);
    check(`near=${bad} -> 400 on near`, res.status === 400 && !!res.error?.fields?.near, res);
  }
  for (const bad of ["0", "0.05", "51", "abc", "-1", "1e1"]) {
    const res = await coord("GET", `/api/reports?near=${lat},${lng}&km=${bad}`);
    check(`km=${bad} -> 400 on km`, res.status === 400 && !!res.error?.fields?.km, res);
  }
  check("a bad km is refused without near too", (await coord("GET", "/api/reports?km=99")).status === 400);
  check("a valid km without near is ignored", (await coord("GET", "/api/reports?km=3")).status === 200);
  check("a bad type -> 400", (await coord("GET", "/api/reports?type=METEOR")).status === 400);
  check("a bad emergency -> 400", (await coord("GET", "/api/reports?emergency=abc")).status === 400);

  // One report.
  for (const bad of ["abc", "0", "-1", "1e3"]) {
    check(`/api/reports/${bad} -> 400`, (await coord("GET", `/api/reports/${bad}`)).status === 400);
  }
  check("a missing report -> 404", (await coord("GET", "/api/reports/2147483647")).status === 404);
  const one = await field1("GET", `/api/reports/${sample.id}`);
  check("the detail has the document and the MySQL row",
    one.data?.observation_id === sample.id && !!one.data?.notes && one.data?.details?.water_level_m !== undefined &&
      Array.isArray(one.data?.needs_observed) && !!one.data?.severity && one.data?.grid_id === "BLR-BELLANDUR" && !("_id" in (one.data ?? {})), one.data);

  // Done when: a report filed for every type is found by emergency, distance and text.
  let otherEmergency = 0;
  let otherImpact = 0;
  for (const [i, type] of EMERGENCY_TYPES.entries()) {
    const created = await coord("POST", "/api/emergencies", { name: `${ZZ_REP}${RUN} ${type}`, type });
    const emergencyId: number = created.data?.emergency_id;
    const siteLat = 20 + i;
    const siteLng = 80.5;
    const impact = await coord("POST", `/api/emergencies/${emergencyId}/impacts`, {
      grid_id: `${ZZ_REP}${RUN}-${i}`,
      latitude: siteLat,
      longitude: siteLng,
    });
    const impactId: number = impact.data?.impact_id;
    if (type === "OTHER") {
      otherEmergency = emergencyId;
      otherImpact = impactId;
    }

    // Letters and digits only, so the word doesn't depend on how MongoDB splits text.
    const word = `zzp23${RUN}${type.toLowerCase()}`;
    const filed = await field1("POST", "/api/observations", {
      impact_id: impactId,
      emergency_type: type,
      affected_percentage: 30,
      severity: "HIGH",
      details: detailsForType(type),
      notes: `Field check ${word} at the site.`,
    });
    check(`${type}: filed -> 201`, filed.status === 201, filed);
    const id: number = filed.data?.observation_id;
    const has = (res: Res) => res.data?.reports?.some((r: { observation_id: number }) => r.observation_id === id);

    check(`${type}: found by emergency`, has(await coord("GET", `/api/reports?emergency=${emergencyId}`)));
    check(`${type}: found near its impact`, has(await coord("GET", `/api/reports?near=${siteLat},${siteLng}&km=1`)));
    const search = await coord("GET", `/api/reports?q=${word}`);
    check(`${type}: found by a word in its notes`, has(search) && search.data?.total === 1, search.data);
    const detail = await coord("GET", `/api/reports/${id}`);
    check(`${type}: its detail shows what was filed`,
      detail.data?.emergency_type === type && detail.data?.severity === "HIGH" && detail.data?.affected_percentage === 30 &&
        Object.keys(detailsForType(type)).every((k) => detail.data?.details?.[k] !== undefined), detail.data);
  }

  const wrongType = await field1("POST", "/api/observations", {
    impact_id: otherImpact,
    emergency_type: "FLOOD",
    affected_percentage: 10,
    severity: "LOW",
    details: detailsForType("FLOOD"),
  });
  check("a type that doesn't match the emergency -> 400 on emergency_type", wrongType.status === 400 && !!wrongType.error?.fields?.emergency_type, wrongType);

  // HANDOFF 4.4's known gap: a report whose observation row is missing still shows.
  const orphanId = 2147483000;
  await reports.insertOne({
    emergency_id: otherEmergency,
    impact_id: otherImpact,
    observation_id: orphanId,
    emergency_type: "OTHER",
    reported_by: { user_id: 1, name: "zz orphan reporter" },
    reported_at: new Date(),
    location: { type: "Point", coordinates: [80.5, 27] },
    details: {},
  });
  const orphans = await coord("GET", `/api/reports?emergency=${otherEmergency}`);
  const orphan = orphans.data?.reports?.find((r: { observation_id: number }) => r.observation_id === orphanId);
  check("a report with no observation row shows, with null MySQL fields and the document's reporter",
    orphan?.severity === null && orphan?.grid_id === null && orphan?.reporter === "zz orphan reporter", orphan);
}

/** The first column of the first row. */
async function scalar(my: Connection, sql: string, params: unknown[] = []): Promise<unknown> {
  const [rows] = await my.query<RowDataPacket[]>(sql, params);
  return Object.values(rows[0])[0];
}

/** One numeric column, every row. */
async function numbers(my: Connection, sql: string, params: unknown[] = []): Promise<number[]> {
  const [rows] = await my.query<RowDataPacket[]>(sql, params);
  return rows.map((r) => Number(Object.values(r)[0]));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_LIMIT_MS = 1000;

type FeedEntry = {
  ts: string;
  actor_user_id: number | null;
  entity_type: string;
  refs: { request_id?: number; center_id?: number } | null;
  payload: Record<string, unknown> | null;
};

/**
 * Runs first in main(), before other tests add fixtures. Numbers are compared
 * with SQL and MongoDB read here, not hard-coded, because seeded expiry bands move
 * at midnight. Scoping is read from the response's own fields.
 */
async function testDashboard(my: Connection, db: Db): Promise<void> {
  console.log("\nP2.4 Dashboard");
  const PATH = "/api/dashboard";
  const EMAILS = {
    admin: "admin@eras.test",
    coord: "coord@eras.test",
    field1: "field1@eras.test",
    field2: "field2@eras.test",
    central: "cm.central@eras.test",
    kodagu: "cm.kodagu@eras.test",
  } as const;
  type Who = keyof typeof EMAILS;
  const everyone = Object.keys(EMAILS) as Who[];

  check("signed out -> 401", (await client()("GET", PATH)).status === 401);
  const calls = {} as Record<Who, Call>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = {} as Record<Who, any>;
  for (const who of everyone) {
    calls[who] = await signIn(EMAILS[who]);
    const res = await calls[who]("GET", PATH);
    check(`${who} -> 200`, res.status === 200, res);
    data[who] = res.data;
  }
  if (everyone.some((who) => !data[who])) return; // Reported above; the rest would only repeat it.

  const userId = async (who: Who) => Number(await scalar(my, "SELECT user_id FROM `user` WHERE email = ?", [EMAILS[who]]));
  const centerId = async (who: Who) => Number(await scalar(my, "SELECT center_id FROM `user` WHERE email = ?", [EMAILS[who]]));
  const field1Id = await userId("field1");
  const field2Id = await userId("field2");
  const centralCenter = await centerId("central");
  const kodaguCenter = await centerId("kodagu");

  // KPIs
  const active = Number(await scalar(my, "SELECT COUNT(*) FROM emergency WHERE status = 'ACTIVE'"));
  const expected = {} as Record<Who, unknown[]>;
  expected.admin = [
    await scalar(my, "SELECT COUNT(*) FROM v_priority_queue"),
    await scalar(my, "SELECT COUNT(*) FROM v_priority_queue WHERE urgency = 'CRITICAL'"),
    await scalar(my, "SELECT COUNT(*) FROM v_expiring_stock"),
    await scalar(my, "SELECT COUNT(*) FROM v_stock_availability WHERE usable_quantity = 0 AND center_status <> 'CLOSED'"),
  ];
  expected.coord = expected.admin;
  for (const [who, id] of [["field1", field1Id], ["field2", field2Id]] as const) {
    expected[who] = [
      await scalar(my, "SELECT COUNT(*) FROM v_priority_queue q JOIN resource_request r ON r.request_id = q.request_id WHERE r.user_id = ?", [id]),
      await scalar(my, "SELECT COUNT(*) FROM v_priority_queue q JOIN resource_request r ON r.request_id = q.request_id WHERE r.user_id = ? AND q.urgency = 'CRITICAL'", [id]),
      null,
      null,
    ];
  }
  for (const [who, center] of [["central", centralCenter], ["kodagu", kodaguCenter]] as const) {
    expected[who] = [
      await scalar(my, "SELECT COUNT(DISTINCT request_item_id) FROM v_batch_suggestions WHERE center_id = ?", [center]),
      await scalar(my, "SELECT COUNT(DISTINCT b.request_item_id) FROM v_batch_suggestions b JOIN v_priority_queue q ON q.request_item_id = b.request_item_id WHERE b.center_id = ? AND q.urgency = 'CRITICAL'", [center]),
      await scalar(my, "SELECT COUNT(*) FROM v_expiring_stock WHERE center_id = ?", [center]),
      await scalar(my, "SELECT COUNT(*) FROM v_stock_availability WHERE usable_quantity = 0 AND center_status <> 'CLOSED' AND center_id = ?", [center]),
    ];
  }
  for (const who of everyone) {
    const k = data[who].kpis;
    check(`${who}: active emergencies`, k.active_emergencies === active, k);
    const got = [k.open_items, k.critical_items, k.expiring_batches, k.out_of_stock];
    const want = expected[who].map((v) => (v === null ? null : Number(v)));
    check(`${who}: open, critical, expiring, out of stock`, JSON.stringify(got) === JSON.stringify(want), { got, want });
  }

  // Report pipelines: the IST days come from MySQL's own calendar
  const today = String(await scalar(my, "SELECT CURDATE()"));
  const firstDay = String(await scalar(my, "SELECT DATE_SUB(CURDATE(), INTERVAL ? DAY)", [REPORT_WINDOW_DAYS - 1]));
  const from = istToDate(`${firstDay} 00:00:00`);
  const to = new Date(istToDate(`${today} 00:00:00`).getTime() + DAY_MS);
  const reports = db.collection("field_reports");
  const windowCount = await reports.countDocuments({ reported_at: { $gte: from, $lt: to } });
  const total = await reports.countDocuments({});

  for (const who of everyone) {
    const { reportsByDay: buckets, topNeeds: needs, summary } = data[who];
    check(`${who}: ${REPORT_WINDOW_DAYS} day buckets`, buckets.length === REPORT_WINDOW_DAYS, buckets.length);
    check(`${who}: the last bucket is today's IST date (MySQL CURDATE())`, buckets.at(-1)?.day === today, { got: buckets.at(-1)?.day, today });
    check(`${who}: the first bucket is ${REPORT_WINDOW_DAYS - 1} days earlier`, buckets[0]?.day === firstDay, buckets[0]?.day);
    const times: number[] = buckets.map((b: { day: string }) => Date.parse(`${b.day}T00:00:00Z`));
    check(`${who}: buckets are consecutive days`, times.every((t, i) => i === 0 || t - times[i - 1] === DAY_MS), times);
    const bucketSum = buckets.reduce((n: number, b: { total: number }) => n + b.total, 0);
    check(`${who}: buckets add up to the reports in the window`, bucketSum === windowCount, { bucketSum, windowCount });
    check(`${who}: each bucket's types add up to its total`,
      buckets.every((b: { total: number; counts: Record<string, number> }) => Object.values(b.counts).reduce((n, c) => n + c, 0) === b.total));

    check(`${who}: topNeeds at most ${TOP_NEEDS_LIMIT} and not empty`, needs.length > 0 && needs.length <= TOP_NEEDS_LIMIT, needs.length);
    check(`${who}: topNeeds sorted descending`,
      needs.every((n: { quantity: number }, i: number) => i === 0 || needs[i - 1].quantity >= n.quantity), needs);

    const sum = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
    check(`${who}: summary.total is every report`, summary.total === total, summary.total);
    check(`${who}: byType adds up to the total`, sum(summary.byType) === total, summary.byType);
    check(`${who}: byTrend adds up to the total`, sum(summary.byTrend) === total, summary.byTrend);
    check(`${who}: byTrend has a bucket for a missing trend`, summary.byTrend.some((t: { trend: unknown }) => t.trend === null), summary.byTrend);
  }

  const windowDocs = await reports
    .find<{ needs_observed?: { item: string; est_qty?: number; unit?: string }[] }>(
      { reported_at: { $gte: from, $lt: to } },
      { projection: { needs_observed: 1 } },
    )
    .toArray();
  const needTotals = new Map<string, number>();
  for (const need of windowDocs.flatMap((d) => d.needs_observed ?? [])) {
    const key = `${need.item}|${need.unit ?? ""}`;
    needTotals.set(key, (needTotals.get(key) ?? 0) + (need.est_qty ?? 0));
  }
  const topQuantities = [...needTotals.values()].sort((a, b) => b - a).slice(0, TOP_NEEDS_LIMIT);
  const topNeeds: { item: string; unit: string | null; quantity: number }[] = data.admin.topNeeds;
  check("topNeeds matches a sum by item and unit",
    JSON.stringify(topNeeds.map((n) => n.quantity)) === JSON.stringify(topQuantities) &&
      topNeeds.every((n) => needTotals.get(`${n.item}|${n.unit ?? ""}`) === n.quantity),
    { got: topNeeds, want: topQuantities });

  // Latest reports: everyone who can open them, never a Center Manager
  for (const who of ["admin", "coord", "field1", "field2"] as const) {
    const latest: { reported_at: string; grid_id: unknown }[] = data[who].summary.latest;
    check(`${who}: latest ${LATEST_REPORTS_LIMIT} reports, newest first, with MySQL fields`,
      latest.length === LATEST_REPORTS_LIMIT && latest.every((r, i) => r.grid_id !== null && (i === 0 || latest[i - 1].reported_at >= r.reported_at)),
      latest);
  }
  for (const who of ["central", "kodagu"] as const) {
    check(`${who}: no reports in latest`, data[who].summary.latest.length === 0, data[who].summary.latest);
  }

  // Map: the same for every role
  const impactCount = Number(await scalar(my, "SELECT COUNT(*) FROM emergency_impact ei JOIN emergency e ON e.emergency_id = ei.emergency_id WHERE e.status <> 'CLOSED'"));
  const centerCount = Number(await scalar(my, "SELECT COUNT(*) FROM resource_center"));
  const impacts: { grid_id: string; latest_severity: unknown }[] = data.admin.impacts;
  const centers: unknown[] = data.admin.centers;
  check("map: every impact of a non-CLOSED emergency", impacts.length === impactCount, impacts.length);
  check("map: no impact of the CLOSED emergency", !impacts.some((i) => i.grid_id.startsWith("MYS-")), impacts);
  check("map: Napoklu has no severity yet", impacts.find((i) => i.grid_id === "KDG-NAPOKLU")?.latest_severity === null, impacts);
  check("map: every center", centers.length === centerCount, centers.length);
  check("map: the same for every role",
    everyone.every((who) => JSON.stringify([data[who].impacts, data[who].centers]) === JSON.stringify([impacts, centers])));

  // Activity feed
  const feeds = Object.fromEntries(everyone.map((who) => [who, data[who].recentActivity as FeedEntry[]])) as Record<Who, FeedEntry[]>;
  for (const who of everyone) {
    const feed = feeds[who];
    check(`${who}: feed holds ${ACTIVITY_FEED_LIMIT} entries`, feed.length === ACTIVITY_FEED_LIMIT, feed.length);
    check(`${who}: feed is newest first`, feed.every((e, i) => i === 0 || feed[i - 1].ts >= e.ts), feed.map((e) => e.ts));
    check(`${who}: every entity type is a known one`,
      feed.every((e) => (ACTIVITY_ENTITY_TYPES as readonly string[]).includes(e.entity_type)), feed.map((e) => e.entity_type));
  }
  const newest = await db.collection("activity_log").find().sort({ ts: -1 }).limit(1).next();
  check("admin: feed starts at the newest entry", newest !== null && feeds.admin[0]?.ts === dateToIst(newest.ts), feeds.admin[0]?.ts);

  const fieldReports = everyone.flatMap((who) => feeds[who]).filter((e) => e.entity_type === "FIELD_REPORT");
  check("FIELD_REPORT entries carry the type their subject shows",
    fieldReports.length > 0 && fieldReports.every((e) => typeof e.payload?.emergency_type === "string"), fieldReports.length);

  // Scoping, from the fields the response carries
  const requestsOf = (id: number) => numbers(my, "SELECT request_id FROM resource_request WHERE user_id = ?", [id]);
  const field1Requests = await requestsOf(field1Id);
  const field2Requests = await requestsOf(field2Id);
  check("field1 and field2 have requests to tell apart", field1Requests.length > 0 && field2Requests.length > 0);
  for (const [who, id, own, other] of [
    ["field1", field1Id, field1Requests, field2Requests],
    ["field2", field2Id, field2Requests, field1Requests],
  ] as const) {
    check(`${who}: every entry is theirs or on one of their requests`,
      feeds[who].every((e) => e.actor_user_id === id || (e.refs?.request_id !== undefined && own.includes(e.refs.request_id))), feeds[who]);
    check(`${who}: no entry is on the other officer's requests`,
      !feeds[who].some((e) => e.refs?.request_id !== undefined && other.includes(e.refs.request_id)), feeds[who]);
  }
  for (const [who, own, other] of [
    ["central", centralCenter, kodaguCenter],
    ["kodagu", kodaguCenter, centralCenter],
  ] as const) {
    check(`${who}: every entry is at their center`, feeds[who].every((e) => e.refs?.center_id === own), feeds[who]);
    check(`${who}: no entry is at the other manager's center`, !feeds[who].some((e) => e.refs?.center_id === other), feeds[who]);
  }

  // Done when: under a second for every role, warm (the calls above warmed it).
  for (const who of everyone) {
    let slowest = 0;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      await calls[who]("GET", PATH);
      slowest = Math.max(slowest, performance.now() - started);
    }
    console.log(`        ${who}: slowest of 5 warm runs ${Math.round(slowest)} ms`);
    check(`${who}: under ${DASHBOARD_LIMIT_MS} ms`, slowest < DASHBOARD_LIMIT_MS, Math.round(slowest));
  }
}

/** Removes every fixture emergency with its impacts, observations, reports and entries, and fixture locations. */
async function cleanup(my: Connection, db: Db): Promise<void> {
  await cleanupRequests(my, db);
  for (const prefix of [ZZ, ZZ_REQ, ZZ_REP]) {
    const like = `${prefix.replaceAll("_", "\\_")}%`;
    const [emergencies] = await my.query<RowDataPacket[]>("SELECT emergency_id FROM emergency WHERE name LIKE ?", [like]);
    for (const { emergency_id } of emergencies) {
      // Test fixtures only: activity_log is otherwise never deleted from.
      await db.collection("activity_log").deleteMany({ "refs.emergency_id": emergency_id });
      await db.collection("field_reports").deleteMany({ emergency_id });
      await my.query(
        `DELETE o FROM impact_observation o
           JOIN emergency_impact ei ON ei.impact_id = o.impact_id
          WHERE ei.emergency_id = ?`,
        [emergency_id],
      );
      await my.query("DELETE FROM emergency_impact WHERE emergency_id = ?", [emergency_id]);
      await my.query("DELETE FROM emergency WHERE emergency_id = ?", [emergency_id]);
    }
    await my.query("DELETE FROM location WHERE grid_id LIKE ?", [like]);
  }
}

async function main(): Promise<void> {
  const env = loadEnv([...MYSQL_APP_KEYS, ...MONGO_KEYS]);
  try {
    await fetch(BASE);
  } catch {
    throw new ScriptError(`nothing is answering at ${BASE}. Start the app first: npm run dev`);
  }
  const my = await appConnection(env);
  const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    const db = mongo.db(env.MONGODB_DB);
    await cleanup(my, db);
    try {
      await testDashboard(my, db);
      await testEmergencies(my);
      await testRequests(my, db);
      await testReportSeed(my, db);
      await testReports(my, db);
    } finally {
      await cleanup(my, db);
    }
  } finally {
    await my.end();
    await mongo.close();
  }

  if (failures > 0) throw new ScriptError(`${failures} check(s) failed`);
  console.log("\napi:test passed");
}

runScript("api:test", main);
