import { z } from "zod";
import { REQUEST_STATUSES, URGENCIES } from "../enums";
import { idParam, MAX_ID, optionalIdParam, optionalQueryParam, quantitySchema } from "./common";
import { istDateTime, optionalText, searchText } from "./fields";

// Requests to /api/requests/* (docs/HANDOFF.md P2.2). Imports only zod, enums
// and sibling validators (which import only zod), so the new-request form runs
// this same schema before it submits.
//
// A resource repeated across items is deliberately NOT rejected here. It has to
// reach the database, where uq_request_resource refuses it and the whole
// transaction rolls back: that's the behaviour the task demonstrates.

/** An id picked from a list. idSchema's messages would read oddly on a blank select. */
function chosenId(message: string) {
  return z.number(message).int(message).positive(message).max(MAX_ID, message);
}

const requestItemSchema = z.object({
  resource_id: chosenId("Choose a resource"),
  quantity_requested: z.number("Enter a quantity").pipe(quantitySchema),
  urgency: z.enum(URGENCIES, "Choose an urgency"),
});

/** POST /api/requests. Statuses aren't accepted: new rows start OPEN / PENDING by default. */
export const createRequestSchema = z.object({
  impact_id: chosenId("Choose an impacted location"),
  required_by: istDateTime.nullable().optional(),
  description: optionalText,
  items: z
    .array(requestItemSchema, "Add at least one item")
    .min(1, "Add at least one item")
    .max(50, "A request can have at most 50 items"),
});

export type CreateRequestInput = z.input<typeof createRequestSchema>;

/** GET /api/requests?emergency=&status=&urgency=&q= (blank values count as not sent) */
export const requestListQuery = z.object({
  emergency: optionalIdParam,
  status: optionalQueryParam(z.enum(REQUEST_STATUSES, "Choose a status")),
  urgency: optionalQueryParam(z.enum(URGENCIES, "Choose an urgency")),
  q: searchText,
});

/** /api/requests/[id]/… */
export const requestIdParams = z.object({ id: idParam });
