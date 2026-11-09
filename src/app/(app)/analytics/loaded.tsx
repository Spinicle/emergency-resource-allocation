"use client";

import { InlineError } from "@/app/(app)/allocate/bits";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiError } from "@/lib/client";

/** A failed first load shows inline with a Retry; a failed refetch keeps the last data. */
export function Loaded<T>({
  query,
  skeletonClassName = "h-72 w-full",
  children,
}: {
  query: { data?: T; error?: ApiError; mutate: () => unknown };
  skeletonClassName?: string;
  children: (data: T) => React.ReactNode;
}) {
  if (query.error && query.data === undefined) return <InlineError error={query.error} onRetry={() => void query.mutate()} />;
  if (query.data === undefined) return <Skeleton className={skeletonClassName} />;
  return <div className="flex flex-col gap-4">{children(query.data)}</div>;
}
