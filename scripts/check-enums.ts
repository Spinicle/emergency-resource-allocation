/**
 * npm run db:enums — checks that src/lib/enums.ts matches the CHECK
 * constraints in the database (db/mysql/02_alter.sql), as the app user.
 *
 * Prints PASS/FAIL per constraint; exits 1 if a constraint is missing or its
 * values differ from the list in enums.ts (order doesn't matter).
 */
import mysql, { type RowDataPacket } from "mysql2/promise";
import * as enums from "../src/lib/enums";
import { loadEnv, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

/** CHECK constraint -> the enums.ts list it must equal. */
const CONSTRAINTS: Record<string, readonly string[]> = {
  chk_role_role_name: enums.ROLES,
  chk_emergency_type: enums.EMERGENCY_TYPES,
  chk_emergency_status: enums.EMERGENCY_STATUSES,
  chk_emergency_impact_status: enums.IMPACT_STATUSES,
  chk_impact_observation_severity: enums.SEVERITIES,
  chk_resource_category: enums.RESOURCE_CATEGORIES,
  chk_resource_center_center_type: enums.CENTER_TYPES,
  chk_resource_center_status: enums.CENTER_STATUSES,
  chk_resource_request_status: enums.REQUEST_STATUSES,
  chk_request_item_urgency: enums.URGENCIES,
  chk_request_item_status: enums.ITEM_STATUSES,
  chk_allocation_status: enums.ALLOCATION_STATUSES,
  chk_stock_ledger_reason: enums.LEDGER_REASONS,
};

/** The string literals in a CHECK clause, e.g. (`x` in (_utf8mb4\'A\',_utf8mb4\'B\')) -> [A, B]. */
function literals(clause: string): string[] {
  return [...clause.matchAll(/\\?'([^'\\]*)\\?'/g)].map((m) => m[1]);
}

async function main(): Promise<void> {
  const env = loadEnv(MYSQL_APP_KEYS);
  const conn = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  });
  let rows: RowDataPacket[];
  try {
    [rows] = await conn.query<RowDataPacket[]>(
      `SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause
         FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME IN (?)`,
      [Object.keys(CONSTRAINTS)],
    );
  } finally {
    await conn.end();
  }
  const clauses = new Map(rows.map((r) => [r.name as string, r.clause as string]));

  const failed: string[] = [];
  for (const [name, expected] of Object.entries(CONSTRAINTS)) {
    const clause = clauses.get(name);
    const actual = clause === undefined ? null : literals(clause);
    const same =
      actual !== null &&
      actual.length === expected.length &&
      [...actual].sort().join() === [...expected].sort().join();
    console.log(`${same ? "PASS" : "FAIL"}  ${name}`);
    if (!same) {
      console.log(`      enums.ts: ${expected.join(", ")}`);
      console.log(`      database: ${actual === null ? "(constraint missing)" : actual.join(", ")}`);
      failed.push(name);
    }
  }
  if (failed.length > 0) throw new ScriptError(`${failed.length} constraint(s) differ from src/lib/enums.ts`);
  console.log(`\ndb:enums passed (${Object.keys(CONSTRAINTS).length} constraints)`);
}

runScript("db:enums", main);
