/**
 * npm run db:reset — rebuilds both local databases from scratch.
 *
 *  1. MySQL (as MYSQL_ADMIN_*): drop and recreate the database, then run every
 *     db/mysql/NN_*.sql in number order through the mysql CLI (routine files use
 *     DELIMITER, which only the CLI understands).
 *  2. Recreate the app user (MYSQL_USER) with SELECT/INSERT/UPDATE/DELETE/EXECUTE
 *     on that database only.
 *  3. MongoDB: drop the database and run db/mongo/setup.ts, which reads (and
 *     may write) MySQL as the app user.
 *  4. Print row counts.
 *
 * Needs .env.local (copy .env.example) and the mysql CLI on PATH.
 * Stops at the first error. Never prints passwords.
 */
import { readdirSync } from "node:fs";
import { MongoClient } from "mongodb";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { setupMongo } from "../db/mongo/setup";
import { appConnection } from "./lib/app-connection";
import { withMysqlCli } from "./lib/mysql-cli";
import {
  loadEnv,
  MONGO_KEYS,
  MYSQL_ADMIN_KEYS,
  MYSQL_APP_KEYS,
  runScript,
  ScriptError,
} from "./lib/script";

const SQL_DIR = "db/mysql";
const APP_USER_HOSTS = ["localhost", "127.0.0.1"];
const KEYS = [...MYSQL_APP_KEYS, ...MYSQL_ADMIN_KEYS, ...MONGO_KEYS];

type Env = Record<(typeof KEYS)[number], string>;

/** db/mysql/NN_*.sql, sorted by their number. */
function sqlFiles(): string[] {
  return readdirSync(SQL_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

async function resetMysql(admin: Connection, env: Env): Promise<void> {
  const db = env.MYSQL_DATABASE;
  console.log(`MySQL  ${env.MYSQL_HOST}:${env.MYSQL_PORT} as ${env.MYSQL_ADMIN_USER}`);
  await admin.query("DROP DATABASE IF EXISTS ??", [db]);
  await admin.query("CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci", [db]);
  console.log(`  recreated database ${db}`);

  const files = sqlFiles();
  if (files.length === 0) throw new ScriptError(`no NN_*.sql files in ${SQL_DIR}`);
  const target = {
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    user: env.MYSQL_ADMIN_USER,
    password: env.MYSQL_ADMIN_PASSWORD,
    database: db,
  };
  await withMysqlCli(target, async (runSqlFile) => {
    for (const f of files) {
      try {
        await runSqlFile(`${SQL_DIR}/${f}`);
      } catch (err) {
        throw new ScriptError(`${SQL_DIR}/${f} failed:\n${(err as Error).message}`);
      }
      console.log(`  ran ${f}`);
    }
  });
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
      throw new ScriptError(`can't reach MongoDB at ${shownUri}. Is the MongoDB service running?`);
    }
    const db = client.db(env.MONGODB_DB);
    await db.dropDatabase();
    console.log(`  dropped database ${env.MONGODB_DB}`);
    // The modules read (and Part 2's seed writes) MySQL as the app user, with the app pool's settings.
    const app = await appConnection(env);
    try {
      await setupMongo(db, app);
    } finally {
      await app.end();
    }
    console.log(`  ran db/mongo/setup.ts (MySQL as ${env.MYSQL_USER})`);

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
  const env = loadEnv(KEYS);
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

runScript("db:reset", main);
