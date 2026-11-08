import { z } from "zod";
import { EMERGENCY_TYPES } from "../enums";
import { idParam, optionalIdParam, optionalQueryParam } from "./common";
import { searchText } from "./fields";

// Query strings of /api/reports/* (docs/HANDOFF.md P2.3). Imports only zod,
// enums and sibling validators, so the pages can use the km limits too.

export const DEFAULT_NEAR_KM = 5;
export const MIN_NEAR_KM = 0.1;
export const MAX_NEAR_KM = 50;

const NEAR = /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;
const NEAR_MESSAGE = "Use lat,lng with latitude -90 to 90 and longitude -180 to 180";
const KM_MESSAGE = `Enter a distance from ${MIN_NEAR_KM} to ${MAX_NEAR_KM} km`;

/** "12.97,77.59" -> { lat, lng }. */
const nearPoint = z.string().transform((value, ctx) => {
  const m = NEAR.exec(value.trim());
  const lat = Number(m?.[1]);
  const lng = Number(m?.[2]);
  if (!m || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    ctx.issues.push({ code: "custom", message: NEAR_MESSAGE, input: value });
    return z.NEVER;
  }
  return { lat, lng };
});

/** Plain decimals only, so "1e3" and "0x10" are a 400 rather than a surprise. */
const kmParam = z
  .string()
  .regex(/^\d+(\.\d+)?$/, KM_MESSAGE)
  .transform(Number)
  .pipe(z.number().min(MIN_NEAR_KM, KM_MESSAGE).max(MAX_NEAR_KM, KM_MESSAGE));

/** The API's own km rule, for the km box: "1e1" and ".5" are numbers but the API refuses them. */
export function isValidNearKm(text: string): boolean {
  return kmParam.safeParse(text).success;
}

/**
 * GET /api/reports?emergency=&type=&q=&near=lat,lng&km=
 * Blank values count as not sent. km is checked whenever it's sent but only
 * used with near. MongoDB can't run $text and $geoNear in one pipeline, so q
 * and near together are refused.
 */
export const reportListQuery = z
  .object({
    emergency: optionalIdParam,
    type: optionalQueryParam(z.enum(EMERGENCY_TYPES, "Choose an emergency type")),
    q: searchText,
    near: optionalQueryParam(nearPoint),
    km: optionalQueryParam(kmParam),
  })
  .superRefine((value, ctx) => {
    if (value.q && value.near) {
      ctx.addIssue({ code: "custom", path: ["near"], message: "Search by text or by distance, not both" });
    }
  });

export type ReportListQuery = z.output<typeof reportListQuery>;

/** True for an http(s) URL. A report's photos are free text, so anything else must never become a link. */
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** /api/reports/[id]: the id is the report's observation_id. */
export const reportIdParams = z.object({ id: idParam });
