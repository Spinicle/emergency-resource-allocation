/**
 * npm run db:queries
 *
 * Runs db/mysql/queries/important_queries.sql as the app user, on one connection
 * so its @variables persist, and prints each result under its Q tag so
 * screenshots are labelled.
 *
 * Exits 1 on an SQL error, an empty result set, a missing or unexpected tag,
 * a non-zero Q11b, or Q1 disagreeing with v_priority_queue. Exact row counts
 * aren't enforced: they change with app use and at midnight.
 */
import { readFileSync } from "node:fs";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { appConnection } from "./lib/app-connection";
import { loadEnv, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";
import { splitStatements, type TaggedLine } from "./lib/sql-split";

const FILE = "db/mysql/queries/important_queries.sql";
const EXPECTED_TAGS = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q8b", "Q9a", "Q9b", "Q10", "Q11a", "Q11b"];
const MAX_PRINTED_ROWS = 25;

/** fn_priority_score and the view read the clock separately, so W's rounding can move a score by 0.01 (HANDOFF 4.4). */
const SCORE_TOLERANCE = 0.011;
/** Within this many seconds of a 6 h / 24 h deadline they can differ by 2.0 (HANDOFF 4.4); t_seed leaves those rows out too. */
const DEADLINE_BOUNDARY_SECONDS = 10;

type Result = TaggedLine & { rows: RowDataPacket[] };

function printResult({ tag, label, rows }: Result): void {
  const shown = rows.length > MAX_PRINTED_ROWS ? `showing ${MAX_PRINTED_ROWS} of ${rows.length} rows` : `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  console.log(`\n${tag}: ${label}, ${shown}`);
  if (rows.length > 0) console.table(rows.slice(0, MAX_PRINTED_ROWS));
}

async function runFile(my: Connection): Promise<Result[]> {
  const results: Result[] = [];
  const pending: TaggedLine[] = [];
  for (const { sql, tags } of splitStatements(readFileSync(FILE, "utf8"))) {
    pending.push(...tags);
    const [outcome] = await my.query(sql);
    if (!Array.isArray(outcome)) continue; // a SET
    const tag = pending.shift();
    if (!tag) throw new ScriptError(`a query in ${FILE} has no Q tag:\n${sql.slice(0, 120)}`);
    const result = { ...tag, rows: outcome as RowDataPacket[] };
    results.push(result);
    printResult(result);
  }
  return results;
}

/** Q1 is written out by hand, so check it hasn't drifted from the view /allocate reads. */
async function compareQ1WithView(my: Connection, q1: Result): Promise<string[]> {
  const [view] = await my.query<RowDataPacket[]>(
    `SELECT request_item_id, priority_score,
            ABS(TIMESTAMPDIFF(SECOND, NOW(), required_by) - 21600) <= ?
              OR ABS(TIMESTAMPDIFF(SECOND, NOW(), required_by) - 86400) <= ? AS near_boundary
       FROM v_priority_queue`,
    [DEADLINE_BOUNDARY_SECONDS, DEADLINE_BOUNDARY_SECONDS],
  );
  const scores = new Map(q1.rows.map((r) => [r.request_item_id as number, r.priority_score as number]));
  const problems: string[] = [];
  if (q1.rows.length !== view.length) problems.push(`Q1 has ${q1.rows.length} rows, v_priority_queue has ${view.length}`);
  for (const row of view) {
    const score = scores.get(row.request_item_id);
    if (score === undefined) problems.push(`item ${row.request_item_id} is in v_priority_queue but not Q1`);
    else if (!row.near_boundary && Math.abs(score - row.priority_score) > SCORE_TOLERANCE) {
      problems.push(`item ${row.request_item_id}: Q1 score ${score}, view score ${row.priority_score}`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const env = loadEnv(MYSQL_APP_KEYS);
  const my = await appConnection(env);
  const problems: string[] = [];
  try {
    console.log(`Running ${FILE} as ${env.MYSQL_USER}`);
    const results = await runFile(my);
    const byTag = new Map(results.map((r) => [r.tag, r]));

    for (const tag of EXPECTED_TAGS) if (!byTag.has(tag)) problems.push(`${tag} is missing`);
    for (const { tag } of results) if (!EXPECTED_TAGS.includes(tag)) problems.push(`unexpected tag ${tag}`);
    if (results.length !== EXPECTED_TAGS.length) problems.push(`${results.length} result sets, expected ${EXPECTED_TAGS.length}`);
    for (const { tag, rows } of results) if (rows.length === 0) problems.push(`${tag} returned no rows`);

    const summary = byTag.get("Q11b")?.rows[0];
    if (summary && Number(summary.mismatched_batches) !== 0) problems.push(`Q11b: ${summary.mismatched_batches} batches don't reconcile`);

    const q1 = byTag.get("Q1");
    if (q1) problems.push(...(await compareQ1WithView(my, q1)));
  } finally {
    await my.end();
  }

  if (problems.length > 0) throw new ScriptError(`\n  ${problems.join("\n  ")}`);
  console.log(`\ndb:queries passed (${EXPECTED_TAGS.length} result sets, none empty, ledger reconciled, Q1 matches v_priority_queue)`);
}

runScript("db:queries", main);
