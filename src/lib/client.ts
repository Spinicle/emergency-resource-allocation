import "client-only";
import useSWR from "swr";
import type { ApiErrorBody, ErrorCode, FieldErrors } from "@/lib/api-contract";

// Browser-side access to /api/* (docs/HANDOFF.md 4.5). Pages never import DB code.

/** A failed /api call. message is the server's, written to be shown as is. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The server's code, or HTTP_ERROR when the response wasn't an { error } body. */
    readonly code: ErrorCode | "HTTP_ERROR",
    message: string,
    readonly fields?: FieldErrors,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Calls an /api route and returns its `data`. Throws ApiError with the
 * server's code, message and fields on a failure response. T describes the
 * data; it isn't checked at runtime.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Headers() accepts every HeadersInit form; the caller's values win.
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, { ...init, headers });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: ApiErrorBody } | null;
  if (!res.ok || !body || body.error) {
    const error = body?.error;
    throw new ApiError(
      res.status,
      error?.code ?? "HTTP_ERROR",
      error?.message ?? `Request failed (${res.status})`,
      error?.fields,
    );
  }
  return body.data as T;
}

/** SWR over api(): useApi<Row[]>('/api/requests'). Pass null to skip the request. */
export function useApi<T>(path: string | null) {
  return useSWR<T, ApiError>(path, (p: string) => api<T>(p));
}
