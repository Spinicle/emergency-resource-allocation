import type { Db } from "mongodb";
import { EMERGENCY_TYPES, type Role, type Severity } from "../../src/lib/enums";
import { istToDate } from "../../src/lib/ist";
import {
  type ObservationInput,
  OTHER_TYPES,
  REPORT_LIMITS as L,
  TRENDS,
} from "../../src/lib/validators/observations";
import { insertActivity } from "./activity_log";
import { type Queryable, selectRows } from "./queryable";
import type { CollectionModule } from "./setup";

// field_reports (docs/HANDOFF.md 4.4): one document per impact_observation
// row, linked by observation_id. Its shape varies by emergency type.
//
// The validator restates src/lib/validators/observations.ts (same limits and
// lists); `npm run mongo:test` checks the two agree. Change them together.

export const FIELD_REPORTS = "field_reports";

const int = { bsonType: "int" } as const;
const number = { bsonType: "number" } as const;
const count = { bsonType: "number", minimum: 0, multipleOf: 1 } as const;
const text = { bsonType: "string", minLength: 1, maxLength: L.text } as const;

/**
 * One branch per type. Each pins emergency_type, so exactly one can match:
 * without that, a FLOOD report missing water_level_m would still pass as
 * "other" (HANDOFF section 8).
 */
const branches = [
  {
    properties: {
      emergency_type: { enum: ["FLOOD"] },
      details: {
        required: ["water_level_m", "roads_submerged"],
        properties: { water_level_m: { ...number, minimum: 0 }, roads_submerged: count },
      },
    },
  },
  {
    properties: {
      emergency_type: { enum: ["EARTHQUAKE"] },
      details: {
        required: ["magnitude", "buildings_collapsed"],
        properties: { magnitude: { ...number, minimum: 0, maximum: L.magnitude }, buildings_collapsed: count },
      },
    },
  },
  {
    properties: {
      emergency_type: { enum: ["EPIDEMIC"] },
      details: { required: ["new_cases", "deaths"], properties: { new_cases: count, deaths: count } },
    },
  },
  { properties: { emergency_type: { enum: [...OTHER_TYPES] } } },
];

/** The validator. Extra top-level fields are allowed. */
export const fieldReportSchema = {
  bsonType: "object",
  required: [
    "emergency_id",
    "impact_id",
    "observation_id",
    "emergency_type",
    "reported_by",
    "reported_at",
    "location",
    "details",
  ],
  properties: {
    emergency_id: int,
    impact_id: int,
    observation_id: int,
    emergency_type: { enum: [...EMERGENCY_TYPES] },
    reported_by: {
      bsonType: "object",
      required: ["user_id", "name"],
      properties: { user_id: int, name: { bsonType: "string", minLength: 1 } },
    },
    reported_at: { bsonType: "date" },
    // GeoJSON Point: [lng, lat].
    location: {
      bsonType: "object",
      required: ["type", "coordinates"],
      additionalProperties: false,
      properties: {
        type: { enum: ["Point"] },
        coordinates: {
          bsonType: "array",
          minItems: 2,
          maxItems: 2,
          items: [
            { ...number, minimum: -180, maximum: 180 },
            { ...number, minimum: -90, maximum: 90 },
          ],
        },
      },
    },
    details: { bsonType: "object", properties: { trend: { enum: [...TRENDS] } } },
    casualties: {
      bsonType: "object",
      properties: { injured: count, missing: count, deceased: count },
    },
    needs_observed: {
      bsonType: "array",
      maxItems: L.list,
      items: {
        bsonType: "object",
        required: ["item"],
        properties: { item: text, est_qty: { ...number, minimum: 0 }, unit: text },
      },
    },
    infrastructure: {
      bsonType: "array",
      maxItems: L.list,
      items: { bsonType: "object", required: ["kind"], properties: { kind: text, name: text, status: text } },
    },
    notes: { bsonType: "string", maxLength: L.notes },
    tags: { bsonType: "array", maxItems: L.tags, items: { bsonType: "string", minLength: 1, maxLength: L.tag } },
    photos: {
      bsonType: "array",
      maxItems: L.photos,
      items: { bsonType: "string", minLength: 1, maxLength: L.photo },
    },
  },
  oneOf: branches,
};

/** Creates field_reports with its validator and indexes. Pass a name to make a scratch copy (mongo:test). */
export async function createFieldReports(db: Db, name = FIELD_REPORTS): Promise<void> {
  await db.createCollection(name, {
    validator: { $jsonSchema: fieldReportSchema },
    validationLevel: "strict",
    validationAction: "error",
  });
  await db.collection(name).createIndexes([
    // Near-a-location search ($geoNear, P2.3).
    { key: { location: "2dsphere" } },
    // An emergency's reports, newest first.
    { key: { emergency_id: 1, reported_at: -1 } },
    // Text search over notes and observed needs ($text, P2.3).
    { key: { notes: "text", "needs_observed.item": "text" } },
    // One report per observation: the link to MySQL.
    { key: { observation_id: 1 }, unique: true },
  ]);
}

export const fieldReports: CollectionModule = {
  name: FIELD_REPORTS,
  setup: (db) => createFieldReports(db),
};

// ---------------------------------------------------------------------------
// Writing reports (docs/HANDOFF.md 4.4). POST /api/observations, mongo:test
// and P2.3's seed all go through these, so every report is written the same way.
// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a report says: its type, details and optional sections (the request body minus the MySQL fields). */
export type ReportContent = DistributiveOmit<ObservationInput, "impact_id" | "affected_percentage" | "severity" | "location">;

/** Who filed it. role is for the activity entry; the document keeps user_id and name. */
export type Reporter = { user_id: number; name: string; role: Role };

/** A report for an observation row that already exists. */
export type FieldReportInput = {
  observation_id: number;
  emergency_id: number;
  impact_id: number;
  reported_by: Reporter;
  /** The observation's observed_at as an instant (istToDate). */
  reported_at: Date;
  location: { lat: number; lng: number };
  report: ReportContent;
};

/** The field_reports document for input. Optional sections that are absent stay absent (never null). */
export function buildReportDoc(input: FieldReportInput) {
  const { emergency_type, details, ...optional } = input.report;
  const sections = Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined));
  return {
    emergency_id: input.emergency_id,
    impact_id: input.impact_id,
    observation_id: input.observation_id,
    emergency_type,
    reported_by: { user_id: input.reported_by.user_id, name: input.reported_by.name },
    reported_at: input.reported_at,
    location: { type: "Point" as const, coordinates: [input.location.lng, input.location.lat] },
    details,
    ...sections,
  };
}

/**
 * Inserts the report for an existing observation, then its FIELD_REPORT_FILED
 * entry (ts = reported_at). Throws if the report insert fails. A failed
 * activity write is logged and swallowed: it never undoes the report.
 * P2.3 uses this directly to add reports for the 38 seeded observations.
 */
export async function insertFieldReport(db: Db, input: FieldReportInput): Promise<void> {
  await db.collection(FIELD_REPORTS).insertOne(buildReportDoc(input));
  try {
    await insertActivity(db, [
      {
        ts: input.reported_at,
        actor: input.reported_by,
        action: "FIELD_REPORT_FILED",
        entity: { type: "FIELD_REPORT", id: input.observation_id },
        refs: { emergency_id: input.emergency_id },
        payload: { impact_id: input.impact_id, emergency_type: input.report.emergency_type },
      },
    ]);
  } catch (err) {
    console.error("insertFieldReport: activity entry not written:", describe(err));
  }
}

/** A new observation and its report. */
export type FileFieldReportInput = Omit<FieldReportInput, "observation_id" | "reported_at"> & {
  affected_percentage: number;
  severity: Severity;
  /** IST "YYYY-MM-DD HH:MM:SS"; the API leaves it out (MySQL NOW()), P2.3's seed sets it. */
  observed_at?: string;
};

/**
 * The cross-database write, in the 4.4 order:
 *  1. INSERT impact_observation (autocommit, so it's committed) and read back observed_at.
 *  2. insertFieldReport with that observation_id and reported_at = observed_at.
 *  3. If 2 fails, DELETE the observation (compensation) and rethrow the original
 *     error unchanged. If the DELETE fails too, log both and throw a plain Error.
 *
 * Known gap: a crash between 1 and 3 leaves an observation without a report.
 * A standalone mongod has no transactions across the two databases (no 2PC).
 * The caller checks the impact, the emergency's type and its status first.
 */
export async function fileFieldReport(
  db: Db,
  mysql: Queryable,
  input: FileFieldReportInput,
): Promise<{ observation_id: number; reported_at: Date }> {
  const [result] = await mysql.query(
    `INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity)
     VALUES (?, ?, COALESCE(?, NOW()), ?, ?)`,
    [input.impact_id, input.reported_by.user_id, input.observed_at ?? null, input.affected_percentage, input.severity],
  );
  const observationId = (result as { insertId: number }).insertId;

  try {
    const [row] = await selectRows<{ observed_at: string }>(
      mysql,
      "SELECT observed_at FROM impact_observation WHERE observation_id = ?",
      [observationId],
    );
    const reportedAt = istToDate(row?.observed_at);
    await insertFieldReport(db, { ...input, observation_id: observationId, reported_at: reportedAt });
    return { observation_id: observationId, reported_at: reportedAt };
  } catch (err) {
    try {
      await mysql.query("DELETE FROM impact_observation WHERE observation_id = ?", [observationId]);
    } catch (deleteErr) {
      console.error(`fileFieldReport: the report failed and observation ${observationId} couldn't be removed`, {
        report: describe(err),
        delete: describe(deleteErr),
      });
      throw new Error(`Field report failed and its observation ${observationId} couldn't be removed`);
    }
    throw err;
  }
}

/** What to log for an error: never the document (MongoDB's errInfo / keyValue) or the SQL. */
function describe(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  const { code } = err as Error & { code?: unknown };
  return { name: err.name, code, message: err.message };
}
