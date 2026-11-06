/**
 * --writes: P1.8 / P1.9 behaviour (allocate, split, cancel, receive, adjust,
 * write-off refusals, dispatch/deliver), the ledger and activity_log they
 * leave, and T15's live sessions. Needs a freshly seeded database; leaves it
 * changed.
 */
import type { Role } from "../../src/lib/enums";
import { ScriptError } from "../lib/script";
import { type Ctx, type LedgerRow, reconciles, type StockRow } from "./context";
import {
  check,
  cookieOf,
  EMAIL,
  get,
  isError,
  KODAGU,
  login,
  MAX_ID,
  one,
  post,
  redirectedTo,
  section,
  show,
  state,
} from "./harness";

/** Entries a write logs: the backfill's shapes (HANDOFF 4.4). */
type Entry = {
  action: string;
  actor?: { user_id: number | null; name: string; role: string | null };
  entity?: { type: string; id: number };
  refs?: { request_id?: number; emergency_id?: number; center_id?: number };
  payload?: Record<string, unknown>;
};
const brief = (e: Entry | null) => JSON.stringify(e && { actor: e.actor, entity: e.entity, refs: e.refs, payload: e.payload });

/** What the write sections share: the run's start time, its activity entries, a batch's quantity. */
function kit(c: Ctx) {
  // Every entry this run logs is newer than this; the backfill's are older.
  const started = new Date(Date.now() - 1_000);
  const log = c.db.collection<Entry & { ts: Date }>("activity_log");
  return {
    started,
    log,
    entry: (action: string, id: number) => log.findOne({ action, "entity.id": id, ts: { $gte: started } }),
    qty: async (id: number) =>
      (await one<{ q: number }>(c.my, "SELECT quantity_available AS q FROM stock WHERE stock_id = ?", [id])).q,
  };
}
type Kit = ReturnType<typeof kit>;

export async function checkWrites(c: Ctx): Promise<void> {
  const k = kit(c);
  await checkAllocation(c, k);
  const received = await checkStock(c, k);
  await checkLedger(c, k, [c.ids.rte01, c.ids.mdkGen, c.ids.ksnGen, c.ids.blkt, ...received]);
  await checkActivity(k);
  await checkLiveSessions(c);
}

// ---------------------------------------------------------------------------
// W1. Allocation (P1.8)
// ---------------------------------------------------------------------------

async function checkAllocation(c: Ctx, k: Kit): Promise<void> {
  section("W1. Allocation (P1.8)");
  const { ids, as, my } = c;
  const coord = c.sessions.COORDINATOR;
  const suggestions = (await get(`/api/allocations/suggestions?item=${ids.meals}`, as.COORDINATOR)).body?.data ?? [];
  const best = suggestions[0] as { stock_id: number; batch_code: string; suggested_qty: number } | undefined;
  if (best?.batch_code !== "BLR-RTE-01") throw new ScriptError(`Koramangala meals should suggest BLR-RTE-01 first, got ${best?.batch_code}`);
  const q0 = await k.qty(best.stock_id);
  const made = await post("/api/allocations", as.COORDINATOR, {
    request_item_id: ids.meals,
    batches: [{ stock_id: best.stock_id, quantity: best.suggested_qty }],
  });
  const item = made.body?.data?.item;
  const mealsAlloc = made.body?.data?.allocations?.[0]?.allocation_id as number;
  check("allocate Koramangala meals from BLR-RTE-01 -> 201", made.status === 201 && Number.isInteger(mealsAlloc), show(made));
  if (!Number.isInteger(mealsAlloc)) throw new ScriptError("can't continue without the meals allocation");
  check(
    "the item is FULFILLED with nothing left, and its request rolled up",
    item?.item_status === "FULFILLED" && item.quantity_remaining === 0 && item.request_status !== "OPEN",
    `${item?.item_status} ${item?.quantity_remaining} ${item?.request_status}`,
  );
  check(`the batch went down by ${best.suggested_qty}`, q0 - (await k.qty(best.stock_id)) === best.suggested_qty);
  const alloRows = await one<{ n: number }>(
    my,
    "SELECT COUNT(*) AS n FROM stock_ledger WHERE allocation_id = ? AND reason = 'ALLOCATION'",
    [mealsAlloc],
  );
  check("one ALLOCATION ledger row for it", Number(alloRows.n) === 1);
  const created = await k.entry("ALLOCATION_CREATED", mealsAlloc);
  check(
    "ALLOCATION_CREATED: coord, entity ALLOCATION, three refs, { quantity, resource, batch_code }",
    created?.actor?.user_id === coord.userId &&
      created.actor.role === "COORDINATOR" &&
      created.entity?.type === "ALLOCATION" &&
      created.refs?.request_id === item.request_id &&
      created.refs?.emergency_id === item.emergency_id &&
      created.refs?.center_id === ids.blr &&
      created.payload?.quantity === best.suggested_qty &&
      created.payload?.resource === "Ready-to-eat meal" &&
      created.payload?.batch_code === "BLR-RTE-01",
    brief(created),
  );

  const totals = () =>
    state(
      my,
      `SELECT (SELECT COUNT(*) FROM allocation) AS allocations, (SELECT COUNT(*) FROM stock_ledger) AS ledger,
              (SELECT SUM(quantity_available) FROM stock) AS stock`,
    );
  const t0 = await totals();
  const tooBig = await post("/api/allocations", as.COORDINATOR, {
    request_item_id: ids.generators,
    batches: [{ stock_id: ids.mdkGen, quantity: 2 }, { stock_id: ids.ksnGen, quantity: 2 }],
  });
  check(
    "generators MDK-GEN-01 2 + KSN-GEN-01 2 -> 409 Insufficient stock in this batch",
    isError(tooBig, 409, "RULE", "Insufficient stock in this batch"),
    show(tooBig),
  );
  const t1 = await totals();
  check("the refused split wrote nothing (allocations, ledger, stock)", t0 === t1, `${t0} -> ${t1}`);
  const split = await post("/api/allocations", as.COORDINATOR, {
    request_item_id: ids.generators,
    batches: [{ stock_id: ids.ksnGen, quantity: 1 }, { stock_id: ids.mdkGen, quantity: 2 }],
  });
  const sd = split.body?.data;
  check(
    "generators MDK-GEN-01 2 + KSN-GEN-01 1 -> 201, two allocations, PARTIAL 3 of 5",
    split.status === 201 && sd.allocations.length === 2 && sd.item.item_status === "PARTIAL" &&
      sd.item.quantity_allocated === 3 && sd.item.quantity_requested === 5,
    show(split),
  );
  check("the split's allocations come back in stock_id order", sd?.allocations?.[0]?.stock_id < sd?.allocations?.[1]?.stock_id);

  const qb = await k.qty(best.stock_id);
  const cancel = await post(`/api/allocations/${mealsAlloc}/cancel`, as.COORDINATOR);
  check(
    "cancel the meals allocation -> 200 CANCELLED, item back to PENDING",
    cancel.status === 200 && cancel.body.data.allocation.status === "CANCELLED" && cancel.body.data.item.item_status === "PENDING",
    show(cancel),
  );
  check(`the cancel returned ${best.suggested_qty} to the batch`, (await k.qty(best.stock_id)) - qb === best.suggested_qty);
  const back = await one<{ ledger_id: number; change_qty: number; balance_after: number; changed_by: number }>(
    my,
    "SELECT ledger_id, change_qty, balance_after, changed_by FROM stock_ledger WHERE allocation_id = ? AND reason = 'ALLOCATION_CANCELLED'",
    [mealsAlloc],
  );
  check("an ALLOCATION_CANCELLED ledger row by the canceller", back.changed_by === coord.userId && back.change_qty === best.suggested_qty);
  const cancelled = await k.entry("ALLOCATION_CANCELLED", mealsAlloc);
  check(
    "ALLOCATION_CANCELLED carries its ledger row and the three refs",
    cancelled?.payload?.ledger_id === back.ledger_id &&
      cancelled.payload.change_qty === back.change_qty &&
      cancelled.payload.balance_after === back.balance_after &&
      cancelled.payload.batch_code === "BLR-RTE-01" &&
      cancelled.payload.resource === "Ready-to-eat meal" &&
      cancelled.refs?.request_id === item.request_id &&
      cancelled.refs?.center_id === ids.blr,
    brief(cancelled),
  );
  const twice = await post(`/api/allocations/${mealsAlloc}/cancel`, as.COORDINATOR);
  check("cancel it again -> 409", isError(twice, 409, "RULE", "Allocation is already CANCELLED"), show(twice));
  const ghost = await post(`/api/allocations/${MAX_ID}/cancel`, as.COORDINATOR);
  check("cancel an unknown allocation -> 409", isError(ghost, 409, "RULE", `Allocation ${MAX_ID} not found`), show(ghost));
  const history = await get(`/api/allocations?item=${ids.meals}`, as.COORDINATOR);
  const past = (history.body?.data?.allocations ?? []) as { status: string; allocated_by: string }[];
  check(
    "the item's allocations show the cancelled one and who allocated it",
    history.status === 200 && past.length === 1 && past[0].status === "CANCELLED" && past[0].allocated_by === coord.name,
    show(history),
  );
}

// ---------------------------------------------------------------------------
// W2. Stock (P1.9)
// ---------------------------------------------------------------------------

/** Returns the batches it received or changed, for W3. */
async function checkStock(c: Ctx, k: Kit): Promise<(number | undefined)[]> {
  section("W2. Stock (P1.9)");
  const { ids, as, my } = c;
  const cm = c.sessions.CENTER_MANAGER;
  const inFuture = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  const receive = (cookie: string, body: object) => post("/api/stock", cookie, { resource_id: ids.water, quantity: 1, ...body });
  const recv = await receive(as.CENTER_MANAGER, { batch_code: "  zz_api_01 ", quantity: 250.5, expiry_date: inFuture });
  const nb = recv.body?.data?.batch as StockRow | undefined;
  check("cm.central receives a batch -> 201", recv.status === 201 && nb !== undefined, show(recv));
  if (!nb) throw new ScriptError("can't continue without the received batch");
  check(
    "it lands at their center with the code trimmed, usable",
    nb.center_id === ids.blr && nb.batch_code === "zz_api_01" && nb.quantity_available === 250.5 && nb.usable === true,
    JSON.stringify(nb),
  );
  const receipt = await one<{ ledger_id: number; reason: string; change_qty: number; changed_by: number }>(
    my,
    "SELECT ledger_id, reason, change_qty, changed_by FROM stock_ledger WHERE stock_id = ?",
    [nb.stock_id],
  );
  check(
    "one RECEIPT row by cm.central, and the response returns it",
    receipt.reason === "RECEIPT" && receipt.change_qty === 250.5 && receipt.changed_by === cm.userId &&
      recv.body.data.ledger.ledger_id === receipt.ledger_id && recv.body.data.ledger.changed_by === cm.name,
    JSON.stringify(receipt),
  );
  const received = await k.entry("STOCK_RECEIVED", nb.stock_id);
  check(
    "STOCK_RECEIVED: cm.central, entity STOCK, refs.center_id, the ledger row as payload",
    received?.actor?.user_id === cm.userId &&
      received.entity?.type === "STOCK" &&
      received.refs?.center_id === ids.blr &&
      received.payload?.ledger_id === receipt.ledger_id &&
      received.payload?.change_qty === 250.5 &&
      received.payload?.balance_after === 250.5 &&
      received.payload?.batch_code === "zz_api_01" &&
      received.payload?.resource === "Drinking water",
    brief(received),
  );
  const dup = await receive(as.CENTER_MANAGER, { batch_code: "zz_api_01" });
  check("the same batch code again -> 409 DUPLICATE", isError(dup, 409, "DUPLICATE"), show(dup));
  const closed = await receive(as.ADMIN, { center_id: ids.wfd, batch_code: "zz_api_wf", quantity: 10 });
  check(
    "admin receiving at CLOSED Whitefield -> 409",
    isError(closed, 409, "RULE", "Center Whitefield Relief Camp is CLOSED, so it can't receive stock"),
    show(closed),
  );
  const ks = await receive(as.ADMIN, { center_id: ids.ksn, batch_code: "zz_api_ksn", quantity: 10 });
  check("admin receiving at Kushalnagar (no manager) -> 201", ks.status === 201 && ks.body.data.batch.center_id === ids.ksn, show(ks));
  const old = await receive(as.CENTER_MANAGER, { batch_code: "zz_api_old", quantity: 5, expiry_date: "2025-01-01" });
  check(
    "a past expiry date is accepted, as an expired batch",
    old.status === 201 && old.body.data.batch.usable === false && old.body.data.batch.days_left < 0,
    show(old),
  );
  const noCenter = await receive(as.ADMIN, { center_id: MAX_ID, batch_code: "zz_api_u" });
  check("an unknown center -> 404", isError(noCenter, 404, "NOT_FOUND", `Center ${MAX_ID} not found`), show(noCenter));
  const noResource = await receive(as.CENTER_MANAGER, { resource_id: MAX_ID, batch_code: "zz_api_r" });
  check("an unknown resource -> 409 MISSING_REFERENCE", isError(noResource, 409, "MISSING_REFERENCE"), show(noResource));

  const sid = nb.stock_id;
  const adjust = (cookie: string, id: number, delta: number, reason: string) =>
    post(`/api/stock/${id}/adjust`, cookie, { delta, reason });
  const a1 = await adjust(as.CENTER_MANAGER, sid, 5, "ADJUSTMENT");
  check(
    "adjust +5 ADJUSTMENT -> 200, 255.5",
    a1.status === 200 && a1.body.data.batch.quantity_available === 255.5 && a1.body.data.ledger.reason === "ADJUSTMENT" &&
      a1.body.data.ledger.change_qty === 5,
    show(a1),
  );
  const a2 = await adjust(as.CENTER_MANAGER, sid, -3, "WRITE_OFF");
  check(
    "write off 3 -> 200, 252.5",
    a2.status === 200 && a2.body.data.batch.quantity_available === 252.5 && a2.body.data.ledger.reason === "WRITE_OFF" &&
      a2.body.data.ledger.balance_after === 252.5,
    show(a2),
  );
  const adjusted = await k.entry("STOCK_ADJUSTED", sid);
  const writtenOff = await k.entry("STOCK_WRITTEN_OFF", sid);
  check(
    "STOCK_ADJUSTED and STOCK_WRITTEN_OFF carry their ledger rows",
    adjusted?.payload?.ledger_id === a1.body.data.ledger.ledger_id && adjusted?.payload?.change_qty === 5 &&
      adjusted?.payload?.balance_after === 255.5 && writtenOff?.payload?.ledger_id === a2.body.data.ledger.ledger_id &&
      writtenOff?.payload?.change_qty === -3 && writtenOff?.refs?.center_id === ids.blr,
    `${brief(adjusted)} ${brief(writtenOff)}`,
  );
  const batchState = () =>
    state(my, "SELECT quantity_available AS q, (SELECT COUNT(*) FROM stock_ledger WHERE stock_id = ?) AS n FROM stock WHERE stock_id = ?", [sid, sid]);
  const s0 = await batchState();
  const up = await adjust(as.CENTER_MANAGER, sid, 3, "WRITE_OFF");
  check("write off +3 -> 409", isError(up, 409, "RULE", "A write-off must reduce the quantity"), show(up));
  const under = await adjust(as.CENTER_MANAGER, sid, -1000, "WRITE_OFF");
  check("write off more than the batch holds -> 409", isError(under, 409, "RULE", "Insufficient stock in this batch"), show(under));
  check("the refused write-offs wrote nothing", s0 === (await batchState()));
  const wf = await one<{ id: number }>(
    my,
    "SELECT stock_id AS id FROM stock WHERE center_id = ? AND quantity_available > 1 ORDER BY stock_id LIMIT 1",
    [ids.wfd],
    "a Whitefield batch with stock",
  );
  const wfOff = await adjust(as.ADMIN, wf.id, -1, "WRITE_OFF");
  check("admin writes off 1 at CLOSED Whitefield -> 200", wfOff.status === 200, show(wfOff));

  const refs = await one<{ request_id: number; emergency_id: number }>(
    my,
    `SELECT ri.request_id, ei.emergency_id
       FROM allocation a
       JOIN request_item ri ON ri.request_item_id = a.request_item_id
       JOIN resource_request rr ON rr.request_id = ri.request_id
       JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
      WHERE a.allocation_id = ?`,
    [ids.blktAlloc],
  );
  const move = (id: number, to: "dispatch" | "deliver") => post(`/api/stock/allocations/${id}/${to}`, as.CENTER_MANAGER);
  const d1 = await move(ids.blktAlloc, "dispatch");
  check("dispatch Mahadevapura's blankets -> 200 DISPATCHED", d1.status === 200 && d1.body.data.allocation.status === "DISPATCHED", show(d1));
  const d2 = await move(ids.blktAlloc, "dispatch");
  check("dispatch it again -> 409", isError(d2, 409, "RULE", "Allocation is already DISPATCHED"), show(d2));
  const d3 = await move(ids.blktAlloc, "deliver");
  check("deliver it -> 200 DELIVERED", d3.status === 200 && d3.body.data.allocation.status === "DELIVERED", show(d3));
  const dispatched = await k.entry("ALLOCATION_DISPATCHED", ids.blktAlloc);
  const delivered = await k.entry("ALLOCATION_DELIVERED", ids.blktAlloc);
  check(
    "ALLOCATION_DISPATCHED and _DELIVERED: cm.central, three refs, the batch",
    [dispatched, delivered].every(
      (e) =>
        e?.actor?.user_id === cm.userId &&
        e.refs?.request_id === refs.request_id &&
        e.refs?.emergency_id === refs.emergency_id &&
        e.refs?.center_id === ids.blr &&
        e.payload?.batch_code === "BLR-BLKT-01" &&
        e.payload?.derived === undefined,
    ),
    `${brief(dispatched)} ${brief(delivered)}`,
  );
  const early = await move(ids.orsAlloc, "deliver");
  check("deliver a RESERVED allocation -> 409", isError(early, 409, "RULE", "Allocation can't go from RESERVED to DELIVERED"), show(early));
  const late = await post(`/api/allocations/${ids.blktAlloc}/cancel`, as.COORDINATOR);
  check("cancel a DELIVERED allocation -> 409", isError(late, 409, "RULE", "Allocation can't go from DELIVERED to CANCELLED"), show(late));

  return [sid, ks.body?.data?.batch?.stock_id, old.body?.data?.batch?.stock_id, wf.id];
}

// ---------------------------------------------------------------------------
// W3. Ledger (T18)
// ---------------------------------------------------------------------------

async function checkLedger(c: Ctx, k: Kit, batches: (number | undefined)[]): Promise<void> {
  section("W3. Ledger (T18)");
  const touched = batches.filter((id): id is number => Number.isInteger(id));
  const off: number[] = [];
  for (const id of touched) {
    const lg = await get(`/api/stock/${id}/ledger`, c.as.ADMIN);
    if (lg.status !== 200 || !reconciles(lg.body.data as LedgerRow[], await k.qty(id))) off.push(id);
  }
  check(`GET /ledger reconciles on all ${touched.length} batches this run touched`, touched.length === 8 && off.length === 0, `off: ${off.join(", ")}`);
  const q11 = await one<{ rows_off: number; batches_off: number }>(
    c.my,
    `SELECT (SELECT COUNT(*)
               FROM (SELECT l.balance_after,
                            SUM(l.change_qty) OVER (PARTITION BY l.stock_id ORDER BY l.changed_at, l.ledger_id) AS running
                       FROM stock_ledger l) AS x
              WHERE x.running <> x.balance_after) AS rows_off,
            (SELECT COUNT(*) FROM stock s
              WHERE s.quantity_available <> COALESCE((SELECT l.balance_after FROM stock_ledger l
                                                       WHERE l.stock_id = s.stock_id
                                                       ORDER BY l.changed_at DESC, l.ledger_id DESC LIMIT 1), 0)) AS batches_off`,
  );
  check(
    "query 11 on every batch: 0 running-total and 0 last-balance mismatches",
    Number(q11.rows_off) === 0 && Number(q11.batches_off) === 0,
    JSON.stringify(q11),
  );
}

// ---------------------------------------------------------------------------
// W4. activity_log
// ---------------------------------------------------------------------------

async function checkActivity(k: Kit): Promise<void> {
  section("W4. activity_log");
  const grouped = await k.log
    .aggregate<{ _id: string; n: number }>([{ $match: { ts: { $gte: k.started } } }, { $group: { _id: "$action", n: { $sum: 1 } } }])
    .toArray();
  const got = JSON.stringify(Object.fromEntries(grouped.map((g) => [g._id, g.n]).sort()));
  const want = JSON.stringify({
    ALLOCATION_CANCELLED: 1,
    ALLOCATION_CREATED: 3,
    ALLOCATION_DELIVERED: 1,
    ALLOCATION_DISPATCHED: 1,
    STOCK_ADJUSTED: 1,
    STOCK_RECEIVED: 3,
    STOCK_WRITTEN_OFF: 2,
  });
  check("one entry per successful write, none for the refused ones", got === want, got);
}

// ---------------------------------------------------------------------------
// W5. Live sessions (T15)
// ---------------------------------------------------------------------------

async function checkLiveSessions(c: Ctx): Promise<void> {
  section("W5. Live sessions (T15)");
  const { my, ids } = c;
  const field1 = EMAIL.FIELD_OFFICER;
  const roleId = async (name: Role) =>
    (await one<{ id: number }>(my, "SELECT role_id AS id FROM role WHERE role_name = ?", [name])).id;

  const f = cookieOf(await login(field1));
  await my.query("UPDATE `user` SET is_active = FALSE WHERE email = ?", [field1]);
  try {
    check("field1 deactivated: the open session's /api calls -> 401", isError(await get("/api/auth/me", f), 401, "UNAUTHENTICATED"));
    const page = await get("/dashboard", f);
    check("field1 deactivated: a page sends them to /login", redirectedTo(page)?.startsWith("/login") ?? false, show(page));
    check("field1 deactivated: signing in -> 403", isError(await login(field1), 403, "FORBIDDEN"));
  } finally {
    await my.query("UPDATE `user` SET is_active = TRUE WHERE email = ?", [field1]);
  }

  const f2 = cookieOf(await login(field1));
  await my.query("UPDATE `user` SET role_id = ? WHERE email = ?", [await roleId("COORDINATOR"), field1]);
  try {
    check("field1's role changed: the open session -> 401", isError(await get("/api/auth/me", f2), 401, "UNAUTHENTICATED"));
    const again = await login(field1);
    check("field1 signs in again as COORDINATOR", again.status === 200 && again.body?.data?.role === "COORDINATOR", show(again));
  } finally {
    await my.query("UPDATE `user` SET role_id = ? WHERE email = ?", [await roleId("FIELD_OFFICER"), field1]);
  }

  const k = cookieOf(await login(KODAGU));
  await my.query("UPDATE `user` SET center_id = NULL WHERE email = ?", [KODAGU]);
  try {
    check("cm.kodagu's center removed: the open session -> 401", isError(await get("/api/auth/me", k), 401, "UNAUTHENTICATED"));
    check(
      "cm.kodagu signs in again -> 403",
      isError(await login(KODAGU), 403, "FORBIDDEN", "Your account isn't linked to a resource center. Ask an admin to assign one."),
    );
  } finally {
    await my.query("UPDATE `user` SET center_id = ? WHERE email = ?", [ids.mdk, KODAGU]);
  }
}
