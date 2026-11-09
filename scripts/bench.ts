/**
 * npm run db:bench [-- --drop]
 *
 * T19: what idx_item_queue buys on a large request_item table. Builds a separate
 * eras_bench database from 01_schema.sql and 02_alter.sql, loads 200,000 items,
 * runs EXPLAIN ANALYZE with the index, drops it, runs it again and recreates it.
 *
 * Only eras_bench is ever touched, as MYSQL_ADMIN_*. The triggers stay out: they
 * refuse any new item that isn't PENDING and lock per row, and nothing here needs
 * the functions, views or seed. CHECKs and idx_item_queue come with 02_alter.
 *
 * eras_bench is kept afterwards so the recreated index can be inspected; the next
 * run drops it first, and --drop removes it at the end. Exits 1 unless the plans
 * change as expected. The verdict reads the access path only, never the timings,
 * which vary between runs.
 */
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { withMysqlCli } from "./lib/mysql-cli";
import { loadEnv, MYSQL_ADMIN_KEYS, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

const BENCH_DB = "eras_bench";
const SCHEMA_FILES = ["db/mysql/01_schema.sql", "db/mysql/02_alter.sql"];
const INDEX = "idx_item_queue";

const REQUESTS = 8_000;
const RESOURCES = 25; // 8,000 x 25 = 200,000 items, each pair once for uq_request_resource
const ITEMS = REQUESTS * RESOURCES;

const COLUMNS = "request_item_id, request_id, resource_id, quantity_requested";
/** The query the task names: equality on both index columns, so an Index lookup. */
const LOOKUP_SQL = `SELECT ${COLUMNS} FROM request_item WHERE status = 'PENDING' AND urgency = 'CRITICAL'`;
/** Two urgencies: the same index read as an Index range scan. */
const RANGE_SQL = `SELECT ${COLUMNS} FROM request_item WHERE status = 'PENDING' AND urgency IN ('HIGH', 'CRITICAL')`;

const TABLE_SCAN = /Table scan on request_item/;
const INDEX_LOOKUP = new RegExp(`Index lookup on request_item using ${INDEX}`);
const INDEX_RANGE = new RegExp(`Index range scan on request_item using ${INDEX}`);

/** Every statement that creates, fills or drops goes through this name. */
function assertBenchDb(name: string): void {
  if (name !== BENCH_DB) throw new ScriptError(`refusing to touch ${name}: db:bench only ever works on ${BENCH_DB}.`);
}

async function assertConnectedToBench(admin: Connection): Promise<void> {
  const [[row]] = await admin.query<RowDataPacket[]>("SELECT DATABASE() AS db");
  assertBenchDb(String(row.db));
}

async function createSchema(admin: Connection, env: Record<(typeof KEYS)[number], string>): Promise<void> {
  assertBenchDb(BENCH_DB);
  await admin.query("DROP DATABASE IF EXISTS ??", [BENCH_DB]);
  await admin.query("CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci", [BENCH_DB]);
  await withMysqlCli(
    { host: env.MYSQL_HOST, port: env.MYSQL_PORT, user: env.MYSQL_ADMIN_USER, password: env.MYSQL_ADMIN_PASSWORD, database: BENCH_DB },
    async (runSqlFile) => {
      for (const file of SCHEMA_FILES) await runSqlFile(file);
    },
  );
  await admin.query("USE ??", [BENCH_DB]);
  await assertConnectedToBench(admin);
  console.log(`Built ${BENCH_DB} from ${SCHEMA_FILES.join(", ")}`);
}

/**
 * Parents first, then the items. Of every 100 items: 1 PENDING + CRITICAL,
 * 3 PENDING + HIGH, 16 other PENDING, 80 not PENDING. Without a selective
 * predicate the optimizer would rightly scan the table even with the index.
 */
async function loadData(admin: Connection): Promise<void> {
  await admin.query("SET SESSION cte_max_recursion_depth = 300000");
  await admin.query("INSERT INTO role (role_id, role_name) VALUES (1, 'ADMIN')");
  await admin.query(
    "INSERT INTO `user` (user_id, role_id, name, email, password_hash) VALUES (1, 1, 'Bench user', 'bench@eras.test', 'not-a-hash')",
  );
  await admin.query("INSERT INTO location (location_id, grid_id, latitude, longitude) VALUES (1, 'BENCH-1', 12.9, 77.6)");
  await admin.query("INSERT INTO emergency (emergency_id, name, type, start_time, status) VALUES (1, 'Bench', 'FLOOD', NOW(), 'ACTIVE')");
  await admin.query("INSERT INTO emergency_impact (impact_id, emergency_id, location_id, status) VALUES (1, 1, 1, 'ACTIVE')");
  await admin.query(
    `INSERT INTO resource (resource_id, name, category, unit)
     WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
     SELECT n, CONCAT('Bench resource ', n), 'OTHER', 'unit' FROM seq`,
    [RESOURCES],
  );
  await admin.query(
    `INSERT INTO resource_request (request_id, impact_id, user_id, status)
     WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
     SELECT n, 1, 1, 'OPEN' FROM seq`,
    [REQUESTS],
  );
  await admin.query(
    `INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency, status)
     WITH RECURSIVE seq (n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < ?)
     SELECT FLOOR(n / ?) + 1,
            MOD(n, ?) + 1,
            10,
            CASE WHEN MOD(n, 100) = 0 THEN 'CRITICAL'
                 WHEN MOD(n, 100) BETWEEN 1 AND 3 THEN 'HIGH'
                 WHEN MOD(n, 100) BETWEEN 4 AND 11 THEN 'MEDIUM'
                 WHEN MOD(n, 100) BETWEEN 12 AND 19 THEN 'LOW'
                 ELSE ELT(1 + MOD(FLOOR(n / 100), 4), 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
            END,
            CASE WHEN MOD(n, 100) < 20 THEN 'PENDING'
                 WHEN MOD(n, 100) < 70 THEN 'FULFILLED'
                 WHEN MOD(n, 100) < 90 THEN 'PARTIAL'
                 ELSE 'CANCELLED'
            END
       FROM seq`,
    [ITEMS, RESOURCES, RESOURCES],
  );
  await admin.query("ANALYZE TABLE request_item");
}

async function printDistribution(admin: Connection, loadMs: number): Promise<void> {
  const [rows] = await admin.query<RowDataPacket[]>(
    `SELECT status, urgency, COUNT(*) AS items,
            CONCAT(ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 2), ' %') AS share
       FROM request_item
      GROUP BY status, urgency
      ORDER BY status = 'PENDING' DESC, status, FIELD(urgency, 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW')`,
  );
  console.log(`\nLoaded ${ITEMS.toLocaleString("en-IN")} items in ${(loadMs / 1000).toFixed(1)} s. Status x urgency:`);
  console.table(rows.map((r) => ({ status: r.status, urgency: r.urgency, items: Number(r.items), share: r.share })));
}

async function explainAnalyze(admin: Connection, sql: string): Promise<string> {
  const [rows] = await admin.query<RowDataPacket[]>(`EXPLAIN ANALYZE ${sql}`);
  return String(Object.values(rows[0])[0]);
}

function printPlan(title: string, sql: string, plan: string): void {
  console.log(`\n--- ${title}\n${sql}\n${plan}`);
}

type Plans = { lookup: string; range: string };

async function runPlans(admin: Connection, when: string): Promise<Plans> {
  await assertConnectedToBench(admin);
  const lookup = await explainAnalyze(admin, LOOKUP_SQL);
  printPlan(`${when}: PENDING + CRITICAL`, LOOKUP_SQL, lookup);
  const range = await explainAnalyze(admin, RANGE_SQL);
  printPlan(`${when}: PENDING + HIGH or CRITICAL`, RANGE_SQL, range);
  return { lookup, range };
}

/** Without the index, then the recreate: in a finally, so a failed run can't leave it dropped. */
async function runWithoutIndex(admin: Connection): Promise<Plans> {
  await assertConnectedToBench(admin);
  await admin.query(`DROP INDEX ${INDEX} ON request_item`);
  console.log(`\nDropped ${INDEX}`);
  try {
    return await runPlans(admin, "Without the index");
  } finally {
    await admin.query(`CREATE INDEX ${INDEX} ON request_item (status, urgency)`);
    console.log(`\nRecreated ${INDEX}`);
  }
}

async function indexExists(admin: Connection): Promise<boolean> {
  const [rows] = await admin.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'request_item' AND INDEX_NAME = ?",
    [BENCH_DB, INDEX],
  );
  return Number(rows[0].n) > 0;
}

function verdict(withIndex: Plans, withoutIndex: Plans): string[] {
  const problems: string[] = [];
  if (!TABLE_SCAN.test(withoutIndex.lookup)) problems.push("the equality query didn't table-scan without the index");
  if (!TABLE_SCAN.test(withoutIndex.range)) problems.push("the IN query didn't table-scan without the index");
  if (!INDEX_LOOKUP.test(withIndex.lookup)) problems.push(`the equality query didn't use an Index lookup on ${INDEX}`);
  if (!INDEX_RANGE.test(withIndex.range)) problems.push(`the IN query didn't use an Index range scan on ${INDEX}`);
  return problems;
}

const KEYS = [...MYSQL_APP_KEYS, ...MYSQL_ADMIN_KEYS];

async function main(): Promise<void> {
  const env = loadEnv(KEYS);
  if (env.MYSQL_DATABASE === BENCH_DB) {
    throw new ScriptError(`MYSQL_DATABASE is ${BENCH_DB}, the database db:bench rebuilds. Point it at the app's database.`);
  }

  // No default database: nothing can land anywhere until USE eras_bench has been confirmed.
  const admin = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_ADMIN_USER,
    password: env.MYSQL_ADMIN_PASSWORD,
  });
  try {
    await createSchema(admin, env);

    const started = performance.now();
    await loadData(admin);
    await printDistribution(admin, performance.now() - started);

    const withIndex = await runPlans(admin, "With the index");
    const withoutIndex = await runWithoutIndex(admin);

    const problems = verdict(withIndex, withoutIndex);
    if (!(await indexExists(admin))) problems.push(`${INDEX} wasn't recreated`);

    if (process.argv.includes("--drop")) {
      assertBenchDb(BENCH_DB);
      await admin.query("DROP DATABASE ??", [BENCH_DB]);
      console.log(`Dropped ${BENCH_DB}`);
    }

    if (problems.length > 0) throw new ScriptError(`T19 FAIL:\n  ${problems.join("\n  ")}`);
    console.log(
      `\nT19 PASS: without ${INDEX} both queries use a Table scan; with it, equality uses an Index lookup and the IN list an Index range scan.`,
    );
  } finally {
    await admin.end();
  }
}

runScript("db:bench", main);
