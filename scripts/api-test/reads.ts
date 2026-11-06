/**
 * Sections 1-2 and 4-10: the default run, which writes nothing. (Section 3,
 * the role matrix, is in matrix.ts.)
 */
import { createHmac } from "node:crypto";
import { ScriptError } from "../lib/script";
import {
  type Account,
  ACCOUNT_EMAIL,
  type Ctx,
  type LedgerRow,
  reconciles,
  type Session,
  snapshot,
  type StockRow,
} from "./context";
import {
  type Body,
  check,
  cookieOf,
  fetchApp,
  FORBIDDEN,
  get,
  isError,
  login,
  one,
  post,
  redirectedTo,
  type Reply,
  rows,
  section,
  show,
  SIGNED_OUT,
  skip,
  state,
} from "./harness";

// ---------------------------------------------------------------------------
// 1. Logins
// ---------------------------------------------------------------------------

export async function checkLogins(): Promise<Pick<Ctx, "as" | "sessions">> {
  section("1. Logins");
  const users: { email: string; role: Session["role"]; center?: string }[] = [
    { email: "admin@eras.test", role: "ADMIN" },
    { email: "coord@eras.test", role: "COORDINATOR" },
    { email: "field1@eras.test", role: "FIELD_OFFICER" },
    { email: "field2@eras.test", role: "FIELD_OFFICER" },
    { email: "cm.central@eras.test", role: "CENTER_MANAGER", center: "Bengaluru Central Warehouse" },
    { email: "cm.kodagu@eras.test", role: "CENTER_MANAGER", center: "Madikeri Relief Depot" },
  ];
  const signedIn = new Map<string, { cookie: string; session: Session }>();
  for (const u of users) {
    const r = await login(u.email);
    const s = r.body?.data as Session | undefined;
    check(`${u.email} signs in as ${u.role}`, r.status === 200 && s?.role === u.role, show(r));
    if (r.status !== 200 || !s) throw new ScriptError(`can't continue without ${u.email}'s session`);
    signedIn.set(u.email, { cookie: cookieOf(r), session: s });
    if (u.center) check(`${u.email} has a center`, s.centerId !== null, JSON.stringify(s));
  }
  const flags = (await login("coord@eras.test")).setCookie.find((c) => c.startsWith("eras_session=")) ?? "";
  check(
    "session cookie is HttpOnly, SameSite=Lax, Path=/, Max-Age=28800",
    /HttpOnly/i.test(flags) && /SameSite=lax/i.test(flags) && /Path=\//.test(flags) && /Max-Age=28800/.test(flags),
    flags.replace(/eras_session=[^;]*/, "eras_session=…"),
  );
  check(
    "field3 (inactive) -> 403",
    isError(await login("field3@eras.test"), 403, "FORBIDDEN", "This account has been deactivated. Ask an admin to reactivate it."),
  );
  check("wrong password -> 401", isError(await login("admin@eras.test", "not-the-password"), 401, "UNAUTHENTICATED", "Email or password is incorrect"));
  check("unknown email -> 401, same message", isError(await login("nobody@eras.test"), 401, "UNAUTHENTICATED", "Email or password is incorrect"));
  check("email trimmed and lowercased", (await login("  Coord@ERAS.test ")).status === 200);
  check("bad email -> 400", isError(await login("not-an-email"), 400, "VALIDATION"));
  check("73-byte password -> 400", isError(await login("admin@eras.test", "a".repeat(73)), 400, "VALIDATION"));

  const byAccount = <T>(pick: (a: { cookie: string; session: Session }) => T) =>
    Object.fromEntries(
      Object.entries(ACCOUNT_EMAIL).map(([account, email]) => [account, pick(signedIn.get(email)!)]),
    ) as Record<Account, T>;
  return { as: byAccount((a) => a.cookie), sessions: byAccount((a) => a.session) };
}

// ---------------------------------------------------------------------------
// 2. Tokens (T15)
// ---------------------------------------------------------------------------

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
function jwt(key: Buffer, header: object, payload: object, hash: "sha256" | "sha512" | null): string {
  const data = `${b64(header)}.${b64(payload)}`;
  return `${data}.${hash ? createHmac(hash, key).update(data).digest("base64url") : ""}`;
}

export async function checkTokens(c: Ctx): Promise<void> {
  section("2. Tokens (T15)");
  const s = c.sessions.FIELD_OFFICER;
  const now = Math.floor(Date.now() / 1000);
  const claims = { role: s.role, centerId: s.centerId, sub: String(s.userId), iat: now, exp: now + 3600 };
  const HS256 = { alg: "HS256" };
  const valid = jwt(c.jwtKey, HS256, claims, "sha256");
  const [h, p, sig] = valid.split(".");

  const me = await get("/api/auth/me", `eras_session=${valid}`);
  check("a token signed like the app's -> 200 (so the rejections below mean something)", me.status === 200 && me.body?.data?.userId === s.userId, show(me));

  const bad: [string, string][] = [
    ["tampered signature", `${h}.${p}.${(sig[0] === "A" ? "B" : "A") + sig.slice(1)}`],
    ["tampered payload (role ADMIN)", `${h}.${b64({ ...claims, role: "ADMIN" })}.${sig}`],
    ["expired", jwt(c.jwtKey, HS256, { ...claims, iat: now - 9 * 3600, exp: now - 3600 }, "sha256")],
    ["alg none", jwt(c.jwtKey, { alg: "none" }, claims, null)],
    ["HS512", jwt(c.jwtKey, { alg: "HS512" }, claims, "sha512")],
    ["bad role", jwt(c.jwtKey, HS256, { ...claims, role: "SUPERUSER" }, "sha256")],
  ];
  for (const [name, token] of bad) {
    const api = await get("/api/auth/me", `eras_session=${token}`);
    check(`${name} token: /api -> 401`, isError(api, 401, "UNAUTHENTICATED", SIGNED_OUT), show(api));
    const page = await get("/dashboard", `eras_session=${token}`);
    check(`${name} token: page -> /login`, redirectedTo(page) === "/login?next=%2Fdashboard", show(page));
  }
}

// ---------------------------------------------------------------------------
// 4-6. T15 signed out, T16, page redirects
// ---------------------------------------------------------------------------

export async function checkSignedOut(): Promise<void> {
  section("4. Signed out (T15)");
  const api = await get("/api/requests");
  check("GET /api/requests with no cookie -> 401", isError(api, 401, "UNAUTHENTICATED", SIGNED_OUT), show(api));
  const page = await get("/allocate");
  check("/allocate with no cookie -> 307 /login?next=%2Fallocate", page.status === 307 && redirectedTo(page) === "/login?next=%2Fallocate", show(page));
}

export async function checkCenterScope(c: Ctx): Promise<void> {
  section("5. Center scope (T16)");
  const { ids, as, my } = c;
  const touched = () =>
    state(
      my,
      `SELECT (SELECT quantity_available FROM stock WHERE stock_id = ?) AS qty,
              (SELECT COUNT(*) FROM stock_ledger WHERE stock_id = ?) AS ledger,
              (SELECT status FROM allocation WHERE allocation_id = ?) AS alloc,
              (SELECT COUNT(*) FROM stock WHERE batch_code = 'zz_api_t16') AS received`,
      [ids.mdkRice, ids.mdkRice, ids.genAlloc],
    );
  const before = await touched();
  const t16 = async (name: string, r: Promise<Reply>) => {
    const res = await r;
    check(`T16 ${name} -> 403`, isError(res, 403, "FORBIDDEN", FORBIDDEN), show(res));
  };
  await t16("cm.central adjusting a Madikeri batch", post(`/api/stock/${ids.mdkRice}/adjust`, as.CENTER_MANAGER, { delta: 1, reason: "ADJUSTMENT" }));
  await t16("cm.central reading a Madikeri batch's ledger", get(`/api/stock/${ids.mdkRice}/ledger`, as.CENTER_MANAGER));
  await t16(
    "cm.central receiving at Madikeri",
    post("/api/stock", as.CENTER_MANAGER, { resource_id: ids.water, center_id: ids.mdk, batch_code: "zz_api_t16", quantity: 1 }),
  );
  await t16("cm.kodagu dispatching a Bengaluru Central allocation", post(`/api/stock/allocations/${ids.genAlloc}/dispatch`, as.kodagu));
  await t16("cm.central listing ?center=Madikeri batches", get(`/api/stock?center=${ids.mdk}`, as.CENTER_MANAGER));
  await t16("cm.central listing ?center=Madikeri allocations", get(`/api/stock/allocations?center=${ids.mdk}`, as.CENTER_MANAGER));
  const after = await touched();
  check("T16 refused calls left the batch, its ledger and the allocation unchanged", before === after, `${before} -> ${after}`);
}

export async function checkPages(c: Ctx): Promise<void> {
  section("6. Pages by role (proxy)");
  const to = async (name: string, path: string, cookie: string, where: string) => {
    const r = await get(path, cookie);
    check(`${name} opening ${path} -> ${where}`, redirectedTo(r) === where, show(r));
  };
  const opens = async (name: string, path: string, cookie: string) => {
    const r = await get(path, cookie);
    check(`${name} opening ${path} -> 200`, r.status === 200, show(r));
  };
  await to("field1", "/allocate", c.as.FIELD_OFFICER, "/dashboard");
  await to("cm.central", "/allocate", c.as.CENTER_MANAGER, "/dashboard");
  await to("coord", "/inventory", c.as.COORDINATOR, "/dashboard");
  await opens("admin", "/inventory", c.as.ADMIN);
  await opens("cm.central", "/inventory", c.as.CENTER_MANAGER);
  await opens("coord", "/allocate", c.as.COORDINATOR);
}

// ---------------------------------------------------------------------------
// 7. Validation (nothing reaches the database)
// ---------------------------------------------------------------------------

export async function checkValidation(c: Ctx): Promise<void> {
  section("7. Validation (400s)");
  const { ids, as } = c;
  const v = async (name: string, r: Promise<Reply>, field?: string) => {
    const res = await r;
    check(
      `${name} -> 400${field ? ` on ${field}` : ""}`,
      isError(res, 400, "VALIDATION") && (field === undefined || res.body?.error?.fields?.[field] !== undefined),
      `${show(res)} ${JSON.stringify(res.body?.error?.fields ?? {})}`,
    );
  };
  const alloc = (batches: unknown) => post("/api/allocations", as.COORDINATOR, { request_item_id: ids.meals, batches });
  await v("suggestions ?item=abc", get("/api/allocations/suggestions?item=abc", as.COORDINATOR), "item");
  await v("allocations without ?item", get("/api/allocations", as.COORDINATOR), "item");
  await v("allocate the same batch twice", alloc([{ stock_id: ids.rte01, quantity: 1 }, { stock_id: ids.rte01, quantity: 2 }]), "batches");
  await v("allocate 1.005 (3 decimals)", alloc([{ stock_id: ids.rte01, quantity: 1.005 }]), "batches.0.quantity");
  await v("allocate from 11 batches", alloc(Array.from({ length: 11 }, (_, i) => ({ stock_id: i + 1, quantity: 1 }))), "batches");
  const badJson = await fetchApp("/api/allocations", {
    method: "POST",
    headers: { Cookie: as.COORDINATOR, "Content-Type": "application/json" },
    body: "{",
  });
  const badBody = (await badJson.json().catch(() => null)) as Body;
  check(
    "a body that isn't JSON -> 400 INVALID_JSON",
    badJson.status === 400 && badBody?.error?.code === "INVALID_JSON",
    `${badJson.status} ${badBody?.error?.code}`,
  );
  await v("stock ?center=abc", get("/api/stock?center=abc", as.ADMIN), "center");
  await v("stock allocations ?status=BOGUS", get("/api/stock/allocations?status=BOGUS", as.CENTER_MANAGER), "status");
  const receive = (body: object) => post("/api/stock", as.CENTER_MANAGER, { resource_id: ids.water, batch_code: "zz_api_bad", quantity: 1, ...body });
  await v("receive with expiry 2026-02-30", receive({ expiry_date: "2026-02-30" }), "expiry_date");
  await v("receive quantity 0", receive({ quantity: 0 }), "quantity");
  await v("receive a blank batch code", receive({ batch_code: "   " }), "batch_code");
  await v(
    "admin receives without center_id",
    post("/api/stock", as.ADMIN, { resource_id: ids.water, batch_code: "zz_api_bad", quantity: 1 }),
    "center_id",
  );
  await v("adjust by 0", post(`/api/stock/${ids.rice}/adjust`, as.CENTER_MANAGER, { delta: 0, reason: "ADJUSTMENT" }), "delta");
  await v("adjust with reason RECEIPT", post(`/api/stock/${ids.rice}/adjust`, as.CENTER_MANAGER, { delta: 1, reason: "RECEIPT" }), "reason");
  await v("adjust id abc", post("/api/stock/abc/adjust", as.CENTER_MANAGER, { delta: 1, reason: "ADJUSTMENT" }), "id");
}

// ---------------------------------------------------------------------------
// 8. Reads that hold on any database
// ---------------------------------------------------------------------------

export async function checkReads(c: Ctx): Promise<void> {
  section("8. Reads: scope, order and shape");
  const { ids, as, my } = c;

  const mine = await get("/api/stock", as.CENTER_MANAGER);
  const list = (mine.body?.data ?? []) as StockRow[];
  check("cm.central's batches are all their own center", mine.status === 200 && list.length > 0 && list.every((b) => b.center_id === ids.blr), show(mine));
  const fefo = list.every((b, i) => {
    const p = list[i - 1];
    if (!p || p.resource_name !== b.resource_name) return true;
    if (p.expiry_date === null) return b.expiry_date === null && p.batch_code <= b.batch_code;
    if (b.expiry_date === null) return true;
    return p.expiry_date < b.expiry_date || (p.expiry_date === b.expiry_date && p.batch_code <= b.batch_code);
  });
  check("batches are FEFO within each resource (no expiry last)", fefo);
  const order = (
    await rows<{ name: string }>(
      my,
      "SELECT DISTINCT r.name FROM stock s JOIN resource r ON r.resource_id = s.resource_id WHERE s.center_id = ? ORDER BY r.name",
      [ids.blr],
    )
  ).map((r) => r.name);
  check("batches are grouped by resource in name order", JSON.stringify([...new Set(list.map((b) => b.resource_name))]) === JSON.stringify(order));
  check(
    "batch rows carry days_left and a boolean usable",
    list.every((b) => typeof b.usable === "boolean" && "days_left" in b),
  );
  check("cm.central ?center=<own> -> 200", (await get(`/api/stock?center=${ids.blr}`, as.CENTER_MANAGER)).status === 200);

  const all = (await get("/api/stock", as.ADMIN)).body?.data as StockRow[];
  const empty = (await get("/api/stock?center=", as.ADMIN)).body?.data as StockRow[];
  const [{ n: batches }] = await rows<{ n: number }>(my, "SELECT COUNT(*) AS n FROM stock");
  check("admin sees every batch; ?center= (empty) means all", all?.length === Number(batches) && empty?.length === all.length, `${all?.length}/${empty?.length}/${batches}`);
  const wf = (await get(`/api/stock?center=${ids.wfd}`, as.ADMIN)).body?.data as StockRow[];
  check("admin ?center=Whitefield lists only Whitefield", wf?.length > 0 && wf.every((b) => b.center_id === ids.wfd));

  const res = await get("/api/resources", as.FIELD_OFFICER);
  const names = (await rows<{ name: string }>(my, "SELECT name FROM resource ORDER BY name")).map((r) => r.name);
  check(
    "field1 lists every resource, by name",
    res.status === 200 && JSON.stringify((res.body?.data ?? []).map((r: { name: string }) => r.name)) === JSON.stringify(names),
    show(res),
  );

  const al = await get("/api/stock/allocations", as.CENTER_MANAGER);
  const allocs = (al.body?.data ?? []) as { center_id: number; status: string; request_id: number; emergency_name: string; grid_id: string; resource_name: string; allocated_by: string }[];
  const open = (s: string) => s === "RESERVED" || s === "DISPATCHED";
  const firstClosed = allocs.findIndex((a) => !open(a.status));
  check("cm.central's allocations are all their own center", al.status === 200 && allocs.length > 0 && allocs.every((a) => a.center_id === ids.blr), show(al));
  check("RESERVED and DISPATCHED come first", firstClosed === -1 || allocs.slice(firstClosed).every((a) => !open(a.status)));
  check(
    "allocation rows carry request, emergency, grid, resource and who allocated",
    allocs.every((a) => a.request_id && a.emergency_name && a.grid_id && a.resource_name && a.allocated_by),
  );
  const reserved = (await get("/api/stock/allocations?status=RESERVED", as.CENTER_MANAGER)).body?.data as { status: string }[];
  check("?status=RESERVED filters", Array.isArray(reserved) && reserved.every((a) => a.status === "RESERVED"));

  const busiest = await one<{ id: number; qty: number }>(
    my,
    `SELECT s.stock_id AS id, s.quantity_available AS qty FROM stock s JOIN stock_ledger l ON l.stock_id = s.stock_id
      WHERE s.center_id = ? GROUP BY s.stock_id ORDER BY COUNT(*) DESC, s.stock_id LIMIT 1`,
    [ids.blr],
  );
  const lg = await get(`/api/stock/${busiest.id}/ledger`, as.CENTER_MANAGER);
  const ledger = (lg.body?.data ?? []) as LedgerRow[];
  check(
    `the busiest Bengaluru Central batch's ledger (${ledger.length} rows) reconciles`,
    lg.status === 200 && ledger.length > 1 && reconciles(ledger, busiest.qty),
    show(lg),
  );
  check(
    "ledger rows carry reason, allocation_id and a changed_by name",
    ledger.every((r) => r.reason && "allocation_id" in r && typeof r.changed_by === "string") && ledger.some((r) => r.allocation_id !== null),
  );
}

// ---------------------------------------------------------------------------
// 9. The seed scenario (HANDOFF 4.8)
// ---------------------------------------------------------------------------

export async function checkSeed(c: Ctx): Promise<void> {
  section("9. Seed scenario");
  const { ids, as } = c;
  const scenario: [string, () => Promise<[boolean, string?]>][] = [
    [
      "queue: 19 rows, Bellandur life jackets first",
      async () => {
        const queue = (await get("/api/allocations/queue", as.COORDINATOR)).body?.data as { grid_id: string; resource_name: string }[];
        return [
          queue?.length === 19 && queue[0].grid_id === "BLR-BELLANDUR" && queue[0].resource_name === "Life jacket",
          `${queue?.length} rows, top ${queue?.[0]?.grid_id} ${queue?.[0]?.resource_name}`,
        ];
      },
    ],
    [
      "life jackets: no suggestions (none usable)",
      async () => {
        const js = await get(`/api/allocations/suggestions?item=${ids.jackets}`, as.COORDINATOR);
        return [js.status === 200 && js.body.data.length === 0, show(js)];
      },
    ],
    [
      "Koramangala meals: BLR-RTE-01 suggested first",
      async () => {
        const first = (await get(`/api/allocations/suggestions?item=${ids.meals}`, as.COORDINATOR)).body?.data?.[0]?.batch_code;
        return [first === "BLR-RTE-01", first];
      },
    ],
    ["cm.central sees 30 batches", async () => [(await get("/api/stock", as.CENTER_MANAGER)).body?.data?.length === 30]],
    [
      "admin sees 80 batches, Whitefield 6",
      async () => {
        const all = (await get("/api/stock", as.ADMIN)).body?.data?.length;
        const wf = (await get(`/api/stock?center=${ids.wfd}`, as.ADMIN)).body?.data?.length;
        return [all === 80 && wf === 6, `${all}, ${wf}`];
      },
    ],
    ["/api/resources lists 25", async () => [(await get("/api/resources", as.FIELD_OFFICER)).body?.data?.length === 25]],
  ];
  for (const [name, run] of scenario) {
    if (c.stale) skip(name, `${c.stale}; run npm run db:reset`);
    else check(name, ...(await run()));
  }
}

// ---------------------------------------------------------------------------
// 10. Nothing written
// ---------------------------------------------------------------------------

export async function checkNothingWritten(c: Ctx, before: string): Promise<void> {
  section("10. Nothing written");
  const after = await snapshot(c.my, c.db);
  check("MySQL row counts and activity_log are unchanged", before === after, `${before} -> ${after}`);
}
