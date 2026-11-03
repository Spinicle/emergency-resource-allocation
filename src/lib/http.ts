import "server-only";
import { unstable_rethrow } from "next/navigation";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { type ApiErrorBody, mapDbError } from "@/lib/db-errors";

/*
 * Route Handler plumbing (docs/HANDOFF.md 4.5, 4.6).
 *   success  { data }
 *   failure  { error: { code, message, fields? } }
 */

const CODE_FOR_STATUS: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
};

/** An expected failure with its status. Its message is shown to the user as is. */
export class HttpError extends Error {
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(
    readonly status: number,
    message: string,
    options: { code?: string; fields?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.code = options.code ?? CODE_FOR_STATUS[status] ?? "ERROR";
    this.fields = options.fields;
  }
}

/** A success response: { data }. */
export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

/** The request body, parsed as JSON and checked by schema. Throws HttpError 400 or a ZodError. */
export async function parseJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", { code: "INVALID_JSON" });
  }
  return schema.parse(body);
}

type Handler<Ctx> = (req: NextRequest, ctx: Ctx) => Promise<Response>;

/**
 * Wraps a Route Handler: Next's (req, ctx) pass straight through (type a
 * dynamic route's ctx as RouteContext<'/api/…/[id]'> and await ctx.params),
 * and anything thrown becomes a { error } response. Next's own control-flow
 * errors (redirect(), notFound()) are rethrown for Next to handle.
 */
export function handle<Ctx = unknown>(fn: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      unstable_rethrow(err);
      return errorResponse(err);
    }
  };
}

function fail(status: number, error: ApiErrorBody): NextResponse {
  return NextResponse.json({ error }, { status });
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return fail(err.status, { code: err.code, message: err.message, ...(err.fields && { fields: err.fields }) });
  }
  if (err instanceof z.ZodError) return fail(400, validationError(err));

  const db = mapDbError(err);
  if (db) {
    const { status, ...error } = db;
    return fail(status, error);
  }

  console.error("Unhandled error in a Route Handler:", describe(err));
  return fail(500, { code: "INTERNAL", message: "Something went wrong" });
}

/** fields: dotted path -> its first message (e.g. "items.1.quantity_requested"). */
function validationError(err: z.ZodError): ApiErrorBody {
  const fields: Record<string, string> = {};
  let formMessage: string | undefined;
  for (const issue of err.issues) {
    const path = issue.path.map(String).join(".");
    if (!path) formMessage ??= issue.message;
    else fields[path] ??= issue.message;
  }
  return { code: "VALIDATION", message: formMessage ?? "Check the highlighted fields", fields };
}

/** What to log for an unexpected error. Picks fields on purpose: mysql2 errors carry .sql, which can hold parameters. */
function describe(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  const { code, errno } = err as Error & { code?: unknown; errno?: unknown };
  return { name: err.name, message: err.message, code, errno, stack: err.stack };
}
