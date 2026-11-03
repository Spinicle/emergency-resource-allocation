/**
 * npm run db:race — allocation under concurrency (T08, docs/HANDOFF.md Appendix A).
 *
 * Runs as the app user (MYSQL_USER) over three connections. A "blocker"
 * connection holds a row lock so that two calls queue up behind it, then lets
 * go, and the two race for the same rows:
 *   1. two allocations race for a batch's last 50 units
 *   2. two allocations to one item, from two batches that together exceed it
 *   3. an allocation races a cancel on the same item
 *   4. a request cancel (the P2.2 pattern) races an allocation to one of its items
 *   5. allocations to two different items of one request at once
 *   6. 20 repeats of 1 with no blocker
 * Nothing may deadlock (error 1213), and stock and ledger must agree afterwards.
 *
 * It creates zz_race rows and removes them afterwards, and first removes any
 * left by an interrupted run. Prints PASS/FAIL per check; exits 1 on a FAIL.
 */
import mysql, { type Connection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { loadEnv, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

type Outcome = { ok: true } | { ok: false; errno: number; message: string };
type Fixture = { userId: number; impactId: number; centerId: number; resourceId: number; otherResourceId: number };

const DEADLOCK = 1213;
const failures: string[] = [];
let batchNo = 0;

function check(name: string, pass: boolean, detail = ""): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures.push(name);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rows(conn: Connection, sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await conn.query<RowDataPacket[]>(sql, params);
  return result;
}

async function value<T>(conn: Connection, sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await rows(conn, sql, params);
  return Object.values(row ?? {})[0] as T;
}

async function insert(conn: Connection, sql: string, params: unknown[]): Promise<number> {
  const [result] = await conn.query<ResultSetHeader>(sql, params);
  return result.insertId;
}

/** Runs work and reports how it ended; only MySQL errors are caught. */
async function attempt(work: () => Promise<unknown>): Promise<Outcome> {
  try {
    await work();
    return { ok: true };
  } catch (err) {
    const e = err as { errno?: unknown; sqlMessage?: string };
    if (typeof e.errno !== "number") throw err;
    return { ok: false, errno: e.errno, message: e.sqlMessage ?? "" };
  }
}

const describeOutcome = (o: Outcome) => (o.ok ? "ok" : `${o.errno}: ${o.message}`);
const refusedWith = (o: Outcome, message: string) => !o.ok && o.errno === 1644 && o.message === message;

function allocate(conn: Connection, item: number, stock: number, qty: number, user: number) {
  return attempt(() => conn.query("CALL sp_allocate(?, ?, ?, ?, @aid)", [item, stock, qty, user]));
}

/** P2.2's request cancel: lock every item in id order, then cancel them all. */
function cancelRequest(conn: Connection, requestId: number) {
  return attempt(async () => {
    await conn.beginTransaction();
    try {
      await conn.query(
        "SELECT request_item_id FROM request_item WHERE request_id = ? ORDER BY request_item_id FOR UPDATE",
        [requestId],
      );
      await conn.query("UPDATE request_item SET status = 'CANCELLED' WHERE request_id = ?", [requestId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  });
}

/**
 * Holds lockSql's row lock on the blocker, starts first then second (so both
 * queue behind it), releases the lock, and returns both outcomes.
 */
async function race(
  blocker: Connection,
  lockSql: string,
  lockParams: unknown[],
  first: () => Promise<Outcome>,
  second: () => Promise<Outcome>,
): Promise<[Outcome, Outcome]> {
  await blocker.beginTransaction();
  await blocker.query(lockSql, lockParams);
  const a = first();
  await sleep(50);
  const b = second();
  await sleep(300);
  await blocker.commit();
  return Promise.all([a, b]);
}

async function newBatch(conn: Connection, f: Fixture, qty: number, resourceId = f.resourceId): Promise<number> {
  batchNo += 1;
  return insert(
    conn,
    "INSERT INTO stock (resource_id, center_id, batch_code, quantity_available) VALUES (?, ?, ?, ?)",
    [resourceId, f.centerId, `zz_race_B${batchNo}`, qty],
  );
}

async function newRequest(conn: Connection, f: Fixture): Promise<number> {
  return insert(conn, "INSERT INTO resource_request (impact_id, user_id) VALUES (?, ?)", [f.impactId, f.userId]);
}

async function newItem(conn: Connection, requestId: number, resourceId: number, qty: number): Promise<number> {
  return insert(
    conn,
    "INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (?, ?, ?, 'HIGH')",
    [requestId, resourceId, qty],
  );
}

/** Ledger rows whose running total disagrees with balance_after, plus batches whose last balance isn't their stock. */
async function ledgerMismatches(conn: Connection, stockIds: number[]): Promise<number> {
  const running = await value<number>(
    conn,
    `SELECT COUNT(*) FROM (
       SELECT balance_after,
              SUM(change_qty) OVER (PARTITION BY stock_id ORDER BY changed_at, ledger_id) AS total
         FROM stock_ledger WHERE stock_id IN (?)) x
      WHERE x.total <> x.balance_after`,
    [stockIds],
  );
  const last = await value<number>(
    conn,
    `SELECT COUNT(*) FROM stock s
      WHERE s.stock_id IN (?)
        AND s.quantity_available <> COALESCE((SELECT l.balance_after FROM stock_ledger l
                                               WHERE l.stock_id = s.stock_id
                                               ORDER BY l.changed_at DESC, l.ledger_id DESC LIMIT 1), 0)`,
    [stockIds],
  );
  return Number(running) + Number(last);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function setUp(conn: Connection): Promise<{ fixture: Fixture; createdRoleId: number | null }> {
  let createdRoleId: number | null = null;
  let roleId = await value<number | undefined>(conn, "SELECT role_id FROM role WHERE role_name = 'COORDINATOR'");
  if (roleId === undefined) {
    roleId = await insert(conn, "INSERT INTO role (role_name) VALUES ('COORDINATOR')", []);
    createdRoleId = roleId;
  }
  const userId = await insert(
    conn,
    "INSERT INTO `user` (role_id, name, email, password_hash) VALUES (?, 'zz_race user', 'zz_race_user@eras.test', 'x')",
    [roleId],
  );
  const impactLoc = await insert(
    conn,
    "INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_race_impact', 12.9716, 77.5946)",
    [],
  );
  const centerLoc = await insert(
    conn,
    "INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_race_center', 12.98, 77.60)",
    [],
  );
  const emergencyId = await insert(
    conn,
    "INSERT INTO emergency (name, type, start_time, status) VALUES ('zz_race emergency', 'FLOOD', NOW(), 'ACTIVE')",
    [],
  );
  const impactId = await insert(
    conn,
    "INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (?, ?, 'ACTIVE')",
    [emergencyId, impactLoc],
  );
  const centerId = await insert(
    conn,
    "INSERT INTO resource_center (location_id, name, center_type, status) VALUES (?, 'zz_race center', 'WAREHOUSE', 'OPERATIONAL')",
    [centerLoc],
  );
  const resourceId = await insert(
    conn,
    "INSERT INTO resource (name, category, unit) VALUES ('zz_race water', 'WATER', 'L')",
    [],
  );
  const otherResourceId = await insert(
    conn,
    "INSERT INTO resource (name, category, unit) VALUES ('zz_race food', 'FOOD', 'packs')",
    [],
  );
  return { fixture: { userId, impactId, centerId, resourceId, otherResourceId }, createdRoleId };
}

/**
 * Deletes every zz_race row, children first. Item ids are read before the
 * DELETE: a DELETE that also read resource_request would fail with 1442,
 * because the item trigger updates resource_request.
 */
async function cleanUp(conn: Connection, createdRoleId: number | null): Promise<void> {
  const ids = async (sql: string, params: unknown[] = []) =>
    (await rows(conn, sql, params)).map((r) => Number(Object.values(r)[0]));
  const resources = await ids("SELECT resource_id FROM resource WHERE name LIKE 'zz\\_race %'");
  const users = await ids("SELECT user_id FROM `user` WHERE email LIKE 'zz\\_race\\_%'");
  const stocks = resources.length ? await ids("SELECT stock_id FROM stock WHERE resource_id IN (?)", [resources]) : [];
  const requests = users.length
    ? await ids("SELECT request_id FROM resource_request WHERE user_id IN (?)", [users])
    : [];

  if (stocks.length) {
    await conn.query("DELETE FROM stock_ledger WHERE stock_id IN (?)", [stocks]);
    await conn.query("DELETE FROM allocation WHERE stock_id IN (?)", [stocks]);
  }
  if (requests.length) {
    await conn.query("DELETE FROM request_item WHERE request_id IN (?)", [requests]);
    await conn.query("DELETE FROM resource_request WHERE request_id IN (?)", [requests]);
  }
  if (stocks.length) await conn.query("DELETE FROM stock WHERE stock_id IN (?)", [stocks]);
  const emergencies = await ids("SELECT emergency_id FROM emergency WHERE name LIKE 'zz\\_race %'");
  if (emergencies.length) {
    await conn.query("DELETE FROM emergency_impact WHERE emergency_id IN (?)", [emergencies]);
    await conn.query("DELETE FROM emergency WHERE emergency_id IN (?)", [emergencies]);
  }
  await conn.query("DELETE FROM resource_center WHERE name LIKE 'zz\\_race %'");
  await conn.query("DELETE FROM location WHERE grid_id LIKE 'zz\\_race\\_%'");
  if (resources.length) await conn.query("DELETE FROM resource WHERE resource_id IN (?)", [resources]);
  if (users.length) await conn.query("DELETE FROM `user` WHERE user_id IN (?)", [users]);
  if (createdRoleId !== null) await conn.query("DELETE FROM role WHERE role_id = ?", [createdRoleId]);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function lastFiftyUnits(blocker: Connection, a: Connection, b: Connection, f: Fixture): Promise<void> {
  const stock = await newBatch(blocker, f, 50);
  const itemA = await newItem(blocker, await newRequest(blocker, f), f.resourceId, 50);
  const itemB = await newItem(blocker, await newRequest(blocker, f), f.resourceId, 50);
  const [x, y] = await race(
    blocker,
    "SELECT stock_id FROM stock WHERE stock_id = ? FOR UPDATE",
    [stock],
    () => allocate(a, itemA, stock, 50, f.userId),
    () => allocate(b, itemB, stock, 50, f.userId),
  );
  const outcomes = `${describeOutcome(x)} | ${describeOutcome(y)}`;
  check("1. last 50 units: exactly one allocation succeeds", [x, y].filter((o) => o.ok).length === 1, outcomes);
  check(
    "1. the other is refused with 'Insufficient stock in this batch'",
    [x, y].some((o) => refusedWith(o, "Insufficient stock in this batch")),
    outcomes,
  );
  const left = await value<string>(blocker, "SELECT quantity_available FROM stock WHERE stock_id = ?", [stock]);
  check("1. stock ends at 0", Number(left) === 0, `stock ${left}`);
  const ledger = await value<number>(
    blocker,
    "SELECT COUNT(*) FROM stock_ledger WHERE stock_id = ? AND reason = 'ALLOCATION'",
    [stock],
  );
  check("1. one ALLOCATION ledger row", Number(ledger) === 1, `${ledger} rows`);
  check("1. ledger agrees with stock", (await ledgerMismatches(blocker, [stock])) === 0);
}

async function overAllocateOneItem(blocker: Connection, a: Connection, b: Connection, f: Fixture): Promise<void> {
  const stock1 = await newBatch(blocker, f, 40);
  const stock2 = await newBatch(blocker, f, 40);
  const item = await newItem(blocker, await newRequest(blocker, f), f.resourceId, 60);
  const [x, y] = await race(
    blocker,
    "SELECT request_item_id FROM request_item WHERE request_item_id = ? FOR UPDATE",
    [item],
    () => allocate(a, item, stock1, 40, f.userId),
    () => allocate(b, item, stock2, 40, f.userId),
  );
  const outcomes = `${describeOutcome(x)} | ${describeOutcome(y)}`;
  check("2. one item, two batches: exactly one allocation succeeds", [x, y].filter((o) => o.ok).length === 1, outcomes);
  check(
    "2. the other is refused with 'Only 20.00 left to allocate for this item'",
    [x, y].some((o) => refusedWith(o, "Only 20.00 left to allocate for this item")),
    outcomes,
  );
  const state = await value<string>(
    blocker,
    "SELECT CONCAT_WS('/', status, fn_item_allocated(request_item_id)) FROM request_item WHERE request_item_id = ?",
    [item],
  );
  check("2. item is PARTIAL with 40 allocated", state === "PARTIAL/40.00", state);
  check("2. ledger agrees with stock", (await ledgerMismatches(blocker, [stock1, stock2])) === 0);
}

async function allocateVersusCancel(blocker: Connection, a: Connection, b: Connection, f: Fixture): Promise<void> {
  const stock1 = await newBatch(blocker, f, 100);
  const stock2 = await newBatch(blocker, f, 100);
  const item = await newItem(blocker, await newRequest(blocker, f), f.resourceId, 100);
  await blocker.query("CALL sp_allocate(?, ?, 50, ?, @aid)", [item, stock1, f.userId]);
  const existing = await value<number>(blocker, "SELECT @aid");
  const [x, y] = await race(
    blocker,
    "SELECT request_item_id FROM request_item WHERE request_item_id = ? FOR UPDATE",
    [item],
    () => allocate(a, item, stock2, 50, f.userId),
    () => attempt(() => b.query("CALL sp_cancel_allocation(?, ?)", [existing, f.userId])),
  );
  const outcomes = `${describeOutcome(x)} | ${describeOutcome(y)}`;
  check("3. allocate vs cancel: no deadlock", ![x, y].some((o) => !o.ok && o.errno === DEADLOCK), outcomes);
  check("3. both succeed", x.ok && y.ok, outcomes);
  const state = await value<string>(
    blocker,
    `SELECT CONCAT_WS('/', ri.status, fn_item_allocated(ri.request_item_id),
                      (SELECT quantity_available FROM stock WHERE stock_id = ?),
                      (SELECT quantity_available FROM stock WHERE stock_id = ?),
                      (SELECT status FROM allocation WHERE allocation_id = ?))
       FROM request_item ri WHERE ri.request_item_id = ?`,
    [stock1, stock2, existing, item],
  );
  check("3. final state (item/allocated/batch 1/batch 2/old allocation)", state === "PARTIAL/50.00/100.00/50.00/CANCELLED", state);
  check("3. ledger agrees with stock", (await ledgerMismatches(blocker, [stock1, stock2])) === 0);
}

async function requestCancelVersusAllocate(
  blocker: Connection,
  a: Connection,
  b: Connection,
  f: Fixture,
  allocateFirst: boolean,
): Promise<void> {
  const label = `4${allocateFirst ? "a" : "b"}.`;
  const stock = await newBatch(blocker, f, 100);
  const request = await newRequest(blocker, f);
  await newItem(blocker, request, f.otherResourceId, 10);
  const item = await newItem(blocker, request, f.resourceId, 10);
  const doAllocate = () => allocate(a, item, stock, 10, f.userId);
  const doCancel = () => cancelRequest(b, request);
  const [first, second] = await race(
    blocker,
    "SELECT request_item_id FROM request_item WHERE request_item_id = ? FOR UPDATE",
    [item],
    allocateFirst ? doAllocate : doCancel,
    allocateFirst ? doCancel : doAllocate,
  );
  const [alloc, cancel] = allocateFirst ? [first, second] : [second, first];
  const outcomes = `allocate ${describeOutcome(alloc)} | cancel ${describeOutcome(cancel)}`;
  check(`${label} request cancel vs allocate: no deadlock`, ![alloc, cancel].some((o) => !o.ok && o.errno === DEADLOCK), outcomes);
  const requestStatus = await value<string>(blocker, "SELECT status FROM resource_request WHERE request_id = ?", [request]);
  if (alloc.ok) {
    check(
      `${label} allocation won; cancel refused with 'Cancel this item's allocations first'`,
      refusedWith(cancel, "Cancel this item's allocations first") && requestStatus === "PARTIALLY_FULFILLED",
      `${outcomes}; request ${requestStatus}`,
    );
  } else {
    check(
      `${label} cancel won; allocation refused as CANCELLED`,
      cancel.ok &&
        refusedWith(alloc, "Item is CANCELLED; only PENDING or PARTIAL items can be allocated") &&
        requestStatus === "CANCELLED",
      `${outcomes}; request ${requestStatus}`,
    );
  }
  check(`${label} ledger agrees with stock`, (await ledgerMismatches(blocker, [stock])) === 0);
}

async function twoItemsOneRequest(blocker: Connection, a: Connection, b: Connection, f: Fixture): Promise<void> {
  const stock1 = await newBatch(blocker, f, 100);
  const request = await newRequest(blocker, f);
  const item1 = await newItem(blocker, request, f.resourceId, 10);
  const item2 = await newItem(blocker, request, f.otherResourceId, 10);
  const stock2 = await newBatch(blocker, f, 100, f.otherResourceId);
  const [x, y] = await race(
    blocker,
    "SELECT request_id FROM resource_request WHERE request_id = ? FOR UPDATE",
    [request],
    () => allocate(a, item1, stock1, 10, f.userId),
    () => allocate(b, item2, stock2, 10, f.userId),
  );
  const outcomes = `${describeOutcome(x)} | ${describeOutcome(y)}`;
  check("5. two items of one request at once: no deadlock", ![x, y].some((o) => !o.ok && o.errno === DEADLOCK), outcomes);
  const status = await value<string>(blocker, "SELECT status FROM resource_request WHERE request_id = ?", [request]);
  check("5. both succeed and the request is FULFILLED", x.ok && y.ok && status === "FULFILLED", `${outcomes}; request ${status}`);
}

async function repeatedLastUnits(blocker: Connection, a: Connection, b: Connection, f: Fixture): Promise<void> {
  const runs = 20;
  const bad: string[] = [];
  for (let i = 1; i <= runs; i++) {
    const stock = await newBatch(blocker, f, 50);
    const itemA = await newItem(blocker, await newRequest(blocker, f), f.resourceId, 50);
    const itemB = await newItem(blocker, await newRequest(blocker, f), f.resourceId, 50);
    const [x, y] = await Promise.all([
      allocate(a, itemA, stock, 50, f.userId),
      allocate(b, itemB, stock, 50, f.userId),
    ]);
    const left = Number(await value<string>(blocker, "SELECT quantity_available FROM stock WHERE stock_id = ?", [stock]));
    const oneWinner = [x, y].filter((o) => o.ok).length === 1;
    const loserRefused = [x, y].some((o) => refusedWith(o, "Insufficient stock in this batch"));
    if (!oneWinner || !loserRefused || left !== 0 || (await ledgerMismatches(blocker, [stock])) !== 0) {
      bad.push(`run ${i}: ${describeOutcome(x)} | ${describeOutcome(y)}, stock ${left}`);
    }
  }
  check(`6. ${runs} unblocked races for the last 50 units`, bad.length === 0, bad.join("; "));
}

async function main(): Promise<void> {
  const env = loadEnv(MYSQL_APP_KEYS);
  const connect = async () => {
    const conn = await mysql.createConnection({
      host: env.MYSQL_HOST,
      port: Number(env.MYSQL_PORT),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
    });
    // A lock wait this long means something is wrong; fail instead of hanging.
    await conn.query("SET SESSION innodb_lock_wait_timeout = 15");
    return conn;
  };
  const [blocker, a, b] = await Promise.all([connect(), connect(), connect()]);
  let createdRoleId: number | null = null;
  try {
    await cleanUp(blocker, null);
    const setup = await setUp(blocker);
    createdRoleId = setup.createdRoleId;
    const f = setup.fixture;

    await lastFiftyUnits(blocker, a, b, f);
    await overAllocateOneItem(blocker, a, b, f);
    await allocateVersusCancel(blocker, a, b, f);
    await requestCancelVersusAllocate(blocker, a, b, f, true);
    await requestCancelVersusAllocate(blocker, a, b, f, false);
    await twoItemsOneRequest(blocker, a, b, f);
    await repeatedLastUnits(blocker, a, b, f);
  } finally {
    await cleanUp(blocker, createdRoleId);
    await Promise.all([blocker.end(), a.end(), b.end()]);
  }

  if (failures.length > 0) {
    throw new ScriptError(`${failures.length} check(s) failed`);
  }
  console.log("\ndb:race passed");
}

runScript("db:race", main);
