// The /api response contract (docs/HANDOFF.md 4.6), shared by the server
// (http.ts, db-errors.ts) and the browser (client.ts).
//   success  { data }
//   failure  { error: { code, message, fields? } }
// No imports, so both sides can use it.

/** Every `error.code` a Route Handler sends. */
export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_JSON"
  | "VALIDATION"
  | "CHECK_VIOLATION"
  | "BAD_VALUE"
  | "RULE"
  | "IN_USE"
  | "MISSING_REFERENCE"
  | "DUPLICATE"
  | "RETRY"
  | "INTERNAL";

/** Field path (e.g. "items.1.quantity_requested") -> its first message. */
export type FieldErrors = Record<string, string>;

/** The `error` object of a failure response. */
export type ApiErrorBody = { code: ErrorCode; message: string; fields?: FieldErrors };
