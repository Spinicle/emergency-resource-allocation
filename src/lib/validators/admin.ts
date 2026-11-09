import { z } from "zod";
import { CENTER_STATUSES, CENTER_TYPES, RESOURCE_CATEGORIES, type Role, ROLES } from "../enums";
import { MAX_PASSWORD_BYTES } from "./auth";
import { idParam, idSchema } from "./common";
import { createImpactSchema } from "./emergencies";

// Requests to /api/admin/* (docs/HANDOFF.md P2.6). Imports only zod, enums and
// siblings, so the admin forms can use the same rules. The role and center rule
// lives only here: the schema has no constraint for it (HANDOFF 4.4).

/** /api/admin/…/[id] */
export const adminIdParams = z.object({ id: idParam });

const role = z.enum(ROLES, "Choose a role");

const CENTER_MANAGER: Role = "CENTER_MANAGER";

/** A CENTER_MANAGER has a center, and nobody else does. */
function checkAssignment(value: { role?: Role; center_id?: number | null }, ctx: z.RefinementCtx): void {
  const hasCenter = value.center_id !== undefined && value.center_id !== null;
  if (value.role === CENTER_MANAGER && !hasCenter) {
    ctx.addIssue({ code: "custom", path: ["center_id"], message: "A center manager needs a center" });
  }
  if (value.role !== CENTER_MANAGER && hasCenter) {
    ctx.addIssue({ code: "custom", path: ["center_id"], message: "Only a center manager has a center" });
  }
}

/** POST /api/admin/users. Same 72-byte limit as login, plus a minimum for new passwords. */
export const createUserSchema = z
  .object({
    name: z.string("Enter a name").trim().min(1, "Enter a name").max(100, "Keep the name under 100 characters"),
    email: z.string("Enter an email").trim().toLowerCase().pipe(z.email("Enter a valid email").max(100, "Keep the email under 100 characters")),
    password: z
      .string("Enter a password")
      .min(8, "Use at least 8 characters")
      .refine((p) => new TextEncoder().encode(p).length <= MAX_PASSWORD_BYTES, `Passwords are at most ${MAX_PASSWORD_BYTES} bytes`),
    role,
    center_id: idSchema.nullish(),
  })
  .superRefine(checkAssignment);

export type CreateUserInput = z.output<typeof createUserSchema>;

/**
 * PATCH /api/admin/users/[id]: either { role, center_id } or { is_active }.
 * Role and center travel together, so the rule can be checked on the body alone.
 */
export const updateUserSchema = z
  .object({ role: role.optional(), center_id: idSchema.nullish(), is_active: z.boolean("Choose active or not").optional() })
  .superRefine((body, ctx) => {
    const assigning = body.role !== undefined;
    if (assigning === (body.is_active !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Change either the role and center, or whether the user is active" });
      return;
    }
    if (assigning) checkAssignment(body, ctx);
    else if (body.center_id !== undefined) ctx.addIssue({ code: "custom", path: ["role"], message: "Send the role with the center" });
  });

export type UpdateUserInput = z.output<typeof updateUserSchema>;

const someField = (body: Record<string, unknown>) => Object.values(body).some((value) => value !== undefined);
const CHANGE_SOMETHING = "Change at least one field";

const resourceFields = {
  name: z.string("Enter a name").trim().min(1, "Enter a name").max(100, "Keep the name under 100 characters"),
  category: z.enum(RESOURCE_CATEGORIES, "Choose a category"),
  // Free text: resource.unit has no CHECK and no list in enums.ts.
  unit: z.string("Enter a unit").trim().min(1, "Enter a unit").max(30, "Keep the unit under 30 characters"),
};

export const createResourceSchema = z.object(resourceFields);
export type CreateResourceInput = z.output<typeof createResourceSchema>;

export const updateResourceSchema = z.object(resourceFields).partial().refine(someField, CHANGE_SOMETHING);
export type UpdateResourceInput = z.output<typeof updateResourceSchema>;

const centerFields = {
  name: z.string("Enter a name").trim().min(1, "Enter a name").max(100, "Keep the name under 100 characters"),
  center_type: z.enum(CENTER_TYPES, "Choose a type"),
  status: z.enum(CENTER_STATUSES, "Choose a status"),
};

export const createCenterSchema = z.object({ ...centerFields, location_id: idSchema });
export type CreateCenterInput = z.output<typeof createCenterSchema>;

/** Strict: a center's location is fixed once created, so sending one is a 400. */
export const updateCenterSchema = z.strictObject(centerFields).partial().refine(someField, CHANGE_SOMETHING);
export type UpdateCenterInput = z.output<typeof updateCenterSchema>;

/** The same grid id and coordinate rules as adding an impact. */
export const createLocationSchema = createImpactSchema;
export type CreateLocationInput = z.output<typeof createLocationSchema>;

export const updateLocationSchema = createImpactSchema.partial().refine(someField, CHANGE_SOMETHING);
export type UpdateLocationInput = z.output<typeof updateLocationSchema>;
