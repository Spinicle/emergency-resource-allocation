import "server-only";
import type { ApiErrorBody } from "@/lib/api-contract";

/** A MySQL error from mysql2, mapped to an HTTP status and body (docs/HANDOFF.md 4.6). */
export type MappedDbError = ApiErrorBody & { status: 400 | 409 };

type MysqlError = { errno: number; sqlState?: string; sqlMessage: string };

/** mysql2 server errors carry errno and sqlMessage; Node socket errors have no sqlMessage. */
function isMysqlError(err: unknown): err is MysqlError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { errno?: unknown }).errno === "number" &&
    typeof (err as { sqlMessage?: unknown }).sqlMessage === "string"
  );
}

/** First quoted name after `pattern` in a MySQL message, e.g. key 'user.email' or column 'grid_id'. */
function quotedAfter(message: string, pattern: RegExp): string | null {
  return pattern.exec(message)?.[1] ?? null;
}

type Rule = (message: string) => MappedDbError;

const inUse: Rule = () => ({
  status: 409,
  code: "IN_USE",
  message: "This record is still referenced, so it can't be deleted or changed",
});
const missingReference: Rule = () => ({
  status: 409,
  code: "MISSING_REFERENCE",
  message: "A record it refers to doesn't exist",
});
const retry: Rule = () => ({
  status: 409,
  code: "RETRY",
  message: "Someone else is changing this record right now. Try again.",
});
const badValue: Rule = (message) => {
  const column = quotedAfter(message, /column '([^']+)'/i);
  return { status: 400, code: "BAD_VALUE", message: column ? `Invalid value for ${column}` : "Invalid value" };
};

/**
 * By MySQL error number. 1451/1452 are what the admin account sees for a
 * foreign key; the app user (no SELECT on the parent's metadata) gets the
 * generic 1217/1216 instead.
 */
const RULES: Record<number, Rule> = {
  // SIGNAL SQLSTATE '45000' from a procedure or trigger: its message is written for users.
  1644: (message) => ({ status: 409, code: "RULE", message }),
  3819: (message) => ({ status: 400, code: "CHECK_VIOLATION", message }),
  1451: inUse,
  1217: inUse,
  1452: missingReference,
  1216: missingReference,
  1062: (message) => {
    const key = quotedAfter(message, /for key '([^']+)'/);
    return { status: 409, code: "DUPLICATE", message: `That value is already in use${key ? ` (${key})` : ""}` };
  },
  1213: retry, // deadlock
  1205: retry, // lock wait timeout
  1048: badValue, // column cannot be null
  1264: badValue, // out of range
  1366: badValue, // incorrect value for the column type
  1406: badValue, // data too long
};

/** The HTTP mapping of a MySQL error, or null if it isn't one we map (the caller returns a 500). */
export function mapDbError(err: unknown): MappedDbError | null {
  if (!isMysqlError(err)) return null;
  const rule = err.sqlState === "45000" ? RULES[1644] : RULES[err.errno];
  return rule ? rule(err.sqlMessage) : null;
}
