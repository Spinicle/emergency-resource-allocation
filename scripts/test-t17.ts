/**
 * npm run test:t17
 *
 * T17 (docs/HANDOFF.md Appendix A): hostile text sent to every search box is
 * treated as text. No error, no extra rows, nothing changed. Also covers the
 * search edge cases api:test:p2 doesn't: stopword-only and very short queries,
 * every word being required, and the length limit.
 *
 *   1. npm run db:reset
 *   2. npm run dev            (in a second terminal)
 *   3. npm run test:t17       (API_BASE_URL if the app isn't on http://localhost:3000)
 *
 * Writes nothing. Exits 1 if any check fails.
 */
import type { Connection, RowDataPacket } from "mysql2/promise";
import { appConnection } from "./lib/app-connection";
import { HOSTILE_SEARCHES } from "./lib/hostile-search";
import { loadEnv, MYSQL_APP_KEYS, runScript, ScriptError } from "./lib/script";

const BASE = process.env.API_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "Eras@2026"; // the seeded local-dev password (HANDOFF 4.8)
const MAX_SEARCH = 200; // MAX_SEARCH_LENGTH in src/lib/validators/fields.ts

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; data: any; error: any };
type Call = (path: string) => Promise<Res>;

type Surface = { name: string; path: string; rows: (data: unknown) => unknown[]; everyWord: boolean };

const asList = (data: unknown) => (Array.isArray(data) ? data : []);

const SURFACES: Surface[] = [
  { name: "emergencies", path: "/api/emergencies", rows: asList, everyWord: true },
  { name: "requests", path: "/api/requests", rows: asList, everyWord: true },
  // $text matches any of the words, so "every word required" doesn't apply to reports.
  { name: "reports", path: "/api/reports", rows: (d) => (d as { reports?: unknown[] }).reports ?? [], everyWord: false },
];

/** T17-only additions to the shared list. None holds a word a seeded row contains. */
const EXTRA_HOSTILE = [
  "'",
  "''",
  "*",
  "%%",
  "_%",
  '"; DROP TABLE emergency; --',
  "' UNION SELECT password_hash FROM user --",
  '{"$ne":null}',
  "$where",
  "x".repeat(MAX_SEARCH),
];

const TABLES = [
  "role", "user", "location", "emergency", "emergency_impact", "impact_observation", "resource",
  "resource_center", "stock", "stock_ledger", "resource_request", "request_item", "allocation",
];

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) passed += 1;
  else {
    failed += 1;
    if (detail !== undefined) console.log(`        got: ${JSON.stringify(detail).slice(0, 300)}`);
  }
}

const shown = (text: string) => (text.length > 44 ? `${text.slice(0, 12)}… (${text.length} chars)` : text);

async function signIn(): Promise<Call> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "coord@eras.test", password: PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!res.ok || !cookie) throw new ScriptError(`couldn't sign in as coord@eras.test (HTTP ${res.status})`);
  return async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
    const json = (await r.json().catch(() => ({}))) as { data?: unknown; error?: unknown };
    return { status: r.status, data: json.data, error: json.error };
  };
}

async function rowCounts(my: Connection): Promise<string> {
  const counts: number[] = [];
  for (const table of TABLES) {
    const [[row]] = await my.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM ??", [table]);
    counts.push(Number(row.n));
  }
  return counts.join(",");
}

const search = (call: Call, surface: Surface, text: string) => call(`${surface.path}?q=${encodeURIComponent(text)}`);

async function hostile(call: Call, strings: string[]): Promise<void> {
  for (const surface of SURFACES) {
    console.log(`\nT17 ${surface.path}?q=`);
    for (const text of strings) {
      const res = await search(call, surface, text);
      check(`${JSON.stringify(shown(text))} -> 200, no rows`, res.status === 200 && surface.rows(res.data).length === 0, res);
    }
    const tooLong = await search(call, surface, "x".repeat(MAX_SEARCH + 1));
    check(`${MAX_SEARCH + 1} characters -> 400 on q`, tooLong.status === 400 && !!tooLong.error?.fields?.q, tooLong);
  }
}

/** Nothing here is a syntax problem: these are real queries that should find nothing, or only full matches. */
async function edgeCases(call: Call): Promise<void> {
  console.log("\nSearch edge cases");
  for (const surface of SURFACES) {
    for (const text of ["the", "with from", "ab"]) {
      const res = await search(call, surface, text);
      check(`${surface.name}: ${JSON.stringify(text)} (stopwords or too short) -> 200, no rows`, res.status === 200 && surface.rows(res.data).length === 0, res);
    }
  }
  for (const surface of SURFACES.filter((s) => s.everyWord)) {
    const known = await search(call, surface, "flood");
    if (surface.rows(known.data).length === 0) {
      console.log(`  SKIP  ${surface.name}: every word required (no row has "flood"; run db:reset)`);
      continue;
    }
    const missing = await search(call, surface, "flood xqzzyunknown");
    check(`${surface.name}: every word is required ("flood" alone finds rows, with an unknown word none)`, missing.status === 200 && surface.rows(missing.data).length === 0, missing);
  }
}

async function main(): Promise<void> {
  const env = loadEnv(MYSQL_APP_KEYS);
  try {
    await fetch(BASE);
  } catch {
    throw new ScriptError(`nothing is answering at ${BASE}. Start the app first: npm run dev`);
  }
  const my = await appConnection(env);
  try {
    const call = await signIn();
    const before = await rowCounts(my);
    const strings = [...HOSTILE_SEARCHES, ...EXTRA_HOSTILE];
    await hostile(call, strings);
    await edgeCases(call);

    console.log("\nThe database");
    check("every table's row count is unchanged", (await rowCounts(my)) === before);

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) throw new ScriptError(`T17 FAIL: ${failed} check(s) failed`);
    console.log(`T17 PASS: ${strings.length} hostile strings on ${SURFACES.length} search surfaces: treated as text, no error, no extra rows, nothing changed.`);
  } finally {
    await my.end();
  }
}

runScript("test:t17", main);
