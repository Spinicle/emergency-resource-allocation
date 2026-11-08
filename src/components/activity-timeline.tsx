"use client";

import { formatIst, formatQty } from "@/app/(app)/allocate/format";
import { humanize } from "@/app/(app)/emergencies/format";
import type { TimelineEntry } from "@/lib/request-types";

// activity_log entries, newest first: a request's timeline and the dashboard's feed.

/**
 * What an allocation or stock entry moved, from its payload (HANDOFF 4.4's
 * shapes); nothing for a request entry. `batch: false` leaves the batch code out,
 * for a line that already names the batch.
 */
export function payloadSummary(payload: TimelineEntry["payload"], { batch = true }: { batch?: boolean } = {}): string | null {
  if (typeof payload?.resource !== "string") return null;
  const quantity = payload.quantity ?? payload.change_qty;
  return [
    typeof quantity === "number" ? `${formatQty(quantity)} ${payload.resource}` : payload.resource,
    batch && typeof payload.batch_code === "string" ? payload.batch_code : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `detail` is the text after the action; the payload summary unless given. */
export function ActivityTimeline<T extends TimelineEntry>({
  entries,
  detail,
}: {
  entries: T[];
  detail?: (entry: T) => string | null;
}) {
  if (entries.length === 0) return <p className="text-muted-foreground">No activity recorded yet.</p>;
  return (
    <ol className="flex flex-col gap-2">
      {entries.map((e, index) => {
        const summary = detail ? detail(e) : payloadSummary(e.payload);
        return (
          <li key={`${e.ts}-${e.action}-${e.entity_id}-${index}`}>
            <span className="font-medium">{humanize(e.action)}</span>
            {summary && <span> · {summary}</span>}
            <span className="text-muted-foreground">
              {" "}
              · {e.actor_name} · {formatIst(e.ts)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
