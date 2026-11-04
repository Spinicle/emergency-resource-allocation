import { z } from "zod";
import { EMERGENCY_TYPES, type EmergencyType, SEVERITIES } from "../enums";

// POST /api/observations (docs/HANDOFF.md 4.4). The same rules are written a
// second time as the field_reports $jsonSchema (db/mongo/field_reports.ts):
// both read the limits and lists below, and `npm run mongo:test` runs one set
// of fixtures through both and fails if they disagree. Change them together.
//
// Imports only zod and enums, so the report form (P2.3) can use it too.

/** The types with their own required details; every other type allows free details. */
export const DETAILED_TYPES = ["FLOOD", "EARTHQUAKE", "EPIDEMIC"] as const;
type DetailedType = (typeof DETAILED_TYPES)[number];
type OtherType = Exclude<EmergencyType, DetailedType>;
const isOther = (t: EmergencyType): t is OtherType => !(DETAILED_TYPES as readonly EmergencyType[]).includes(t);
/** CYCLONE, FIRE, LANDSLIDE, HEATWAVE, OTHER: every type in enums.ts without its own branch. */
export const OTHER_TYPES = EMERGENCY_TYPES.filter(isOther) as [OtherType, ...OtherType[]];

export const TRENDS = ["RISING", "STEADY", "FALLING"] as const;

/** Length and count caps, shared with the field_reports validator. */
export const REPORT_LIMITS = {
  text: 100, // needs_observed.item, unit; infrastructure.kind, name, status
  notes: 2000,
  list: 50, // needs_observed, infrastructure
  tags: 20,
  tag: 30,
  photos: 10,
  photo: 500,
  magnitude: 10,
} as const;

const L = REPORT_LIMITS;
const count = z.number().int().min(0);
const text = z.string().trim().min(1).max(L.text);
const trend = z.enum(TRENDS).optional();

const common = {
  impact_id: z.number().int().positive(),
  affected_percentage: z.number().min(0).max(100),
  severity: z.enum(SEVERITIES),
  /** Where it was seen; defaults to the impact's location. */
  location: z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .optional(),
  casualties: z.object({ injured: count.optional(), missing: count.optional(), deceased: count.optional() }).optional(),
  needs_observed: z
    .array(z.object({ item: text, est_qty: z.number().min(0).optional(), unit: text.optional() }))
    .max(L.list)
    .optional(),
  infrastructure: z
    .array(z.object({ kind: text, name: text.optional(), status: text.optional() }))
    .max(L.list)
    .optional(),
  notes: z.string().trim().max(L.notes).optional(),
  tags: z.array(z.string().trim().min(1).max(L.tag)).max(L.tags).optional(),
  photos: z.array(z.string().trim().min(1).max(L.photo)).max(L.photos).optional(),
};

export const observationSchema = z.discriminatedUnion("emergency_type", [
  z.object({
    ...common,
    emergency_type: z.literal("FLOOD"),
    details: z.object({ water_level_m: z.number().min(0), roads_submerged: count, trend }),
  }),
  z.object({
    ...common,
    emergency_type: z.literal("EARTHQUAKE"),
    details: z.object({ magnitude: z.number().min(0).max(L.magnitude), buildings_collapsed: count, trend }),
  }),
  z.object({
    ...common,
    emergency_type: z.literal("EPIDEMIC"),
    details: z.object({ new_cases: count, deaths: count, trend }),
  }),
  z.object({
    ...common,
    emergency_type: z.enum(OTHER_TYPES),
    details: z.looseObject({ trend }).default({}),
  }),
]);

export type ObservationInput = z.output<typeof observationSchema>;
