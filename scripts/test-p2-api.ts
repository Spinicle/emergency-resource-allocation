/**
 * npm run api:test:p2
 *
 * End-to-end checks of the Part 2 API against the running app: real HTTP, real
 * cookies, real MySQL and MongoDB. P2.1: each "Done when", RBAC, filters,
 * full-text search and T17, the CLOSED and type rules.
 *
 *   1. npm run db:reset
 *   2. npm run dev            (in a second terminal)
 *   3. npm run api:test:p2    (API_BASE_URL if the app isn't on http://localhost:3000)
 *
 * Fixtures use zz_p21_ names and are removed at the end (also after a failure,
 * and left-overs from an aborted run at the start), so db:test stays green.
 * Exits 1 if any check fails.
 */
import { type Db, MongoClient } from "mongodb";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { appConnection } from "./lib/app-connection";
import { loadEnv, MONGO_KEYS, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

const BASE = process.env.API_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "Eras@2026"; // the seeded local-dev password (HANDOFF 4.8)
const ZZ = "zz_p21_"; // fixture prefix: emergency names and grid ids
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

/** Removes every zz_p21_ emergency with its impacts, observations, reports and entries, and zz_p21_ locations. */
async function cleanup(my: Connection, db: Db): Promise<void> {
  const [emergencies] = await my.query<RowDataPacket[]>(
    "SELECT emergency_id FROM emergency WHERE name LIKE ?",
    [`${ZZ.replaceAll("_", "\\_")}%`],
  );
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
  await my.query("DELETE FROM location WHERE grid_id LIKE ?", [`${ZZ.replaceAll("_", "\\_")}%`]);
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
