/**
 * npm run mongo:test — checks the MongoDB side (docs/HANDOFF.md 4.4, Appendix A).
 *
 * Runs as the app user (MYSQL_USER) against the MySQL and MongoDB databases
 * in .env.local. Safe on a seeded database: fixtures use zz_ names, zz_
 * scratch collections and ids no seed row has, and are removed at the end.
 *
 *  1. Seed backfill: activity_log counts per action equal MySQL's, derived
 *     times sit inside their bounds, stored times match their rows. These run
 *     only while the database is untouched since the seed (like t_seed's
 *     Part B); otherwise they print SKIP.
 *  2. T12: a FLOOD report without water_level_m, inserted directly -> 121.
 *  3. Zod and the field_reports validator agree on a shared set of fixtures;
 *     whole-number doubles (as mongosh and Compass store them) pass both validators.
 *  4. fileFieldReport: a report lands in both databases with one instant;
 *     T13: a report only the validator rejects leaves no observation behind.
 *
 * Prints PASS / FAIL / SKIP per check; exits 1 on any FAIL.
 */
import { type Db, Double, MongoClient } from "mongodb";
import type { Connection } from "mysql2/promise";
import type { ActivityAction, ActivityEntry } from "../src/lib/activity";
import { dateToIst, istToDate } from "../src/lib/ist";
import { observationSchema } from "../src/lib/validators/observations";
import { seedTime } from "../db/mongo/activity_backfill";
import { ACTIVITY_LOG, activityLogSchema } from "../db/mongo/activity_log";
import {
  buildReportDoc,
  createFieldReports,
  FIELD_REPORTS,
  fileFieldReport,
  type ReportContent,
} from "../db/mongo/field_reports";
import { selectRows } from "../db/mongo/queryable";
import { appConnection } from "./lib/app-connection";
import { loadEnv, MONGO_KEYS, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

const SCRATCH = "zz_field_reports_check";
const SCRATCH_LOG = "zz_activity_log_check";
const ZZ = "zz_mongo_test";

let fails = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) fails++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `  (${detail})` : ""}`);
}
const skip = (name: string, why: string) => console.log(`  SKIP  ${name}  (${why})`);

/** The error code a promise rejects with (MongoDB: a number, mysql2: e.g. "ER_DUP_ENTRY"), or "ok". */
async function outcome(p: Promise<unknown>): Promise<number | string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "number" || typeof code === "string" ? code : String(err);
  }
}

// ---------------------------------------------------------------------------
// 1. Seed backfill
// ---------------------------------------------------------------------------

async function checkBackfill(db: Db, my: Connection): Promise<void> {
  console.log("\n1. activity_log backfill from the seed");
  const seededAt = await seedTime(my);
  const iso = (d: Date) => d.toISOString();

  // Untouched: no stored MySQL time and no activity entry after the seed (zz_ fixtures excluded).
  const [{ n: laterRows }] = await selectRows<{ n: number }>(
    my,
    `SELECT (SELECT COUNT(*) FROM stock_ledger sl JOIN stock s ON s.stock_id = sl.stock_id
              WHERE s.batch_code NOT LIKE 'zz\\_%' AND sl.changed_at > ?)
          + (SELECT COUNT(*) FROM allocation WHERE allocated_at > ?)
          + (SELECT COUNT(*) FROM resource_request WHERE requested_at > ?) AS n`,
    [dateToIst(seededAt), dateToIst(seededAt), dateToIst(seededAt)],
  );
  const laterEntries = await db.collection(ACTIVITY_LOG).countDocuments({ ts: { $gt: seededAt } });
  if (Number(laterRows) > 0 || laterEntries > 0) {
    skip("backfill checks", `the database changed since the seed (${laterRows} rows, ${laterEntries} entries); run db:reset`);
    return;
  }

  const entries = await db.collection<ActivityEntry>(ACTIVITY_LOG).find({ action: { $ne: "FIELD_REPORT_FILED" } }).toArray();
  const count = (a: ActivityAction) => entries.filter((e) => e.action === a).length;
  const [mysqlCounts] = await selectRows<Record<string, number>>(
    my,
    `SELECT (SELECT COUNT(*) FROM resource_request) AS REQUEST_CREATED,
            (SELECT COUNT(*) FROM resource_request WHERE status = 'CANCELLED') AS REQUEST_CANCELLED,
            (SELECT COUNT(*) FROM allocation) AS ALLOCATION_CREATED,
            (SELECT COUNT(*) FROM allocation WHERE status IN ('DISPATCHED', 'DELIVERED')) AS ALLOCATION_DISPATCHED,
            (SELECT COUNT(*) FROM allocation WHERE status = 'DELIVERED') AS ALLOCATION_DELIVERED,
            (SELECT COUNT(*) FROM stock_ledger WHERE reason = 'ALLOCATION_CANCELLED') AS ALLOCATION_CANCELLED,
            (SELECT COUNT(*) FROM stock_ledger WHERE reason = 'RECEIPT') AS STOCK_RECEIVED,
            (SELECT COUNT(*) FROM stock_ledger WHERE reason = 'ADJUSTMENT') AS STOCK_ADJUSTED,
            (SELECT COUNT(*) FROM stock_ledger WHERE reason = 'WRITE_OFF') AS STOCK_WRITTEN_OFF`,
  );
  // The backfilled actions are the columns above. Part 2 adds live-only actions
  // to ACTIVITY_ACTIONS (HANDOFF 4.4), which the seed has none of.
  for (const action of Object.keys(mysqlCounts) as ActivityAction[]) {
    const expected = Number(mysqlCounts[action]);
    check(`${action}: ${count(action)} entries = ${expected} in MySQL`, count(action) === expected);
  }
  check("no entry after the seed time", entries.every((e) => e.ts <= seededAt));

  // Stored times: each entry's ts is its row's DATETIME, read as IST.
  const requests = await selectRows<{ request_id: number; requested_at: string; user_id: number }>(
    my,
    "SELECT request_id, requested_at, user_id FROM resource_request",
  );
  const allocations = await selectRows<{ allocation_id: number; allocated_at: string; request_id: number }>(
    my,
    `SELECT a.allocation_id, a.allocated_at, ri.request_id
       FROM allocation a JOIN request_item ri ON ri.request_item_id = a.request_item_id`,
  );
  const ledger = await selectRows<{ ledger_id: number; reason: string; changed_at: string; allocation_id: number | null }>(
    my,
    "SELECT ledger_id, reason, changed_at, allocation_id FROM stock_ledger",
  );
  const requestAt = new Map(requests.map((r) => [r.request_id, istToDate(r.requested_at)]));
  const allocatedAt = new Map(allocations.map((a) => [a.allocation_id, istToDate(a.allocated_at)]));
  const changedAt = new Map(ledger.map((l) => [l.ledger_id, istToDate(l.changed_at)]));
  const stored = entries.filter((e) => !e.payload?.derived);
  const mismatched = stored.filter((e) => {
    const want =
      e.action === "REQUEST_CREATED"
        ? requestAt.get(e.entity.id)
        : e.action === "ALLOCATION_CREATED"
          ? allocatedAt.get(e.entity.id)
          : changedAt.get(e.payload?.ledger_id as number);
    return !want || iso(want) !== iso(e.ts);
  });
  check(`${stored.length} stored-time entries match their MySQL rows (IST)`, mismatched.length === 0,
    mismatched.slice(0, 3).map((e) => `${e.action} ${e.entity.id}`).join(", "));

  // Derived times: after what they follow, before what follows them, never after the seed.
  const cancelAt = new Map(
    ledger.filter((l) => l.reason === "ALLOCATION_CANCELLED").map((l) => [l.allocation_id!, istToDate(l.changed_at)]),
  );
  const at = (action: ActivityAction, id: number) => entries.find((e) => e.action === action && e.entity.id === id)?.ts;
  const badDispatch = entries.filter((e) => {
    if (e.action !== "ALLOCATION_DISPATCHED") return false;
    const from = allocatedAt.get(e.entity.id)!;
    const to = cancelAt.get(e.entity.id) ?? seededAt;
    return !(e.payload?.derived === true && e.ts > from && e.ts < to);
  });
  check(`${count("ALLOCATION_DISPATCHED")} dispatches after their allocation, before any cancel and the seed`, badDispatch.length === 0,
    badDispatch.map((e) => e.entity.id).join(", "));
  const badDeliver = entries.filter((e) => {
    if (e.action !== "ALLOCATION_DELIVERED") return false;
    const dispatched = at("ALLOCATION_DISPATCHED", e.entity.id);
    const to = cancelAt.get(e.entity.id) ?? seededAt;
    return !(e.payload?.derived === true && dispatched && e.ts > dispatched && e.ts < to);
  });
  check(`${count("ALLOCATION_DELIVERED")} deliveries after their dispatch, before the seed`, badDeliver.length === 0,
    badDeliver.map((e) => e.entity.id).join(", "));
  const badCancel = entries.filter((e) => {
    if (e.action !== "REQUEST_CANCELLED") return false;
    const own = allocations.filter((a) => a.request_id === e.entity.id).map((a) => a.allocation_id);
    const before = [requestAt.get(e.entity.id)!, ...own.map((id) => allocatedAt.get(id)!), ...own.flatMap((id) => cancelAt.get(id) ?? [])];
    const requester = requests.find((r) => r.request_id === e.entity.id)?.user_id;
    return !(
      e.payload?.derived === true &&
      before.every((d) => e.ts > d) &&
      e.ts <= seededAt &&
      e.actor.user_id === requester
    );
  });
  check(`${count("REQUEST_CANCELLED")} request cancels after the request's last event, by the requester`, badCancel.length === 0,
    badCancel.map((e) => e.entity.id).join(", "));
}

// ---------------------------------------------------------------------------
// 2–3. The validator: T12 and agreement with Zod
// ---------------------------------------------------------------------------

type Fixture = { name: string; valid: boolean; body: Record<string, unknown> };

const reportBase = { impact_id: 1, affected_percentage: 40, severity: "HIGH" };
const FIXTURES: Fixture[] = [
  { name: "FLOOD with level and roads", valid: true, body: { emergency_type: "FLOOD", details: { water_level_m: 1.4, roads_submerged: 6, trend: "RISING" } } },
  { name: "FLOOD without water_level_m", valid: false, body: { emergency_type: "FLOOD", details: { roads_submerged: 6 } } },
  { name: "FLOOD pretending to be other (free details)", valid: false, body: { emergency_type: "FLOOD", details: { note: "free" } } },
  { name: "EARTHQUAKE with magnitude and collapses", valid: true, body: { emergency_type: "EARTHQUAKE", details: { magnitude: 5.8, buildings_collapsed: 3 } } },
  { name: "EARTHQUAKE magnitude 11", valid: false, body: { emergency_type: "EARTHQUAKE", details: { magnitude: 11, buildings_collapsed: 3 } } },
  { name: "EPIDEMIC with cases and deaths", valid: true, body: { emergency_type: "EPIDEMIC", details: { new_cases: 40, deaths: 1 } } },
  { name: "EPIDEMIC with 1.5 deaths", valid: false, body: { emergency_type: "EPIDEMIC", details: { new_cases: 40, deaths: 1.5 } } },
  { name: "LANDSLIDE (other) with free details", valid: true, body: { emergency_type: "LANDSLIDE", details: { debris_m3: 120, road: "blocked" } } },
  { name: "CYCLONE (other) with a bad trend", valid: false, body: { emergency_type: "CYCLONE", details: { trend: "UP" } } },
  { name: "FLOOD with optional sections", valid: true, body: {
    emergency_type: "FLOOD", details: { water_level_m: 0.4, roads_submerged: 0 },
    casualties: { injured: 2 }, needs_observed: [{ item: "drinking water", est_qty: 2000, unit: "L" }],
    infrastructure: [{ kind: "underpass", status: "IMPASSABLE" }], notes: "ok", tags: ["water"], photos: ["p/1.jpg"] } },
  { name: "latitude 95", valid: false, body: { emergency_type: "LANDSLIDE", details: {}, location: { lat: 95, lng: 77 } } },
  { name: "needs item empty", valid: false, body: { emergency_type: "LANDSLIDE", details: {}, needs_observed: [{ item: "" }] } },
];

/** The fields that go to MySQL, not into the document. */
const MYSQL_FIELDS = ["impact_id", "affected_percentage", "severity", "location"];

/** The document the API would store for body, built without Zod for bodies Zod rejects. */
function docFor(body: Record<string, unknown>, observationId: number) {
  const { impact_id, location } = body;
  const report = Object.fromEntries(Object.entries(body).filter(([k]) => !MYSQL_FIELDS.includes(k)));
  return buildReportDoc({
    observation_id: observationId,
    emergency_id: 1,
    impact_id: impact_id as number,
    reported_by: { user_id: 1, name: "zz test", role: "FIELD_OFFICER" },
    reported_at: new Date(),
    location: (location as { lat: number; lng: number }) ?? { lat: 12.97, lng: 77.59 },
    report: report as ReportContent,
  });
}

async function checkValidator(db: Db): Promise<void> {
  console.log("\n2. T12: a FLOOD report without water_level_m, inserted directly");
  // Valid in every other way, so water_level_m is the only reason to refuse it.
  const t12Id = 2_000_000_012;
  const t12 = await outcome(
    db.collection(FIELD_REPORTS).insertOne(docFor({ ...reportBase, emergency_type: "FLOOD", details: { roads_submerged: 6 } }, t12Id)),
  );
  if (t12 === "ok") await db.collection(FIELD_REPORTS).deleteOne({ observation_id: t12Id });
  check(`rejected with code 121 (got ${t12})`, t12 === 121);

  console.log("\n3. Zod and the field_reports validator agree");
  await db.collection(SCRATCH).drop().catch(() => undefined);
  await createFieldReports(db, SCRATCH);
  try {
    let id = 0;
    for (const f of FIXTURES) {
      const body = { ...reportBase, ...f.body };
      const parsed = observationSchema.safeParse(body);
      const doc = docFor(parsed.success ? parsed.data : body, ++id);
      const mongo = await outcome(db.collection(SCRATCH).insertOne(doc));
      const zodOk = parsed.success;
      const mongoOk = mongo === "ok";
      check(
        `${f.name}: Zod ${zodOk ? "accepts" : "rejects"}, validator ${mongoOk ? "accepts" : `rejects (${mongo})`}`,
        zodOk === f.valid && mongoOk === f.valid,
        `expected both to ${f.valid ? "accept" : "reject"}`,
      );
    }

    // mongosh and Compass store 1 as a double: whole-number doubles must pass both validators.
    const asDoubles = {
      ...docFor({ ...reportBase, emergency_type: "FLOOD", details: { water_level_m: 1, roads_submerged: 2 } }, 0),
      emergency_id: new Double(1),
      impact_id: new Double(1),
      observation_id: new Double(++id),
      reported_by: { user_id: new Double(3), name: "zz test" },
      details: { water_level_m: new Double(1), roads_submerged: new Double(2) },
    };
    const report = await outcome(db.collection(SCRATCH).insertOne(asDoubles));
    check(`a FLOOD report with double ids and counts passes the field_reports validator (got ${report})`, report === "ok");
  } finally {
    await db.collection(SCRATCH).drop();
  }

  await db.collection(SCRATCH_LOG).drop().catch(() => undefined);
  await db.createCollection(SCRATCH_LOG, { validator: { $jsonSchema: activityLogSchema }, validationAction: "error" });
  try {
    const entry = await outcome(
      db.collection(SCRATCH_LOG).insertOne({
        ts: new Date(),
        actor: { user_id: new Double(3), name: "zz test", role: "FIELD_OFFICER" },
        action: "REQUEST_CREATED",
        entity: { type: "REQUEST", id: new Double(1) },
        refs: { request_id: new Double(1), emergency_id: new Double(1), center_id: new Double(1) },
      }),
    );
    check(`an activity entry with double ids passes the activity_log validator (got ${entry})`, entry === "ok");
  } finally {
    await db.collection(SCRATCH_LOG).drop();
  }
}

// ---------------------------------------------------------------------------
// 4. fileFieldReport and T13, on a zz_ emergency
// ---------------------------------------------------------------------------

async function checkFileFieldReport(db: Db, my: Connection): Promise<void> {
  console.log("\n4. fileFieldReport (cross-database write) and T13");
  const [reporter] = await selectRows<{ user_id: number; name: string }>(
    my,
    "SELECT user_id, name FROM `user` WHERE email = 'field1@eras.test'",
  );
  if (!reporter) throw new ScriptError("field1@eras.test is missing; run db:reset");

  await cleanupFixture(db, my);
  const [e] = await my.query(
    `INSERT INTO emergency (name, type, start_time, status) VALUES (?, 'FLOOD', NOW() - INTERVAL 1 DAY, 'ACTIVE')`,
    [ZZ],
  );
  const emergencyId = (e as { insertId: number }).insertId;
  const [l] = await my.query("INSERT INTO location (grid_id, latitude, longitude) VALUES (?, 12.9352, 77.6245)", [ZZ]);
  const [i] = await my.query("INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (?, ?, 'ACTIVE')", [
    emergencyId,
    (l as { insertId: number }).insertId,
  ]);
  const impactId = (i as { insertId: number }).insertId;

  try {
    const input = {
      emergency_id: emergencyId,
      impact_id: impactId,
      reported_by: { ...reporter, role: "FIELD_OFFICER" as const },
      location: { lat: 12.9352, lng: 77.6245 },
      affected_percentage: 30,
      severity: "HIGH" as const,
    };

    const filed = await fileFieldReport(db, my, {
      ...input,
      report: { emergency_type: "FLOOD", details: { water_level_m: 1.2, roads_submerged: 4 }, notes: "zz test" },
    });
    const [row] = await selectRows<{ observed_at: string; impact_id: number; user_id: number }>(
      my,
      "SELECT observed_at, impact_id, user_id FROM impact_observation WHERE observation_id = ?",
      [filed.observation_id],
    );
    const doc = await db.collection(FIELD_REPORTS).findOne({ observation_id: filed.observation_id });
    const entry = await db
      .collection<ActivityEntry>(ACTIVITY_LOG)
      .findOne({ action: "FIELD_REPORT_FILED", "entity.id": filed.observation_id });
    check("the observation row exists", !!row && row.impact_id === impactId && row.user_id === reporter.user_id);
    check(
      "the document has the same observation, impact and emergency",
      !!doc && doc.impact_id === impactId && doc.emergency_id === emergencyId && doc.reported_by.user_id === reporter.user_id,
    );
    check(
      "observed_at (IST) and reported_at are the same instant",
      !!row && !!doc && istToDate(row.observed_at).getTime() === (doc.reported_at as Date).getTime(),
      `${row?.observed_at} vs ${(doc?.reported_at as Date | undefined)?.toISOString()}`,
    );
    check(
      "a FIELD_REPORT_FILED entry with ts = reported_at and the emergency ref",
      !!entry && entry.ts.getTime() === filed.reported_at.getTime() && entry.refs?.emergency_id === emergencyId,
    );

    // A second report for the impact in the same second: MySQL's uq_impact_observation_time
    // refuses it (1062, the API's 409 DUPLICATE) before MongoDB is reached.
    const [{ observed_at: sameSecond }] = await selectRows<{ observed_at: string }>(
      my,
      "SELECT observed_at FROM impact_observation WHERE observation_id = ?",
      [filed.observation_id],
    );
    const duplicate = await outcome(
      fileFieldReport(db, my, {
        ...input,
        observed_at: sameSecond,
        report: { emergency_type: "FLOOD", details: { water_level_m: 1.3, roads_submerged: 4 } },
      }),
    );
    check(`the same impact and second is refused by MySQL (errno 1062; got ${duplicate})`, duplicate === "ER_DUP_ENTRY");

    // T13: passes nothing but fails the validator (Zod bypassed) -> compensated.
    // A minute earlier, so the row itself is fine and the MongoDB insert is what fails.
    const t13 = await outcome(
      fileFieldReport(db, my, {
        ...input,
        observed_at: dateToIst(new Date(filed.reported_at.getTime() - 60_000)),
        report: { emergency_type: "FLOOD", details: { roads_submerged: 4 } } as unknown as ReportContent,
      }),
    );
    const [{ n: rows }] = await selectRows<{ n: number }>(
      my,
      "SELECT COUNT(*) AS n FROM impact_observation WHERE impact_id = ?",
      [impactId],
    );
    const docs = await db.collection(FIELD_REPORTS).countDocuments({ impact_id: impactId });
    const filedEntries = await db.collection(ACTIVITY_LOG).countDocuments({ "refs.emergency_id": emergencyId });
    check(`T13: the Mongo insert fails with 121 (got ${t13})`, t13 === 121);
    check(`T13: its observation row is gone (rows for the impact: ${rows}, want 1)`, Number(rows) === 1);
    check(`T13: no document or activity entry for it (docs ${docs}, entries ${filedEntries}, want 1 each)`, docs === 1 && filedEntries === 1);
  } finally {
    await cleanupFixture(db, my);
  }
}

/** Removes the zz_ emergency, its impact, observations, reports and entries. */
async function cleanupFixture(db: Db, my: Connection): Promise<void> {
  const ids = await selectRows<{ emergency_id: number; impact_id: number | null; location_id: number | null }>(
    my,
    `SELECT e.emergency_id, ei.impact_id, ei.location_id
       FROM emergency e LEFT JOIN emergency_impact ei ON ei.emergency_id = e.emergency_id
      WHERE e.name = ?`,
    [ZZ],
  );
  for (const { emergency_id, impact_id } of ids) {
    // Test fixtures only: activity_log is otherwise never deleted from.
    await db.collection(ACTIVITY_LOG).deleteMany({ "refs.emergency_id": emergency_id });
    await db.collection(FIELD_REPORTS).deleteMany({ emergency_id });
    if (impact_id !== null) {
      await my.query("DELETE FROM impact_observation WHERE impact_id = ?", [impact_id]);
      await my.query("DELETE FROM emergency_impact WHERE impact_id = ?", [impact_id]);
    }
    await my.query("DELETE FROM emergency WHERE emergency_id = ?", [emergency_id]);
  }
  await my.query("DELETE FROM location WHERE grid_id = ?", [ZZ]);
}

async function main(): Promise<void> {
  const env = loadEnv([...MYSQL_APP_KEYS, ...MONGO_KEYS]);
  const my = await appConnection(env);
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect().catch(() => {
      throw new ScriptError("can't reach MongoDB. Is the MongoDB service running?");
    });
    const db = client.db(env.MONGODB_DB);
    console.log(`mongo:test as ${env.MYSQL_USER} on ${env.MYSQL_DATABASE} + ${env.MONGODB_DB}`);
    await checkBackfill(db, my);
    await checkValidator(db);
    await checkFileFieldReport(db, my);
  } finally {
    await client.close();
    await my.end();
  }
  if (fails > 0) throw new ScriptError(`${fails} check(s) failed`);
  console.log("\nmongo:test passed");
}

runScript("mongo:test", main);
