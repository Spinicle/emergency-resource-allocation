/**
 * npm run api:test:p2
 *
 * End-to-end checks of the Part 2 API against the running app: real HTTP, real
 * cookies, real MySQL and MongoDB. P2.1: each "Done when", RBAC, filters,
 * full-text search and T17, the CLOSED and type rules. P2.2: the /allocate rank
 * of a new CRITICAL item, rollback, create and cancel rules, roles, filters.
 *
 *   1. npm run db:reset       (the rank check expects the seeded queue)
 *   2. npm run dev            (in a second terminal)
 *   3. npm run api:test:p2    (API_BASE_URL if the app isn't on http://localhost:3000)
 *
 * Fixtures use zz_p21_ / zz_p22_ names and are removed at the end (also after a
 * failure, and left-overs from an aborted run at the start), so db:test stays green.
 * Exits 1 if any check fails.
 */
import { type Db, MongoClient } from "mongodb";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { appConnection } from "./lib/app-connection";
import { loadEnv, MONGO_KEYS, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

const BASE = process.env.API_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "Eras@2026"; // the seeded local-dev password (HANDOFF 4.8)
const ZZ = "zz_p21_"; // fixture prefix: emergency names and grid ids
const ZZ_REQ = "zz_p22_"; // P2.2's prefix: those, and request descriptions
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

/** Removes every fixture emergency with its impacts, observations, reports and entries, and fixture locations. */
async function cleanup(my: Connection, db: Db): Promise<void> {
  await cleanupRequests(my, db);
  for (const prefix of [ZZ, ZZ_REQ]) {
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
      await testEmergencies(my);
      await testRequests(my, db);
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
