import { z } from "zod";
import { ALLOCATION_STATUSES } from "../enums";
import { idParam, idSchema, MAX_QUANTITY, optionalIdParam, optionalQueryParam, quantitySchema } from "./common";

// /api/stock/* (docs/HANDOFF.md 4.10). Only the shape is checked here: the
// procedures and triggers refuse everything else (a write-off that adds stock,
// going below 0, a wrong allocation transition), and their messages are shown
// as-is. Imports only zod, enums and ./common, so P2.6's forms can use it too.

/** The reasons an adjustment may give (sp_adjust_stock's rule). */
export const ADJUST_REASONS = ["ADJUSTMENT", "WRITE_OFF"] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

/** GET /api/stock?center=&resource= */
export const stockListQuery = z.object({ center: optionalIdParam, resource: optionalIdParam });

/** GET /api/stock/allocations?center=&status= */
export const centerAllocationsQuery = z.object({
  center: optionalIdParam,
  status: optionalQueryParam(z.enum(ALLOCATION_STATUSES)),
});

/** /api/stock/[id]/… */
export const batchIdParams = z.object({ id: idParam });

/**
 * POST /api/stock: receive a batch. center_id is required for ADMIN; a
 * CENTER_MANAGER leaves it out or sends their own. A past expiry_date is
 * allowed (the batch is then expired and not usable).
 */
export const receiveBatchSchema = z.object({
  resource_id: idSchema,
  center_id: idSchema.optional(),
  batch_code: z.string().trim().min(1, "Enter a batch code").max(50, "At most 50 characters"),
  quantity: quantitySchema,
  expiry_date: z.iso.date("Use a real date as YYYY-MM-DD").nullish(),
});

export type ReceiveBatchInput = z.output<typeof receiveBatchSchema>;

/** POST /api/stock/[id]/adjust: a non-zero change with a reason. */
export const adjustStockSchema = z.object({
  delta: z
    .number("Enter the change")
    .multipleOf(0.01, "At most 2 decimal places")
    .min(-MAX_QUANTITY)
    .max(MAX_QUANTITY)
    .refine((d) => d !== 0, "The change can't be 0"),
  reason: z.enum(ADJUST_REASONS),
});

export type AdjustStockInput = z.output<typeof adjustStockSchema>;
