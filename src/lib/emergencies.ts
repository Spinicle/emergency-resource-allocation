import "server-only";
import type { PoolConnection } from "mysql2/promise";
import type { Session } from "@/lib/auth";
import type { EmergencyHeader } from "@/lib/emergency-types";
import { HttpError } from "@/lib/http";
import { logActivity } from "@/lib/mongo";
import { queryOne } from "@/lib/mysql";

// Shared by /api/emergencies/* and /api/impacts/* (docs/HANDOFF.md P2.1).

const HEADER_SQL = `SELECT emergency_id, name, type, status, start_time, end_time, description
                      FROM emergency WHERE emergency_id = ?`;

/** The emergency's own columns, or null. With conn, read inside that transaction. */
export function loadEmergencyHeader(id: number, conn?: PoolConnection): Promise<EmergencyHeader | null> {
  return queryOne<EmergencyHeader>(HEADER_SQL, [id], conn);
}

export function emergencyNotFound(id: number): HttpError {
  return new HttpError(404, `Emergency ${id} not found`);
}

/** A 400 in the same shape as a Zod failure, for a rule only the server can check. */
export function fieldError(field: string, message: string): HttpError {
  return new HttpError(400, "Check the highlighted fields", { code: "VALIDATION", fields: { [field]: message } });
}

/**
 * The SQL fragment that limits request counts to the caller's own requests for
 * a FIELD_OFFICER (HANDOFF 4.6's pattern); pair it with scopeParams(session).
 * `alias` is the resource_request alias in the query.
 */
export const scopeSql = (alias: string) => `(? <> 'FIELD_OFFICER' OR ${alias}.user_id = ?)`;
export const scopeParams = (s: Session) => [s.role, s.userId];

/** One activity_log entry for an emergency or impact write. After the commit; never throws. */
export function logEmergencyEvent(
  session: Session,
  action: "EMERGENCY_CREATED" | "EMERGENCY_UPDATED" | "EMERGENCY_CLOSED" | "IMPACT_ADDED" | "IMPACT_UPDATED",
  entity: { type: "EMERGENCY" | "IMPACT"; id: number },
  emergencyId: number,
  payload: Record<string, unknown>,
): Promise<void> {
  return logActivity({ actor: session, action, entity, refs: { emergency_id: emergencyId }, payload });
}
