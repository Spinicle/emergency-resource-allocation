import "server-only";
import {
  MongoNetworkError,
  MongoNotConnectedError,
  MongoServerError,
  MongoServerSelectionError,
  MongoTopologyClosedError,
} from "mongodb";
import type { ApiErrorBody } from "@/lib/api-contract";

/** A MongoDB driver error, mapped to an HTTP status and body (docs/HANDOFF.md 4.6). */
export type MappedMongoError = ApiErrorBody & { status: 400 | 409 | 503 };

/** Can't reach the server: getDb() failing to connect, or a lost connection mid-request. */
const UNREACHABLE = [MongoServerSelectionError, MongoNetworkError, MongoNotConnectedError, MongoTopologyClosedError];

/**
 * The response for a MongoDB error, or null if err isn't one. Only fixed
 * messages: the error's document details (errInfo, keyValue) are never used.
 */
export function mapMongoError(err: unknown): MappedMongoError | null {
  if (UNREACHABLE.some((cls) => err instanceof cls)) {
    return {
      status: 503,
      code: "UNAVAILABLE",
      message: "MongoDB is unavailable right now. Try again in a moment.",
    };
  }
  if (err instanceof MongoServerError) {
    if (err.code === 121) {
      return { status: 400, code: "VALIDATION", message: "This report doesn't meet the rules for this report type" };
    }
    if (err.code === 11000) return { status: 409, code: "DUPLICATE", message: "That value is already in use" };
  }
  return null;
}
