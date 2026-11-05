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

/**
 * An optional query-string filter: missing or empty (`?center=`, what a form's
 * "All" option sends) both mean "no filter"; anything else must pass schema.
 */
export function optionalQueryParam<S extends z.ZodType>(schema: S) {
  return z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
}

/** An optional id filter in a query string. */
export const optionalIdParam = optionalQueryParam(idParam);

/** The largest DECIMAL(12,2): every quantity column. */
export const MAX_QUANTITY = 9_999_999_999.99;

/** A quantity (allocated, received): above 0, at most 2 decimal places. */
export const quantitySchema = z
  .number()
  .positive("Must be greater than 0")
  .multipleOf(0.01, "At most 2 decimal places")
  .max(MAX_QUANTITY);
