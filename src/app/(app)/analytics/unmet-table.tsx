"use client";

import { InlineError } from "@/app/(app)/allocate/bits";
import { formatQty } from "@/app/(app)/allocate/format";
import { PhaseBadge } from "@/app/(app)/emergencies/badges";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import type { UnmetRow } from "@/lib/analytics-types";
import { useApi } from "@/lib/client";

// The unmet demand table, used by /analytics (every emergency) and the Unmet
// demand tab of /emergencies/[id] (one emergency, so no emergency column).

const col = dataTableColumns<UnmetRow>();

const withUnit = (value: number, row: UnmetRow) => `${formatQty(value)} ${row.unit}`;

const resourceColumns = [
  col.accessor("resource_name", {
    header: ({ column }) => <SortableHeader column={column} title="Resource" />,
    cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
  }),
  col.accessor("quantity_requested", {
    header: ({ column }) => <SortableHeader column={column} title="Requested" />,
    cell: ({ getValue, row }) => withUnit(getValue(), row.original),
  }),
  col.accessor("quantity_allocated", {
    header: ({ column }) => <SortableHeader column={column} title="Allocated" />,
    cell: ({ getValue, row }) => withUnit(getValue(), row.original),
  }),
  col.accessor("quantity_unmet", {
    header: ({ column }) => <SortableHeader column={column} title="Unmet" />,
    cell: ({ getValue, row }) => <span className="font-medium">{withUnit(getValue(), row.original)}</span>,
  }),
];

export const unmetColumns = col.columns([
  col.accessor("emergency_name", {
    header: ({ column }) => <SortableHeader column={column} title="Emergency" />,
    cell: ({ getValue, row }) => (
      <span className="flex items-center gap-2">
        {getValue()}
        {row.original.emergency_status === "CLOSED" && <PhaseBadge value="CLOSED" />}
      </span>
    ),
  }),
  ...resourceColumns,
]);

const oneEmergencyColumns = col.columns(resourceColumns);

const rowId = (r: UnmetRow) => `${r.emergency_id}:${r.resource_id}`;

/** The Unmet demand tab: requested vs allocated per resource, most unmet first. */
export function EmergencyUnmetDemand({ emergencyId }: { emergencyId: number }) {
  const list = useApi<UnmetRow[]>(`/api/analytics/unmet?emergency=${emergencyId}`);

  if (list.error && !list.data) return <InlineError error={list.error} onRetry={() => void list.mutate()} />;
  if (!list.data) return <Skeleton className="h-48 w-full" />;
  return (
    <DataTable
      columns={oneEmergencyColumns}
      data={list.data}
      getRowId={rowId}
      emptyMessage="Nothing has been requested for this emergency yet."
    />
  );
}

export function UnmetTable({ rows }: { rows: UnmetRow[] }) {
  return <DataTable columns={unmetColumns} data={rows} getRowId={rowId} emptyMessage="Nothing has been requested yet." />;
}
