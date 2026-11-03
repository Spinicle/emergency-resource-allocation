import "client-only";
import useSWR from "swr";
import type { ApiErrorBody } from "@/lib/db-errors";

// Browser-side access to /api/* (docs/HANDOFF.md 4.5). Pages never import DB code.

/** A failed /api call. message is the server's, written to be shown as is. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
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
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(typeof init?.body === "string" && { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
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
