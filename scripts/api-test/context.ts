/**
 * What every api:test section shares: the signed-in accounts, the seeded rows'
 * ids (found by natural keys, never by id), the database's state, and the API
 * row shapes both the read and the write checks inspect.
 */
import type { Db } from "mongodb";
import type { Connection } from "mysql2/promise";
import type { Role } from "../../src/lib/enums";
import { EMAIL, KODAGU, one } from "./harness";

export type Session = { userId: number; name: string; role: Role; centerId: number | null };

/** One signed-in account per role, plus cm.kodagu. */
export type Account = Role | "kodagu";
export const ACCOUNT_EMAIL: Record<Account, string> = { ...EMAIL, kodagu: KODAGU };

export type Ctx = {
  my: Connection;
  db: Db;
  ids: Ids;
  as: Record<Account, string>;
  sessions: Record<Account, Session>;
  jwtKey: Buffer;
  /** null when the database is as db:reset left it, else why not. */
  stale: string | null;
};

// ---------------------------------------------------------------------------
// Database state
// ---------------------------------------------------------------------------

const TABLES = [
  "role", "user", "location", "emergency", "emergency_impact", "impact_observation", "resource",
  "resource_center", "stock", "stock_ledger", "resource_request", "request_item", "allocation",
] as const;

/** Row counts of every table plus activity_log, to prove a run wrote nothing. */
export async function snapshot(my: Connection, db: Db): Promise<string> {
  const counts = await one<Record<string, number>>(
    my,
    `SELECT ${TABLES.map((t) => `(SELECT COUNT(*) FROM \`${t}\`) AS \`${t}\``).join(", ")}`,
  );
  const activity = await db.collection("activity_log").countDocuments();
  return JSON.stringify({ ...counts, activity_log: activity });
}

/** null when the database is as db:reset left it, else why not. */
export async function staleness(my: Connection, db: Db): Promise<string | null> {
  const r = await one<{ allocations: number; ledger: number; zz: number }>(
    my,
    `SELECT (SELECT COUNT(*) FROM allocation) AS allocations,
            (SELECT COUNT(*) FROM stock_ledger) AS ledger,
            (SELECT COUNT(*) FROM \`user\` WHERE email LIKE 'zz\\_%')
          + (SELECT COUNT(*) FROM location WHERE grid_id LIKE 'zz\\_%')
          + (SELECT COUNT(*) FROM stock WHERE batch_code LIKE 'zz\\_%')
          + (SELECT COUNT(*) FROM resource WHERE name LIKE 'zz\\_%') AS zz`,
  );
  // P2.3's seed adds FIELD_REPORT_FILED entries; everything else is the backfill.
  const activity = await db.collection("activity_log").countDocuments({ action: { $ne: "FIELD_REPORT_FILED" } });
  const why: string[] = [];
  if (Number(r.allocations) !== 28) why.push(`${r.allocations} allocations, not 28`);
  if (Number(r.ledger) !== 115) why.push(`${r.ledger} ledger rows, not 115`);
  if (activity !== 170) why.push(`${activity} activity entries, not 170`);
  if (Number(r.zz) > 0) why.push(`${r.zz} zz_ rows`);
  return why.length > 0 ? why.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Seeded rows
// ---------------------------------------------------------------------------

/** Ids of seeded rows, found by their natural keys. */
export async function lookups(my: Connection) {
  const id = async (what: string, sql: string, ...params: unknown[]) =>
    (await one<{ id: number }>(my, sql, params, what)).id;
  const center = (name: string) =>
    id(`center ${name}`, "SELECT center_id AS id FROM resource_center WHERE name = ?", name);
  const batch = (code: string) => id(`batch ${code}`, "SELECT stock_id AS id FROM stock WHERE batch_code = ?", code);
  const resource = (name: string) =>
    id(`resource ${name}`, "SELECT resource_id AS id FROM resource WHERE name = ?", name);
  const impact = (grid: string) =>
    id(
      `impact ${grid}`,
      `SELECT ei.impact_id AS id FROM emergency_impact ei JOIN location l ON l.location_id = ei.location_id
        WHERE l.grid_id = ?`,
      grid,
    );
  /** The item for a grid and resource on a request that isn't CANCELLED. */
  const item = (grid: string, res: string) =>
    id(
      `item ${grid} / ${res}`,
      `SELECT ri.request_item_id AS id
         FROM request_item ri
         JOIN resource_request rr ON rr.request_id = ri.request_id
         JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
         JOIN location l ON l.location_id = ei.location_id
         JOIN resource r ON r.resource_id = ri.resource_id
        WHERE l.grid_id = ? AND r.name = ? AND rr.status <> 'CANCELLED'
        ORDER BY ri.request_item_id LIMIT 1`,
      grid,
      res,
    );
  /** The allocation from a batch to a grid's item. */
  const allocation = (code: string, grid: string) =>
    id(
      `allocation ${code} -> ${grid}`,
      `SELECT a.allocation_id AS id
         FROM allocation a
         JOIN stock s ON s.stock_id = a.stock_id
         JOIN request_item ri ON ri.request_item_id = a.request_item_id
         JOIN resource_request rr ON rr.request_id = ri.request_id
         JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
         JOIN location l ON l.location_id = ei.location_id
        WHERE s.batch_code = ? AND l.grid_id = ?
        ORDER BY a.allocation_id LIMIT 1`,
      code,
      grid,
    );

  return {
    blr: await center("Bengaluru Central Warehouse"),
    mdk: await center("Madikeri Relief Depot"),
    wfd: await center("Whitefield Relief Camp"),
    ksn: await center("Kushalnagar Relief Camp"),
    water: await resource("Drinking water"),
    bellandur: await impact("BLR-BELLANDUR"),
    jackets: await item("BLR-BELLANDUR", "Life jacket"),
    meals: await item("BLR-KORAMANGALA", "Ready-to-eat meal"),
    generators: await item("KDG-MADIKERI", "Portable generator 5 kVA"),
    rte01: await batch("BLR-RTE-01"),
    rice: await batch("BLR-RICE-01"),
    mdkRice: await batch("MDK-RICE-01"),
    mdkGen: await batch("MDK-GEN-01"),
    ksnGen: await batch("KSN-GEN-01"),
    blkt: await batch("BLR-BLKT-01"),
    genAlloc: await allocation("BLR-GEN-01", "BLR-MAHADEVAPURA"), // RESERVED on the seed
    ljAlloc: await allocation("BLR-LJ-01", "BLR-BELLANDUR"), // DISPATCHED on the seed
    blktAlloc: await allocation("BLR-BLKT-01", "BLR-MAHADEVAPURA"), // RESERVED on the seed
    orsAlloc: await allocation("BLR-ORS-01", "BLR-MAHADEVAPURA"), // RESERVED on the seed
  };
}
export type Ids = Awaited<ReturnType<typeof lookups>>;

// ---------------------------------------------------------------------------
// API rows
// ---------------------------------------------------------------------------

export type StockRow = {
  stock_id: number;
  batch_code: string;
  resource_name: string;
  center_id: number;
  quantity_available: number;
  expiry_date: string | null;
  days_left: number | null;
  usable: boolean;
};
export type LedgerRow = { change_qty: number; balance_after: number; reason: string; allocation_id: number | null; changed_by: string };

/** Every row's running sum equals balance_after, and the last balance equals the batch. */
export function reconciles(ledger: LedgerRow[], quantity: number): boolean {
  let run = 0;
  const steps = ledger.every((r) => {
    run = Math.round((run + r.change_qty) * 100) / 100;
    return run === r.balance_after;
  });
  return steps && (ledger.at(-1)?.balance_after ?? 0) === quantity;
}
