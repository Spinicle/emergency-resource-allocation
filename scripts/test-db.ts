/**
 * npm run db:test [-- <name filter> ...]
 *
 * Runs every db/mysql/tests/*.sql (or only those whose name contains a filter)
 * through the mysql CLI as the app user (MYSQL_USER), so tests also prove the
 * app's privileges. Prints each file's result rows.
 *
 * Test files report each check as a row whose result column is PASS or FAIL.
 * Exits 1 if any file errors, prints no rows, or has a FAIL cell.
 */
import { readdirSync } from "node:fs";
import { MysqlCliError, withMysqlCli } from "./lib/mysql-cli";
import { loadEnv, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

const TEST_DIR = "db/mysql/tests";

/** Cells that are exactly FAIL in mysql --table output. */
function countFails(output: string): number {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .flatMap((line) => line.split("|").slice(1, -1))
    .filter((cell) => cell.trim() === "FAIL").length;
}

async function main(): Promise<void> {
  const env = loadEnv(MYSQL_APP_KEYS);
  const filters = process.argv.slice(2);
  const files = readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
    .sort();
  if (files.length === 0) {
    throw new ScriptError(
      filters.length > 0
        ? `no file in ${TEST_DIR} matches: ${filters.join(", ")}`
        : `no .sql files in ${TEST_DIR}`,
    );
  }

  const problems: string[] = [];
  const target = {
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  };
  await withMysqlCli(target, async (runSqlFile) => {
    for (const f of files) {
      console.log(`\n=== ${TEST_DIR}/${f} (as ${env.MYSQL_USER})`);
      let output: string;
      try {
        output = await runSqlFile(`${TEST_DIR}/${f}`, { table: true });
      } catch (err) {
        // An error reported by the CLI fails this file; anything else (e.g. no CLI) stops the run.
        if (!(err instanceof MysqlCliError)) throw err;
        process.stdout.write(err.stdout);
        console.log(err.message);
        problems.push(`${f}: stopped on an error`);
        continue;
      }
      process.stdout.write(output);
      const fails = countFails(output);
      if (!output.trim()) problems.push(`${f}: printed no results`);
      else if (fails > 0) problems.push(`${f}: ${fails} FAIL`);
    }
  });

  if (problems.length > 0) {
    throw new ScriptError(`\n  ${problems.join("\n  ")}`);
  }
  console.log(`\ndb:test passed (${files.length} file${files.length === 1 ? "" : "s"})`);
}

runScript("db:test", main);
