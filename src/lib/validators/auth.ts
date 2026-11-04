import { z } from "zod";

// Request bodies for /api/auth/* (docs/HANDOFF.md 4.6). Imports only zod, so
// the login form can use them too.

/** bcrypt reads at most 72 bytes; auth.ts refuses longer passwords too. */
const MAX_PASSWORD_BYTES = 72;

export const loginSchema = z.object({
  email: z.string("Enter your email").trim().toLowerCase().pipe(z.email("Enter a valid email")),
  password: z
    .string("Enter your password")
    .min(1, "Enter your password")
    .refine((p) => new TextEncoder().encode(p).length <= MAX_PASSWORD_BYTES, "Passwords are at most 72 bytes"),
});

export type LoginInput = z.infer<typeof loginSchema>;
