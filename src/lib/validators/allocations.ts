import { z } from "zod";
import { idParam, idSchema, quantitySchema } from "./common";

// /api/allocations/* (docs/HANDOFF.md 4.9). Only the shape is checked here:
// stock, remaining quantity, expiry and center/emergency status are the
// triggers' job, and their messages reach the user as-is.
//
// Imports only zod and ./common, so the /allocate page can use it too.

/** The most batches one allocation request may split an item across. */
export const MAX_SPLIT_BATCHES = 10;

/** A quantity to allocate: the shared quantity rule (above 0, at most 2 decimal places). */
export const allocationQuantity = quantitySchema;

/** ?item=<request_item_id> */
export const itemQuery = z.object({ item: idParam });

/** /api/allocations/[id]/… */
export const allocationIdParams = z.object({ id: idParam });

/** POST /api/allocations: one item, 1–10 distinct batches, all or nothing. */
export const createAllocationsSchema = z.object({
  request_item_id: idSchema,
  batches: z
    .array(z.object({ stock_id: idSchema, quantity: allocationQuantity }))
    .min(1, "Choose at least one batch")
    .max(MAX_SPLIT_BATCHES, `At most ${MAX_SPLIT_BATCHES} batches at once`)
    .refine((b) => new Set(b.map((x) => x.stock_id)).size === b.length, "Each batch can appear only once"),
});

export type CreateAllocationsInput = z.output<typeof createAllocationsSchema>;
