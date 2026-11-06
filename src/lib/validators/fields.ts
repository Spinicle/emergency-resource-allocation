import { z } from "zod";

// Field rules shared by the Part 2 validators (ids live in ./common). Imports
// only zod, so forms can use it too.

/** Matches what <input type="datetime-local"> sends ("2026-11-05T14:30"), with optional seconds. */
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A date and time typed in IST, normalised to the "YYYY-MM-DD HH:MM:SS" form of
 * a DATETIME column. It stays a plain string on purpose: going through a JS
 * Date would apply the process time zone (docs/HANDOFF.md 8).
 */
export const istDateTime = z.string("Enter a date and time").transform((value, ctx) => {
  const m = DATETIME.exec(value.trim());
  // Date.UTC rolls an impossible date forward (31 Feb -> 3 Mar), so comparing
  // the day back catches those without involving any time zone.
  const isReal =
    m !== null &&
    Number(m[2]) >= 1 &&
    Number(m[2]) <= 12 &&
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDate() === Number(m[3]) &&
    Number(m[4]) <= 23 &&
    Number(m[5]) <= 59 &&
    Number(m[6] ?? 0) <= 59;
  if (!isReal) {
    ctx.issues.push({ code: "custom", message: "Enter a valid date and time", input: value });
    return z.NEVER;
  }
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? "00"}`;
});

/** Free text for a TEXT column. A blank value is stored as NULL rather than an empty string. */
export const optionalText = z
  .string()
  .trim()
  .max(5000, "Keep this under 5000 characters")
  .transform((value) => value || null)
  .nullable()
  .optional();

/** The search box. Length-capped; lib/search.ts handles what's inside it. */
export const searchText = z.string().trim().max(200, "Search text is too long").optional();
