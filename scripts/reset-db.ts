/**
 * npm run db:reset — rebuilds both local databases from scratch.
 *
 *  1. MySQL (as MYSQL_ADMIN_*): drop and recreate the database, then run every
 *     db/mysql/NN_*.sql in number order through the mysql CLI (routine files use
 *     DELIMITER, which only the CLI understands).
 *  2. Recreate the app user (MYSQL_USER) with SELECT/INSERT/UPDATE/DELETE/EXECUTE
 *     on that database only.
 *  3. MongoDB: drop the database and run db/mongo/setup.ts.
 *  4. Print row counts.
 *
 * Needs .env.local (copy .env.example) and the mysql CLI on PATH.
 * Stops at the first error. Never prints passwords.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { setupMongo } from "../db/mongo/setup";

const SQL_DIR = "db/mysql";
const APP_USER_HOSTS = ["localhost", "127.0.0.1"];
const REQUIRED_ENV = [
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_DATABASE",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_ADMIN_USER",
  "MYSQL_ADMIN_PASSWORD",
  "MONGODB_URI",
  "MONGODB_DB",
] as const;

// db:reset runs DROP DATABASE / DROP USER as admin, so it refuses these names.
const SYSTEM_MYSQL_SCHEMAS = ["mysql", "sys", "information_schema", "performance_schema"];
const SYSTEM_MONGO_DBS = ["admin", "local", "config"];

type Env = Record<(typeof REQUIRED_ENV)[number], string>;

class ResetError extends Error {}

function loadEnv(): Env {
  // process.loadEnvFile keeps values already set in the shell, so a stale export
  // would silently win over .env.local. Stop and name it instead.
  const fromShell = REQUIRED_ENV.filter((k) => process.env[k] !== undefined);
  if (fromShell.length > 0) {
    throw new ResetError(
      `set in your shell, so they would override .env.local: ${fromShell.join(", ")}. Unset them and rerun.`,
    );
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    throw new ResetError(".env.local not found. Copy .env.example to .env.local and fill it in.");
  }
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    throw new ResetError(`.env.local has no value for: ${missing.join(", ")}`);
  }
  const env = Object.fromEntries(REQUIRED_ENV.map((k) => [k, process.env[k]!.trim()])) as Env;
  // These end up in identifiers and CLI arguments, so keep them plain.
  for (const k of ["MYSQL_DATABASE", "MYSQL_USER", "MONGODB_DB"] as const) {
    if (!/^[A-Za-z0-9_]+$/.test(env[k])) {
      throw new ResetError(`${k} may only contain letters, digits and underscores.`);
    }
  }
  if (SYSTEM_MYSQL_SCHEMAS.includes(env.MYSQL_DATABASE.toLowerCase())) {
    throw new ResetError(`MYSQL_DATABASE=${env.MYSQL_DATABASE} is a MySQL system schema; refusing to drop it.`);
  }
  if (SYSTEM_MONGO_DBS.includes(env.MONGODB_DB.toLowerCase())) {
    throw new ResetError(`MONGODB_DB=${env.MONGODB_DB} is a MongoDB system database; refusing to drop it.`);
  }
  // The app user is dropped and recreated with database-level grants only.
  const appUser = env.MYSQL_USER.toLowerCase();
  if (appUser === "root" || appUser === env.MYSQL_ADMIN_USER.toLowerCase()) {
    throw new ResetError(
      "MYSQL_USER must be its own least-privilege account, not root or MYSQL_ADMIN_USER " +
        "(db:reset drops and recreates it).",
    );
  }
  return env;
}

/** db/mysql/NN_*.sql, sorted by their number. */
function sqlFiles(): string[] {
  return readdirSync(SQL_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

/**
 * Writes a temporary MySQL option file holding the admin credentials, so the
 * password never appears on a command line. Returns its path and a cleanup.
 */
function writeClientOptionFile(env: Env): { file: string; cleanup: () => void } {
  const pw = env.MYSQL_ADMIN_PASSWORD;
  const quote = pw.includes('"') ? "'" : '"';
  if (pw.includes(quote)) {
    throw new ResetError("MYSQL_ADMIN_PASSWORD can't contain both ' and \" (MySQL option-file limit).");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "eras-reset-"));
  const file = path.join(dir, "client.cnf");
  const lines = [
    "[client]",
    `host=${env.MYSQL_HOST}`,
    `port=${env.MYSQL_PORT}`,
    `user=${env.MYSQL_ADMIN_USER}`,
    `password=${quote}${pw.replaceAll("\\", "\\\\")}${quote}`,
    "",
  ];
  writeFileSync(file, lines.join("\n"), { mode: 0o600 });

  // Remove it on normal return, on any process exit, and on Ctrl+C.
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const onSigint = () => {
    remove();
    process.exit(130);
  };
  process.on("exit", remove);
  process.once("SIGINT", onSigint);
  const cleanup = () => {
    remove();
    process.off("exit", remove);
    process.off("SIGINT", onSigint);
  };
  return { file, cleanup };
}

/** Feeds one SQL file to the mysql CLI. Rejects with the CLI's error text. */
function runSqlFile(file: string, optionFile: string, database: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "mysql",
      [`--defaults-extra-file=${optionFile}`, "--batch", "--default-character-set=utf8mb4", database],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "ENOENT"
          ? new ResetError("mysql CLI not found. Add MySQL Server's bin folder to PATH.")
          : err,
      ),
    );
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const msg = stderr
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .join("\n");
      reject(new ResetError(msg || `mysql exited with code ${code}`));
    });
    child.stdin.end(readFileSync(file));
  });
}

async function resetMysql(admin: Connection, env: Env): Promise<void> {
  const db = env.MYSQL_DATABASE;
  console.log(`MySQL  ${env.MYSQL_HOST}:${env.MYSQL_PORT} as ${env.MYSQL_ADMIN_USER}`);
  await admin.query("DROP DATABASE IF EXISTS ??", [db]);
  await admin.query("CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci", [db]);
  console.log(`  recreated database ${db}`);

  const files = sqlFiles();
  if (files.length === 0) throw new ResetError(`no NN_*.sql files in ${SQL_DIR}`);
  const { file: optionFile, cleanup } = writeClientOptionFile(env);
  try {
    for (const f of files) {
      try {
        await runSqlFile(`${SQL_DIR}/${f}`, optionFile, db);
      } catch (err) {
        throw new ResetError(`${SQL_DIR}/${f} failed:\n${(err as Error).message}`);
      }
      console.log(`  ran ${f}`);
    }
  } finally {
    cleanup();
  }
}

async function resetAppUser(admin: Connection, env: Env): Promise<void> {
  for (const host of APP_USER_HOSTS) {
    await admin.query("DROP USER IF EXISTS ?@?", [env.MYSQL_USER, host]);
    await admin.query("CREATE USER ?@? IDENTIFIED BY ?", [env.MYSQL_USER, host, env.MYSQL_PASSWORD]);
    await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON ??.* TO ?@?", [
      env.MYSQL_DATABASE,
      env.MYSQL_USER,
      host,
    ]);
  }
  console.log(
    `  recreated ${APP_USER_HOSTS.map((h) => `${env.MYSQL_USER}@${h}`).join(", ")}` +
      ` (SELECT, INSERT, UPDATE, DELETE, EXECUTE on ${env.MYSQL_DATABASE}.*)`,
  );
}

async function resetMongo(env: Env): Promise<Record<string, number>> {
  const shownUri = env.MONGODB_URI.replace(/\/\/[^@/]*@/, "//***@");
  console.log(`MongoDB  ${shownUri}`);
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    try {
      await client.connect();
    } catch {
      throw new ResetError(`can't reach MongoDB at ${shownUri}. Is the MongoDB service running?`);
    }
    const db = client.db(env.MONGODB_DB);
    await db.dropDatabase();
    console.log(`  dropped database ${env.MONGODB_DB}`);
    await setupMongo(db);
    console.log("  ran db/mongo/setup.ts");

    const counts: Record<string, number> = {};
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
      counts[name] = await db.collection(name).countDocuments();
    }
    return counts;
  } finally {
    await client.close();
  }
}

async function mysqlCounts(admin: Connection, db: string): Promise<Record<string, number>> {
  const [tables] = await admin.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [db],
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [[row]] = await admin.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM ??.??", [db, name]);
    counts[name] = Number(row.n);
  }
  return counts;
}

function printCounts(title: string, counts: Record<string, number>): void {
  const names = Object.keys(counts);
  console.log(`\n${title}`);
  if (names.length === 0) {
    console.log("  (none)");
    return;
  }
  const width = Math.max(...names.map((n) => n.length));
  for (const n of names) console.log(`  ${n.padEnd(width)}  ${String(counts[n]).padStart(6)}`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const admin = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_ADMIN_USER,
    password: env.MYSQL_ADMIN_PASSWORD,
  });
  try {
    await resetMysql(admin, env);
    await resetAppUser(admin, env);
    const mongoCounts = await resetMongo(env);
    printCounts(`MySQL rows (${env.MYSQL_DATABASE})`, await mysqlCounts(admin, env.MYSQL_DATABASE));
    printCounts(`MongoDB documents (${env.MONGODB_DB})`, mongoCounts);
  } finally {
    await admin.end();
  }
  console.log("\ndb:reset done");
}

main().catch((err: unknown) => {
  // Only the message: mysql2 errors also carry the SQL text, which can include a password.
  const e = err as { message?: string; code?: string };
  const detail = err instanceof ResetError ? e.message : `${e.code ? `${e.code}: ` : ""}${e.message}`;
  console.error(`\ndb:reset failed: ${detail}`);
  process.exitCode = 1;
});
