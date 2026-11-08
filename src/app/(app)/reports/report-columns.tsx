"use client";

import { StatusBadge, type Tone, ToneBadge } from "@/app/(app)/allocate/bits";
import { formatIst, formatQty } from "@/app/(app)/allocate/format";
import { humanize } from "@/app/(app)/emergencies/format";
import { dataTableColumns, SortableHeader } from "@/components/data-table";
import type { ReportRow, Trend } from "@/lib/report-types";

// The report table's columns, shared by /reports and the Field reports tab of
// /emergencies/[id]. Module scope: DataTable wants them stable between renders.

const TREND_TONE: Record<Trend, Tone> = { RISING: "red", STEADY: "grey", FALLING: "green" };

export function TrendBadge({ trend }: { trend: Trend | null }) {
  if (!trend) return <span className="text-muted-foreground">—</span>;
  return <ToneBadge tone={TREND_TONE[trend]}>{humanize(trend)}</ToneBadge>;
}

/** 850 -> "850 m"; 1234 -> "1.2 km". */
function formatDistance(metres: number | null): string {
  if (metres === null) return "—";
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

const col = dataTableColumns<ReportRow>();

const reportedColumn = col.accessor("reported_at", {
  header: ({ column }) => <SortableHeader column={column} title="Reported" />,
  cell: ({ getValue }) => <span className="font-medium">{formatIst(getValue())}</span>,
});

const emergencyColumn = col.accessor("emergency_name", {
  header: ({ column }) => <SortableHeader column={column} title="Emergency" />,
  cell: ({ getValue }) => getValue() ?? "—",
});

const rest = [
  col.accessor("grid_id", {
    header: ({ column }) => <SortableHeader column={column} title="Location" />,
    cell: ({ getValue }) => getValue() ?? "—",
  }),
  col.accessor("emergency_type", {
    header: ({ column }) => <SortableHeader column={column} title="Type" />,
    cell: ({ getValue }) => humanize(getValue()),
  }),
  col.accessor("severity", {
    header: "Severity",
    cell: ({ getValue }) => {
      const severity = getValue();
      return severity ? <StatusBadge value={severity} /> : "—";
    },
  }),
  col.accessor("affected_percentage", {
    header: ({ column }) => <SortableHeader column={column} title="Affected" />,
    cell: ({ getValue }) => {
      const pct = getValue();
      return pct === null ? "—" : `${formatQty(pct)} %`;
    },
  }),
  col.accessor("trend", { header: "Trend", cell: ({ getValue }) => <TrendBadge trend={getValue()} /> }),
  col.accessor("reporter", { header: "Reported by" }),
];

/** Every report: /reports. */
export const reportColumns = col.columns([reportedColumn, emergencyColumn, ...rest]);

/** A near search: adds how far each report is. */
export const nearReportColumns = col.columns([
  reportedColumn,
  emergencyColumn,
  ...rest,
  col.accessor("distance_m", {
    header: ({ column }) => <SortableHeader column={column} title="Distance" />,
    cell: ({ getValue }) => formatDistance(getValue()),
  }),
]);

/** One emergency's reports: the emergency column would repeat on every row. */
export const emergencyReportColumns = col.columns([reportedColumn, ...rest]);
