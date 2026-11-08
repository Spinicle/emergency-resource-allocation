import type { Db } from "mongodb";
import { type EmergencyType, type Role, SEVERITIES, type Severity } from "../../src/lib/enums";
import { dateToIst, istToDate } from "../../src/lib/ist";
import { fileFieldReport, insertFieldReport, type ReportContent, type Reporter } from "./field_reports";
import { type Queryable, selectRows } from "./queryable";
import type { CollectionModule } from "./setup";

// field_reports' seed data (docs/HANDOFF.md P2.3), about 150 reports:
//  1. One report for each observation 07_seed already wrote.
//  2. New observations, each with its report, through the same cross-database
//     write the API uses.
//
// New observations stay strictly before each impact's second-latest seeded one:
// the latest drives the queue scores and query 7 compares it with the one just
// before it, so nothing may land between those two. That window is 32-90 h, so
// HANDOFF's "last 14 days" can't apply.
//
// Every time comes from stored MySQL times and every choice from a fixed-seed
// PRNG, so each db:reset writes the same reports relative to the seed.

const PRNG_SEED = 0x45524153; // "ERAS"
const NEW_REPORT_TOTAL = 112;
const RADIUS_KM = 2;
const KM_PER_DEGREE = 111.195; // R = 6371, like fn_distance_km
const RETRIES_ON_DUPLICATE = 5;

/** The impacts that get new observations. Never KDG-NAPOKLU (the queue's no-observation case) or the CLOSED Mysuru emergency. */
const NEW_REPORT_IMPACTS = [
  "BLR-BELLANDUR",
  "BLR-MAHADEVAPURA",
  "BLR-KORAMANGALA",
  "BLR-YELAHANKA",
  "KDG-MADIKERI",
  "KDG-MAKKANDUR",
  "KDG-BHAGAMANDALA",
] as const;

/** Real local names around each impact, for notes and infrastructure. */
const PLACES: Record<string, readonly string[]> = {
  "BLR-BELLANDUR": ["Bellandur lake outfall", "Sarjapur Road", "Ibblur junction", "Green Glen Layout"],
  "BLR-MAHADEVAPURA": ["Mahadevapura", "Whitefield Main Road", "Hoodi junction", "Garudacharpalya"],
  "BLR-KORAMANGALA": ["Sony World junction", "Ejipura", "Koramangala 6th Block", "Inner Ring Road"],
  "BLR-YELAHANKA": ["Yelahanka New Town", "Allalasandra lake", "Kogilu Cross", "Attur Layout"],
  "KDG-MADIKERI": ["Madikeri town", "Sampaje ghat", "Raja's Seat", "Galibeedu Road"],
  "KDG-MAKKANDUR": ["Makkandur", "Hemmethalu", "Monnangeri", "Udayagiri"],
  "KDG-BHAGAMANDALA": ["Bhagamandala", "Talacauvery Road", "Ayyangeri", "Karike Road"],
  "MYS-NR-MOHALLA": ["N.R. Mohalla", "Ashoka Road", "Mandi Mohalla", "Gandhi Nagar"],
  "MYS-NANJANGUD": ["Nanjangud town", "Kapila river bank", "Thandavapura", "Devarasanahalli"],
};

/** What a type's reports draw on. needs are exact resource names, so P2.4 and P2.5 can match MySQL. */
type TypeTemplates = {
  notes: readonly string[];
  tags: readonly string[];
  infrastructure: readonly { kind: string; status: string }[];
  needs: readonly string[];
};

const TEMPLATES: Partial<Record<EmergencyType, TypeTemplates>> = {
  FLOOD: {
    notes: [
      "Ground floors flooded near {place}; elderly residents need evacuation.",
      "Storm drain overflow at {place}; boats are running evacuation to higher ground.",
      "Drinking water lines contaminated around {place}; tanker supply needed.",
      "Families stranded on upper floors near {place} are asking for drinking water and food.",
      "The road to {place} is under water; rescue teams are moving on foot.",
      "Power is out across {place}; residents need lanterns and generators.",
      "Water is slow to drain near {place} and silt is blocking the lanes.",
    ],
    tags: ["water", "evacuation", "rescue", "power", "sanitation", "road-access"],
    infrastructure: [
      { kind: "underpass", status: "IMPASSABLE" },
      { kind: "road", status: "SUBMERGED" },
      { kind: "storm drain", status: "OVERFLOWING" },
      { kind: "pump house", status: "DAMAGED" },
      { kind: "substation", status: "SHUT DOWN" },
    ],
    needs: [
      "Drinking water",
      "Ready-to-eat meal",
      "Life jacket",
      "Inflatable rescue boat",
      "Blanket",
      "Hygiene kit",
      "First aid kit",
      "ORS sachet",
      "Solar lantern",
      "Rope 50 m",
      "Stretcher",
      "Raincoat",
    ],
  },
  LANDSLIDE: {
    notes: [
      "Fresh landslide on the road to {place}; the village is cut off.",
      "Landslide debris buried two houses near {place}; evacuation to the relief camp is under way.",
      "Cracks on the slope above {place}; more evacuation likely if the rain continues.",
      "Springs near {place} are running muddy and drinking water is short.",
      "A landslide has blocked the {place} stretch; earth movers are waiting for the rain to ease.",
      "The relief camp near {place} needs tarpaulins, blankets and drinking water.",
    ],
    tags: ["landslide", "evacuation", "shelter", "road-access", "water", "rescue"],
    infrastructure: [
      { kind: "road", status: "BLOCKED" },
      { kind: "culvert", status: "WASHED OUT" },
      { kind: "footbridge", status: "DAMAGED" },
      { kind: "power line", status: "DOWN" },
      { kind: "retaining wall", status: "COLLAPSED" },
    ],
    needs: [
      "Family tent",
      "Tarpaulin sheet",
      "Blanket",
      "Rice",
      "Toor dal",
      "Drinking water",
      "First aid kit",
      "Portable generator 5 kVA",
      "Rope 50 m",
      "Solar lantern",
      "Stretcher",
      "Raincoat",
    ],
  },
  EPIDEMIC: {
    notes: [
      "Dengue cases rising in households around {place}; fogging requested.",
      "Stored drinking water containers near {place} found with larvae.",
      "The fever clinic at {place} is short of test kits.",
      "Door-to-door survey around {place} found stagnant water on rooftops.",
      "Severe dengue patients near {place} needed evacuation to the district hospital.",
    ],
    tags: ["dengue", "fogging", "vector-control", "water", "clinic"],
    infrastructure: [
      { kind: "fever clinic", status: "OVERLOADED" },
      { kind: "ward", status: "FULL" },
      { kind: "drain", status: "BLOCKED" },
      { kind: "water tank", status: "CONTAMINATED" },
    ],
    needs: [
      "Dengue NS1 test kit",
      "Paracetamol 500 mg",
      "IV fluid RL 500 ml",
      "ORS sachet",
      "Mosquito net",
      "Bleaching powder",
      "Drinking water",
      "Stretcher",
    ],
  },
};

/** How much of each unit one report asks for, per affected-percentage point. */
const QTY_PER_UNIT: Record<string, number> = {
  L: 60,
  kg: 8,
  packet: 12,
  tin: 2,
  strip: 4,
  sachet: 10,
  bottle: 3,
  kit: 1,
  sheet: 2,
  piece: 3,
  unit: 0.15,
  coil: 0.2,
};

type Rng = () => number;

/** mulberry32: small, fast, and the same sequence every run. */
function createRng(seed: number): Rng {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

/** n different items, or all of them if there are fewer. */
function sample<T>(rng: Rng, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const taken: T[] = [];
  while (taken.length < n && pool.length > 0) {
    taken.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return taken;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** A point uniform in a disc of RADIUS_KM around lat,lng. */
function scatter(rng: Rng, lat: number, lng: number): { lat: number; lng: number } {
  const r = RADIUS_KM * Math.sqrt(rng());
  const angle = 2 * Math.PI * rng();
  const dLat = (r * Math.cos(angle)) / KM_PER_DEGREE;
  const dLng = (r * Math.sin(angle)) / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  return { lat: Number((lat + dLat).toFixed(6)), lng: Number((lng + dLng).toFixed(6)) };
}

/** Splits total over weights by the largest-remainder method. */
function apportion(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (w / sum) * total);
  const shares = exact.map(Math.floor);
  const left = total - shares.reduce((a, b) => a + b, 0);
  const byRemainder = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of byRemainder.slice(0, left)) shares[i] += 1;
  return shares;
}

type ObservationRow = {
  observation_id: number;
  impact_id: number;
  observed_at: string;
  affected_percentage: number;
  severity: Severity;
  emergency_id: number;
  emergency_type: EmergencyType;
  start_time: string;
  grid_id: string;
  latitude: number;
  longitude: number;
  user_id: number;
  user_name: string;
  role: Role;
};

/** One point on an impact's timeline: a seeded observation, or a new one still to be filed. */
type TimelineEntry = { ms: number; pct: number; severity: Severity; seeded?: ObservationRow };

/** Severity and affected % at a moment: linear between neighbouring points, clamped before the first. */
function valuesAt(points: readonly TimelineEntry[], ms: number): { pct: number; severity: Severity } {
  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  const nextIndex = points.findIndex((p) => p.ms > ms);
  if (nextIndex === 0) return { pct: points[0].pct, severity: points[0].severity };
  const before = points[nextIndex === -1 ? points.length - 1 : nextIndex - 1];
  const after = nextIndex === -1 ? before : points[nextIndex];
  const share = after.ms === before.ms ? 0 : (ms - before.ms) / (after.ms - before.ms);
  return {
    pct: round2(before.pct + (after.pct - before.pct) * share),
    severity: SEVERITIES[Math.round(rank(before.severity) + (rank(after.severity) - rank(before.severity)) * share)],
  };
}

function trendSince(previous: TimelineEntry | undefined, current: TimelineEntry): "RISING" | "STEADY" | "FALLING" {
  if (!previous) return "STEADY";
  const change = current.pct - previous.pct;
  if (change > 0.5) return "RISING";
  if (change < -0.5) return "FALLING";
  return "STEADY";
}

/** The resource table and what each emergency has requested, for needs_observed. */
type Catalog = { units: Map<string, string>; requested: Set<string> };
const requestKey = (emergencyId: number, resource: string) => `${emergencyId}:${resource}`;

type ReportContext = {
  rng: Rng;
  catalog: Catalog;
  row: Pick<ObservationRow, "emergency_id" | "emergency_type" | "grid_id">;
  pct: number;
  severity: Severity;
  trend: "RISING" | "STEADY" | "FALLING";
  /** Every sixth report includes a need nobody has requested for its emergency (field-vs-request gap). */
  withUnrequestedNeed: boolean;
};

function buildNeeds({ rng, catalog, row, pct, withUnrequestedNeed }: ReportContext, templates: TypeTemplates) {
  const requested = templates.needs.filter((n) => catalog.requested.has(requestKey(row.emergency_id, n)));
  const unrequested = templates.needs.filter((n) => !catalog.requested.has(requestKey(row.emergency_id, n)));
  const names = sample(rng, requested.length > 0 ? requested : templates.needs, 1 + Math.floor(rng() * 3));
  if (withUnrequestedNeed && unrequested.length > 0) names.push(pick(rng, unrequested));

  return names.map((item) => {
    const unit = catalog.units.get(item);
    if (!unit) throw new Error(`seed_field_reports: resource "${item}" isn't in the resource table (did 07_seed change?)`);
    const perPoint = QTY_PER_UNIT[unit] ?? 1;
    return { item, est_qty: Math.max(1, Math.round((10 + pct) * (0.5 + rng()) * perPoint)), unit };
  });
}

function buildCasualties(rng: Rng, severity: Severity) {
  const rank = SEVERITIES.indexOf(severity);
  if (rng() >= 0.2 + 0.2 * rank) return undefined;
  return {
    injured: Math.floor(rng() * (rank + 1) * 4),
    missing: rank >= 2 ? Math.floor(rng() * rank) : 0,
    deceased: rank === 3 && rng() < 0.3 ? 1 : 0,
  };
}

/** The report's content for its type. Only the three seeded emergency types have templates. */
function buildContent(context: ReportContext): ReportContent {
  const { rng, row, pct, severity, trend } = context;
  const templates = TEMPLATES[row.emergency_type];
  const places = PLACES[row.grid_id];
  if (!templates || !places) {
    throw new Error(`seed_field_reports: no templates for ${row.emergency_type} at ${row.grid_id} (did 07_seed change?)`);
  }

  const rank = SEVERITIES.indexOf(severity);
  const fill = (note: string) => note.replace("{place}", pick(rng, places));
  const casualties = buildCasualties(rng, severity);
  const infrastructure =
    rng() < 0.7
      ? sample(rng, templates.infrastructure, 1 + Math.floor(rng() * 2)).map((part) => ({ ...part, name: pick(rng, places) }))
      : undefined;
  const sections = {
    ...(casualties && { casualties }),
    ...(infrastructure && { infrastructure }),
    needs_observed: buildNeeds(context, templates),
    notes: sample(rng, templates.notes, 2).map(fill).join(" "),
    tags: sample(rng, templates.tags, 2 + Math.floor(rng() * 2)),
  };

  switch (row.emergency_type) {
    case "FLOOD":
      return {
        ...sections,
        emergency_type: "FLOOD",
        details: {
          // Tracks the affected percentage, with a little reading-to-reading noise.
          water_level_m: round2(Math.max(0, 0.15 + pct * 0.025 + (rng() - 0.5) * 0.1)),
          roads_submerged: Math.floor(pct / 10) + Math.floor(rng() * 3),
          trend,
        },
      };
    case "EPIDEMIC":
      return {
        ...sections,
        emergency_type: "EPIDEMIC",
        details: {
          new_cases: Math.round(pct * (0.4 + rng() * 0.6)),
          deaths: rank >= 2 && rng() < 0.25 ? 1 : 0,
          trend,
        },
      };
    case "LANDSLIDE":
      return {
        ...sections,
        emergency_type: "LANDSLIDE",
        details: {
          houses_damaged: Math.floor(pct / 8) + Math.floor(rng() * 3),
          road_blocked: rank >= 2 || rng() < 0.3,
          rainfall_mm: Math.round(20 + pct * rng() * 2),
          trend,
        },
      };
    default:
      throw new Error(`seed_field_reports: no details for ${row.emergency_type}`);
  }
}

/** Reads everything the seed needs: the seeded observations (oldest first per impact) and the catalog. */
async function loadSeedData(mysql: Queryable): Promise<{ rows: ObservationRow[]; catalog: Catalog }> {
  const rows = await selectRows<ObservationRow>(
    mysql,
    `SELECT o.observation_id, o.impact_id, o.observed_at, o.affected_percentage, o.severity,
            ei.emergency_id, e.type AS emergency_type, e.start_time,
            l.grid_id, l.latitude, l.longitude,
            u.user_id, u.name AS user_name, r.role_name AS role
       FROM impact_observation o
       JOIN emergency_impact ei ON ei.impact_id   = o.impact_id
       JOIN emergency e         ON e.emergency_id = ei.emergency_id
       JOIN location l          ON l.location_id  = ei.location_id
       JOIN \`user\` u          ON u.user_id      = o.user_id
       JOIN role r              ON r.role_id      = u.role_id
      ORDER BY l.grid_id, o.observed_at`,
  );
  const resources = await selectRows<{ name: string; unit: string }>(mysql, "SELECT name, unit FROM resource");
  const requested = await selectRows<{ emergency_id: number; name: string }>(
    mysql,
    `SELECT DISTINCT ei.emergency_id, res.name
       FROM request_item ri
       JOIN resource_request rr ON rr.request_id = ri.request_id
       JOIN emergency_impact ei ON ei.impact_id  = rr.impact_id
       JOIN resource res        ON res.resource_id = ri.resource_id`,
  );
  return {
    rows,
    catalog: {
      units: new Map(resources.map((r) => [r.name, r.unit])),
      requested: new Set(requested.map((r) => requestKey(r.emergency_id, r.name))),
    },
  };
}

/** The moments for count new observations, one per equal slot of the open interval (startMs, endMs). */
function newObservationTimes(rng: Rng, startMs: number, endMs: number, count: number): number[] {
  const slot = (endMs - startMs) / count;
  return Array.from({ length: count }, (_, i) => {
    const ms = startMs + (i + 0.1 + 0.8 * rng()) * slot;
    return Math.floor(ms / 1000) * 1000; // DATETIME has whole seconds
  });
}

/** fileFieldReport, moving one second earlier on a duplicate (never later, which could cross the upper bound). */
async function fileAtFreeSecond(
  db: Db,
  mysql: Queryable,
  input: Omit<Parameters<typeof fileFieldReport>[2], "observed_at">,
  ms: number,
  startMs: number,
): Promise<void> {
  let at = ms;
  for (let attempt = 0; attempt <= RETRIES_ON_DUPLICATE; attempt += 1) {
    if (at <= startMs) break;
    try {
      await fileFieldReport(db, mysql, { ...input, observed_at: dateToIst(new Date(at)) });
      return;
    } catch (err) {
      if ((err as { errno?: number }).errno !== 1062) throw err;
      at -= 1000;
    }
  }
  throw new Error(`seed_field_reports: no free second for impact ${input.impact_id} near ${dateToIst(new Date(ms))}`);
}

async function seedFieldReports(db: Db, mysql: Queryable): Promise<void> {
  const rng = createRng(PRNG_SEED);
  const { rows, catalog } = await loadSeedData(mysql);

  const byGrid = new Map<string, ObservationRow[]>();
  for (const row of rows) byGrid.set(row.grid_id, [...(byGrid.get(row.grid_id) ?? []), row]);

  /** The open window before each impact's second-latest seeded observation. */
  const windows = NEW_REPORT_IMPACTS.map((grid) => {
    const seeded = byGrid.get(grid);
    if (!seeded || seeded.length < 2) {
      throw new Error(`seed_field_reports: ${grid} needs at least two seeded observations (did 07_seed change?)`);
    }
    const startMs = istToDate(seeded[0].start_time).getTime();
    const endMs = istToDate(seeded[seeded.length - 2].observed_at).getTime();
    return { grid, startMs, endMs };
  });
  const shares = apportion(windows.map((w) => w.endMs - w.startMs), NEW_REPORT_TOTAL);

  let reportIndex = 0;
  const backfill: Parameters<typeof insertFieldReport>[1][] = [];
  const fresh: { input: Omit<Parameters<typeof fileFieldReport>[2], "observed_at">; ms: number; startMs: number }[] = [];

  for (const [grid, seeded] of byGrid) {
    const windowIndex = windows.findIndex((w) => w.grid === grid);
    const window = windows[windowIndex];
    const reporter: Reporter = { user_id: seeded[0].user_id, name: seeded[0].user_name, role: seeded[0].role };

    const seededEntries: TimelineEntry[] = seeded.map((row) => ({
      ms: istToDate(row.observed_at).getTime(),
      pct: row.affected_percentage,
      severity: row.severity,
      seeded: row,
    }));
    // Every seeded observation except the latest shapes the curve: new ones are all before the second-latest.
    const curve = seededEntries.slice(0, -1);
    const newEntries: TimelineEntry[] = window
      ? newObservationTimes(rng, window.startMs, window.endMs, shares[windowIndex]).map((ms) => ({ ms, ...valuesAt(curve, ms) }))
      : [];
    const timeline = [...seededEntries, ...newEntries].sort((a, b) => a.ms - b.ms);

    timeline.forEach((entry, i) => {
      const report = buildContent({
        rng,
        catalog,
        row: seeded[0],
        pct: entry.pct,
        severity: entry.severity,
        trend: trendSince(timeline[i - 1], entry),
        withUnrequestedNeed: reportIndex % 6 === 0,
      });
      reportIndex += 1;
      const location = scatter(rng, seeded[0].latitude, seeded[0].longitude);

      if (entry.seeded) {
        backfill.push({
          observation_id: entry.seeded.observation_id,
          emergency_id: entry.seeded.emergency_id,
          impact_id: entry.seeded.impact_id,
          reported_by: {
            user_id: entry.seeded.user_id,
            name: entry.seeded.user_name,
            role: entry.seeded.role,
          },
          reported_at: istToDate(entry.seeded.observed_at),
          location,
          report,
        });
      } else {
        fresh.push({
          ms: entry.ms,
          startMs: window.startMs,
          input: {
            emergency_id: seeded[0].emergency_id,
            impact_id: seeded[0].impact_id,
            reported_by: reporter,
            location,
            report,
            affected_percentage: entry.pct,
            severity: entry.severity,
          },
        });
      }
    });
  }

  // Backfill first, so every existing observation has its report before new rows appear.
  for (const input of backfill) await insertFieldReport(db, input);
  for (const { input, ms, startMs } of fresh) await fileAtFreeSecond(db, mysql, input, ms, startMs);

  console.log(`  field_reports: ${backfill.length} reports for seeded observations, ${fresh.length} new`);
}

export const seedFieldReportsModule: CollectionModule = {
  name: "field_reports seed",
  setup: seedFieldReports,
};
