import { z } from "zod";
import { EMERGENCY_STATUSES, EMERGENCY_TYPES, IMPACT_STATUSES } from "../enums";
import { idParam } from "./common";
import { istDateTime, optionalText, queryParam, searchText } from "./fields";

// Requests to /api/emergencies/* and /api/impacts/* (docs/HANDOFF.md P2.1).
// The database's CHECK constraints stay the final word; these give the user a
// clear message before the query runs. Imports only zod and siblings, so the
// pages use the same rules.

const name = z.string("Enter a name").trim().min(1, "Enter a name").max(150, "Keep the name under 150 characters");
const type = z.enum(EMERGENCY_TYPES, "Choose a type");

/** At most 7 decimal places: location.latitude / longitude are DECIMAL(10,7). */
function coordinate(label: string, limit: number) {
  const range = `${label} is between -${limit} and ${limit}`;
  return z
    .number(`Enter a ${label.toLowerCase()}`)
    .min(-limit, range)
    .max(limit, range)
    .refine((v) => Number(v.toFixed(7)) === v, "At most 7 decimal places");
}

/** /api/emergencies/[id]/… */
export const emergencyIdParams = z.object({ id: idParam });

/** /api/impacts/[id] */
export const impactIdParams = z.object({ id: idParam });

/** GET /api/emergencies?status=&type=&q= (blank values count as not sent) */
export const emergencyListQuery = z.object({
  status: queryParam(z.enum(EMERGENCY_STATUSES, "Choose a status")),
  type: queryParam(z.enum(EMERGENCY_TYPES, "Choose a type")),
  q: searchText,
});

/** POST /api/emergencies. start_time defaults to now. New emergencies are always ACTIVE. */
export const createEmergencySchema = z.object({
  name,
  type,
  start_time: istDateTime.optional(),
  description: optionalText,
});

export type CreateEmergencyInput = z.input<typeof createEmergencySchema>;

/**
 * PATCH /api/emergencies/[id]: only the fields sent change. status "CLOSED"
 * closes it (the handler sets end_time); a CLOSED emergency can't be changed.
 */
export const updateEmergencySchema = z
  .object({
    name: name.optional(),
    type: type.optional(),
    start_time: istDateTime.optional(),
    description: optionalText,
    status: z.enum(EMERGENCY_STATUSES, "Choose a status").optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), "Change at least one field");

export type UpdateEmergencyInput = z.input<typeof updateEmergencySchema>;

/** POST /api/emergencies/[id]/impacts. An existing grid_id keeps its stored coordinates. */
export const createImpactSchema = z.object({
  grid_id: z.string("Enter a grid id").trim().min(1, "Enter a grid id").max(50, "Keep the grid id under 50 characters"),
  latitude: coordinate("Latitude", 90),
  longitude: coordinate("Longitude", 180),
});

export type CreateImpactInput = z.input<typeof createImpactSchema>;

/** PATCH /api/impacts/[id] */
export const updateImpactSchema = z.object({ status: z.enum(IMPACT_STATUSES, "Choose a status") });
