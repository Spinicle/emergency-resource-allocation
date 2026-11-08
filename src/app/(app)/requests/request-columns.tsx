"use client";

import { StatusBadge } from "@/app/(app)/allocate/bits";
import { formatIst } from "@/app/(app)/allocate/format";
import { dataTableColumns, SortableHeader } from "@/components/data-table";
import type { RequestRow } from "@/lib/request-types";

// The request table's columns, shared by /requests and the Requests tab of
// /emergencies/[id]. Module scope: DataTable wants them stable between renders.

const col = dataTableColumns<RequestRow>();

const idColumn = col.accessor("request_id", {
  header: ({ column }) => <SortableHeader column={column} title="Request" />,
  cell: ({ getValue }) => <span className="font-medium">#{getValue()}</span>,
});

const rest = [
  col.accessor("grid_id", { header: ({ column }) => <SortableHeader column={column} title="Location" /> }),
  col.accessor("status", {
    header: ({ column }) => <SortableHeader column={column} title="Status" />,
    cell: ({ getValue }) => <StatusBadge value={getValue()} />,
  }),
  col.accessor("top_urgency", {
    header: "Top urgency",
    cell: ({ getValue }) => {
      const urgency = getValue();
      return urgency ? <StatusBadge value={urgency} /> : "—";
    },
  }),
  col.accessor("item_count", { header: ({ column }) => <SortableHeader column={column} title="Items" /> }),
  col.accessor("requested_by", { header: "Requested by" }),
  col.accessor("requested_at", {
    header: ({ column }) => <SortableHeader column={column} title="Requested" />,
    cell: ({ getValue }) => formatIst(getValue()),
  }),
  col.accessor("required_by", {
    header: ({ column }) => <SortableHeader column={column} title="Needed by" />,
    cell: ({ getValue }) => formatIst(getValue()),
  }),
];

/** Every request: /requests. */
export const requestColumns = col.columns([
  idColumn,
  col.accessor("emergency_name", { header: ({ column }) => <SortableHeader column={column} title="Emergency" /> }),
  ...rest,
]);

/** One emergency's requests: the emergency column would repeat on every row. */
export const emergencyRequestColumns = col.columns([idColumn, ...rest]);
