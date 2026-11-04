import type { Db } from "mongodb";
import { EMERGENCY_TYPES } from "../../src/lib/enums";
import { OTHER_TYPES, REPORT_LIMITS as L, TRENDS } from "../../src/lib/validators/observations";
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
