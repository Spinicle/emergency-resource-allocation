import "server-only";
import type { Role } from "@/lib/enums";

// Auth (docs/HANDOFF.md 4.5). Types only for now; getSession(), hashPassword()
// and the JWT cookie arrive in P1.6. Client code imports these with
// `import type`, which is erased at build time.

export type { Role };

/** The signed-in user. centerId is set only for CENTER_MANAGER. */
export type Session = {
  userId: number;
  name: string;
  role: Role;
  centerId: number | null;
};
