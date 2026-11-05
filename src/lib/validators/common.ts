import { z } from "zod";

// Building blocks shared by request schemas (docs/HANDOFF.md 4.5). Imports
// only zod, so forms can use them too.

/** The largest value of a MySQL INT column: every primary key here. */
export const MAX_ID = 2_147_483_647;

/** An id in a JSON body. */
export const idSchema = z.number().int().positive().max(MAX_ID);

/**
 * An id in a path segment or query string, where it arrives as text. Only
 * plain digits pass ("abc", "0", "1e3", "-1" and anything past MAX_ID are a
 * 400), so MySQL never sees an out-of-range value.
 */
export const idParam = z
  .string()
  .regex(/^[1-9]\d{0,9}$/, "Must be a positive whole number")
  .transform(Number)
  .pipe(z.number().max(MAX_ID, "Must be a positive whole number"));
