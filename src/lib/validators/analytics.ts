import { z } from "zod";
import { idParam, optionalIdParam } from "@/lib/validators/common";

// Query strings of /api/analytics/* (docs/HANDOFF.md P2.5).

export const unmetQuery = z.object({ emergency: optionalIdParam });

export const gapQuery = z.object({ emergency: idParam });
