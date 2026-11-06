/**
 * npm run api:test -- --base <url> --writes
 *
 * Checks the Part 1 API (docs/HANDOFF.md 4.5-4.10, Appendix A T14-T16) against
 * a running server: npm run dev, or npm run build + npm start. Both flags are
 * optional; --base defaults to http://localhost:3000. Pass them after a single
 * "--" (a second "--" would end the options).
 *
 * The default run writes nothing, so it's safe at any time:
 *   1. logins (every seeded user, the inactive one, a wrong password)
 *   2. T15 tokens: tampered, expired, alg none, HS512 and bad-role tokens
 *   3. the role matrix: every Part 1 route signed out and as each role. An
 *      allowed role proves it got past the role check without writing (a bad
 *      body -> 400, an unknown id -> 404); a refused role sends a valid request
 *      and gets 403 (T14 is field1's POST /api/allocations)
 *   4. T15 signed out, 5. T16 center scope, 6. page redirects by role
 *   7. validation, 8. reads (scope, order, shapes, ledger reconciliation)
 *   9. the seed scenario (SKIP unless the database is freshly seeded)
 *  10. nothing was written: MySQL row counts and activity_log unchanged
 *
 * --writes adds the P1.8/P1.9 behaviour checks (allocate, split, cancel,
 * receive, adjust, write-off refusals, dispatch/deliver, the ledger, the
 * activity_log entries) and T15's live sessions. It refuses to start unless
 * the database is freshly seeded, and changes it: run npm run db:reset after.
 *
 * It talks to the app over HTTP only: plain fetch with an explicit Cookie
 * header (so next start's Secure cookie works too), after one warm-up request
 * per route (next dev's first request to an uncompiled route can answer before
 * the route runs). It reads MySQL (as MYSQL_USER) and MongoDB directly, to find
 * rows by email, grid_id, batch_code or name (never by id) and to check what a
 * call wrote. Prints PASS / FAIL / SKIP per check; exits 1 on any FAIL.
 *
 * The checks live in scripts/api-test/: harness (output, HTTP, SQL), context
 * (accounts, seeded ids, database state), reads (1-2, 4-10), matrix (3) and
 * writes (W1-W5).
 */
import { parseArgs } from "node:util";
import { MongoClient } from "mongodb";
import { type Ctx, lookups, snapshot, staleness } from "./api-test/context";
import { type Body, fetchApp, get, MAX_ID, results, setBase } from "./api-test/harness";
import { checkMatrix } from "./api-test/matrix";
import {
  checkCenterScope,
  checkLogins,
  checkNothingWritten,
  checkPages,
  checkReads,
  checkSeed,
  checkSignedOut,
  checkTokens,
  checkValidation,
} from "./api-test/reads";
import { checkWrites } from "./api-test/writes";
import { appConnection } from "./lib/app-connection";
import { AUTH_KEYS, loadEnv, MONGO_KEYS, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

const USAGE = "Usage: npm run api:test -- [--base <url>] [--writes]";
const RESET_NOW = "\n--writes changed the database. Run npm run db:reset now.";

function options(): { base: string; writes: boolean } {
  let values: { base?: string; writes?: boolean };
  try {
    ({ values } = parseArgs({
      options: { base: { type: "string" }, writes: { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new ScriptError(`${(err as Error).message}\n${USAGE}`);
  }
  const raw = values.base ?? "http://localhost:3000";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ScriptError(`--base ${raw} isn't a URL.\n${USAGE}`);
  }
  return { base: url.origin, writes: values.writes ?? false };
}

/** Fails fast with a clear message when nothing (or not ERAS) answers. */
async function reachable(base: string): Promise<void> {
  let res: Response;
  try {
    res = await fetchApp("/api/auth/me", {}, 5_000);
  } catch {
    throw new ScriptError(`Nothing answered at ${base}. Start the app (npm run dev) or pass --base <url>.`);
  }
  const body = (await res.json().catch(() => null)) as Body;
  if (res.status !== 401 || body?.error?.code !== "UNAUTHENTICATED") {
    throw new ScriptError(`${base} answered, but it doesn't look like ERAS (GET /api/auth/me -> ${res.status}).`);
  }
}

/** One request per route and page, results ignored: next dev compiles a route on its first request. */
async function warmUp(admin: string): Promise<void> {
  const paths = [
    "/api/auth/me", "/api/auth/login", "/api/auth/logout", "/api/observations",
    "/api/allocations/queue", "/api/allocations/suggestions", "/api/allocations", `/api/allocations/${MAX_ID}/cancel`,
    "/api/resources", "/api/stock", `/api/stock/${MAX_ID}/adjust`, `/api/stock/${MAX_ID}/ledger`,
    "/api/stock/allocations", `/api/stock/allocations/${MAX_ID}/dispatch`, `/api/stock/allocations/${MAX_ID}/deliver`,
    "/api", "/api/zz-no-such-route", "/login", "/dashboard", "/allocate", "/inventory",
  ];
  // GET only: a POST-only route answers 405 and runs nothing.
  for (const p of paths) await get(p, admin).catch(() => null);
}

async function main(): Promise<void> {
  const { base, writes } = options();
  setBase(base);
  const env = loadEnv([...MYSQL_APP_KEYS, ...MONGO_KEYS, ...AUTH_KEYS]);
  if (!/^[0-9a-fA-F]{64}$/.test(env.JWT_SECRET)) throw new ScriptError("JWT_SECRET in .env.local must be 64 hex characters");
  console.log(`api:test against ${base}${writes ? " (--writes)" : ""}`);
  await reachable(base);

  const my = await appConnection(env);
  const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
  let wrote = false;
  try {
    try {
      await mongo.connect();
      const db = mongo.db(env.MONGODB_DB);
      const stale = await staleness(my, db);
      if (writes && stale) {
        throw new ScriptError(`--writes needs a freshly seeded database (${stale}). Run npm run db:reset first.`);
      }
      const before = await snapshot(my, db);
      const ids = await lookups(my);

      const { as, sessions } = await checkLogins();
      console.log("\n(warming up every route and page)");
      await warmUp(as.ADMIN);
      const c: Ctx = { my, db, ids, as, sessions, jwtKey: Buffer.from(env.JWT_SECRET, "hex"), stale };

      await checkTokens(c);
      await checkMatrix(c);
      await checkSignedOut();
      await checkCenterScope(c);
      await checkPages(c);
      await checkValidation(c);
      await checkReads(c);
      await checkSeed(c);
      await checkNothingWritten(c, before);

      if (writes) {
        wrote = true;
        await checkWrites(c);
      }
    } finally {
      await my.end();
      await mongo.close();
    }

    const { passed, failed, skipped } = results();
    console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
    if (failed > 0) throw new ScriptError(`${failed} check${failed === 1 ? "" : "s"} failed`);
    console.log("api:test passed");
  } finally {
    // Also when --writes stopped part-way or a check failed.
    if (wrote) console.log(RESET_NOW);
  }
}

runScript("api:test", main);
