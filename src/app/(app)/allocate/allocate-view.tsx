"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import type { QueueRow } from "@/lib/allocation-types";
import { useApi } from "@/lib/client";
import { idParam } from "@/lib/validators/common";
import { InlineError, StatusBadge, ToneBadge } from "./bits";
import { formatIst, formatQty } from "./format";
import { ItemPanel } from "./item-panel";
import { ScoreCell } from "./score-breakdown";

// /allocate (P1.8, docs/HANDOFF.md 4.9): the priority queue, best first. A row
// opens the item's panel; ?item=<id> is the only record of which one is open,
// so other pages (P2.2's request page) can link straight to an item.

const QUEUE_KEY = "/api/allocations/queue";

const col = dataTableColumns<QueueRow>();

const num = "text-right font-mono tabular-nums";

const columns = col.columns([
  col.accessor("priority_score", {
    header: ({ column }) => <SortableHeader column={column} title="Score" />,
    cell: ({ row }) => <ScoreCell row={row.original} />,
  }),
  col.accessor("emergency_name", {
    header: "Emergency",
    cell: ({ row }) => (
      <div className="flex flex-col items-start gap-0.5">
        <span className="whitespace-nowrap">{row.original.emergency_name}</span>
        {row.original.emergency_status === "CONTAINED" && <ToneBadge tone="grey">CONTAINED</ToneBadge>}
      </div>
    ),
  }),
  col.accessor("grid_id", {
    header: "Grid",
    cell: ({ row }) => (
      <div className="flex flex-col items-start gap-0.5">
        <span className="font-mono text-xs">{row.original.grid_id}</span>
        {row.original.impact_status === "RESOLVED" && <ToneBadge tone="grey">RESOLVED</ToneBadge>}
      </div>
    ),
  }),
  col.accessor("resource_name", { header: "Resource" }),
  col.accessor("urgency", { header: "Urgency", cell: ({ row }) => <StatusBadge value={row.original.urgency} /> }),
  col.accessor("latest_severity", {
    header: "Severity",
    cell: ({ row }) =>
      row.original.latest_severity ? (
        <StatusBadge value={row.original.latest_severity} />
      ) : (
        <span className="text-muted-foreground">none yet</span>
      ),
  }),
  col.accessor("quantity_requested", {
    header: () => <div className="text-right">Requested</div>,
    cell: ({ row }) => <div className={num}>{formatQty(row.original.quantity_requested)}</div>,
  }),
  col.accessor("quantity_allocated", {
    header: () => <div className="text-right">Allocated</div>,
    cell: ({ row }) => <div className={num}>{formatQty(row.original.quantity_allocated)}</div>,
  }),
  col.accessor("quantity_remaining", {
    header: ({ column }) => <SortableHeader column={column} title="Remaining" />,
    cell: ({ row }) => (
      <div className="whitespace-nowrap text-right">
        <span className="font-mono tabular-nums">{formatQty(row.original.quantity_remaining)}</span>{" "}
        <span className="text-muted-foreground">{row.original.unit}</span>
      </div>
    ),
  }),
  col.accessor("usable_qty", {
    header: ({ column }) => <SortableHeader column={column} title="Usable" />,
    cell: ({ row }) => {
      const { usable_qty, quantity_remaining } = row.original;
      if (usable_qty === 0) return <ToneBadge tone="red">none</ToneBadge>;
      return (
        <div className={usable_qty < quantity_remaining ? `${num} text-amber-700 dark:text-amber-400` : num}>
          {formatQty(usable_qty)}
        </div>
      );
    },
  }),
  col.accessor("required_by", {
    header: ({ column }) => <SortableHeader column={column} title="Required by" />,
    cell: ({ row }) => <span className="whitespace-nowrap">{formatIst(row.original.required_by)}</span>,
  }),
  col.accessor("hours_waiting", {
    header: ({ column }) => <SortableHeader column={column} title="Waiting" />,
    cell: ({ row }) => <div className={`${num} whitespace-nowrap`}>{row.original.hours_waiting} h</div>,
  }),
  col.accessor("item_status", { header: "Status", cell: ({ row }) => <StatusBadge value={row.original.item_status} /> }),
]);

const FILTERS = [
  { column: "emergency_name", placeholder: "Filter emergency…" },
  { column: "grid_id", placeholder: "Filter grid…" },
  { column: "resource_name", placeholder: "Filter resource…" },
];

/** ?item= as a request_item_id (the API's own rule), or null when it's missing or not one. */
function itemFromParam(value: string | null): number | null {
  const parsed = idParam.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function AllocateView() {
  const router = useRouter();
  const pathname = usePathname();
  const itemId = itemFromParam(useSearchParams().get("item"));
  const queue = useApi<QueueRow[]>(QUEUE_KEY);

  const openItem = useCallback(
    (row: QueueRow) => router.replace(`${pathname}?item=${row.request_item_id}`, { scroll: false }),
    [router, pathname],
  );
  const closeItem = useCallback(() => router.replace(pathname, { scroll: false }), [router, pathname]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        Open request items, highest priority first. Select one to see its score, the suggested batches (nearest
        center, earliest expiry first) and its allocations.
      </p>

      {/* A failed refetch keeps the last good queue on screen, with the error above it. */}
      {queue.error && <InlineError error={queue.error} onRetry={() => void queue.mutate()} />}
      {!queue.data ? (
        !queue.error && (
          <div className="flex flex-col gap-2" aria-busy>
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )
      ) : (
        <DataTable
          columns={columns}
          data={queue.data}
          filters={FILTERS}
          pageSize={25}
          emptyMessage="Nothing is waiting: every open item is fully allocated."
          getRowId={(r) => String(r.request_item_id)}
          onRowClick={openItem}
          selectedRowId={itemId === null ? null : String(itemId)}
        />
      )}

      <ItemPanel
        itemId={itemId}
        queue={queue.data}
        queueFailed={queue.error !== undefined && queue.data === undefined}
        refreshQueue={queue.mutate}
        onClose={closeItem}
      />
    </div>
  );
}
