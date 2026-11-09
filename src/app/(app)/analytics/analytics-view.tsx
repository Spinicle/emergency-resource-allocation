"use client";

import { useState } from "react";
import { StatusBadge, ToneBadge, type Tone } from "@/app/(app)/allocate/bits";
import { formatIst, formatQty } from "@/app/(app)/allocate/format";
import { PhaseBadge } from "@/app/(app)/emergencies/badges";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EscalatingRow, FulfilmentRow, GapData, GapRow, GapStatus, UnmetRow } from "@/lib/analytics-types";
import { useApi } from "@/lib/client";
import type { EmergencyRow } from "@/lib/emergency-types";
import { EscalatingChart, FulfilmentChart, GapChart, UnmetChart } from "./analytics-charts";
import { Loaded } from "./loaded";
import { UnmetTable } from "./unmet-table";

// /analytics (docs/HANDOFF.md P2.5): a chart and a table per question. Tabs only
// mount when opened and each fetches its own data, so a MongoDB outage shows up
// in the Gap tab alone.

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function UnmetTab() {
  const query = useApi<UnmetRow[]>("/api/analytics/unmet");
  return (
    <Loaded query={query}>
      {(rows) => (
        <>
          <ChartCard title="Biggest shortfalls" description="Share of each request still unmet, in emergencies that can still be allocated to">
            <UnmetChart rows={rows} />
          </ChartCard>
          <UnmetTable rows={rows} />
        </>
      )}
    </Loaded>
  );
}

const rate = (value: number | null) => (value === null ? "—" : `${value}%`);

const fulfilmentCol = dataTableColumns<FulfilmentRow>();
const fulfilmentColumns = fulfilmentCol.columns([
  fulfilmentCol.accessor("emergency_name", {
    header: ({ column }) => <SortableHeader column={column} title="Emergency" />,
    cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
  }),
  fulfilmentCol.accessor("emergency_status", {
    header: "Status",
    cell: ({ getValue }) => <PhaseBadge value={getValue()} />,
  }),
  fulfilmentCol.accessor("items_total", { header: ({ column }) => <SortableHeader column={column} title="Items" /> }),
  fulfilmentCol.accessor("items_fulfilled", { header: ({ column }) => <SortableHeader column={column} title="Fulfilled" /> }),
  fulfilmentCol.accessor("items_partial", { header: ({ column }) => <SortableHeader column={column} title="Partial" /> }),
  fulfilmentCol.accessor("items_pending", { header: ({ column }) => <SortableHeader column={column} title="Pending" /> }),
  fulfilmentCol.accessor("item_rate_pct", {
    header: ({ column }) => <SortableHeader column={column} title="Items fulfilled" />,
    cell: ({ getValue }) => rate(getValue()),
  }),
  fulfilmentCol.accessor("quantity_rate_pct", {
    header: ({ column }) => <SortableHeader column={column} title="Average share served" />,
    cell: ({ getValue }) => rate(getValue()),
  }),
]);

function FulfilmentTab() {
  const query = useApi<FulfilmentRow[]>("/api/analytics/fulfilment");
  return (
    <Loaded query={query}>
      {(rows) => (
        <>
          <ChartCard title="Fulfilment by emergency" description="Items fully covered, and the average share of each item covered. Cancelled items don't count.">
            <FulfilmentChart rows={rows} />
          </ChartCard>
          <DataTable columns={fulfilmentColumns} data={rows} getRowId={(r) => String(r.emergency_id)} emptyMessage="No emergencies yet." />
        </>
      )}
    </Loaded>
  );
}

const escalatingCol = dataTableColumns<EscalatingRow>();
const escalatingColumns = escalatingCol.columns([
  escalatingCol.accessor("grid_id", {
    header: ({ column }) => <SortableHeader column={column} title="Grid" />,
    cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
  }),
  escalatingCol.accessor("emergency", { header: ({ column }) => <SortableHeader column={column} title="Emergency" /> }),
  escalatingCol.accessor("prev_severity", { header: "Previous", cell: ({ getValue }) => <StatusBadge value={getValue()} /> }),
  escalatingCol.accessor("severity", { header: "Latest", cell: ({ getValue }) => <StatusBadge value={getValue()} /> }),
  escalatingCol.accessor("observed_at", {
    header: ({ column }) => <SortableHeader column={column} title="Observed" />,
    cell: ({ getValue }) => formatIst(getValue()),
  }),
  escalatingCol.accessor("impact_status", { header: "Impact", cell: ({ getValue }) => <PhaseBadge value={getValue()} /> }),
  escalatingCol.accessor("emergency_status", { header: "Emergency status", cell: ({ getValue }) => <PhaseBadge value={getValue()} /> }),
]);

function EscalatingTab() {
  const query = useApi<EscalatingRow[]>("/api/analytics/escalating");
  return (
    <Loaded query={query}>
      {(rows) => (
        <>
          <ChartCard title="Impacts getting worse" description="Latest observation compared with the one before it">
            <EscalatingChart rows={rows} />
          </ChartCard>
          <DataTable columns={escalatingColumns} data={rows} getRowId={(r) => String(r.impact_id)} emptyMessage="No impact got worse at its latest observation." />
        </>
      )}
    </Loaded>
  );
}

const GAP_LABEL: Record<GapStatus, { text: string; tone: Tone }> = {
  OBSERVED_ONLY: { text: "Seen, not requested", tone: "red" },
  BOTH: { text: "Seen and requested", tone: "blue" },
  REQUESTED_ONLY: { text: "Requested, not seen", tone: "grey" },
};

const qty = (value: number | null) => (value === null ? "—" : formatQty(value));

const gapCol = dataTableColumns<GapRow>();
const gapColumns = gapCol.columns([
  gapCol.accessor("item", {
    header: ({ column }) => <SortableHeader column={column} title="Need" />,
    cell: ({ getValue, row }) => (
      <span className="flex flex-wrap items-center gap-2 font-medium">
        {getValue()}
        {!row.original.in_catalogue && <ToneBadge tone="grey">Not in catalogue</ToneBadge>}
        {row.original.unit_differs && <ToneBadge tone="amber">Different unit</ToneBadge>}
      </span>
    ),
  }),
  gapCol.accessor("unit", { header: "Unit", cell: ({ getValue }) => getValue() ?? "—" }),
  gapCol.accessor("status", {
    header: "Status",
    cell: ({ getValue }) => <ToneBadge tone={GAP_LABEL[getValue()].tone}>{GAP_LABEL[getValue()].text}</ToneBadge>,
  }),
  gapCol.accessor("mentions", { header: ({ column }) => <SortableHeader column={column} title="Mentions" /> }),
  gapCol.accessor("observed_quantity", {
    header: ({ column }) => <SortableHeader column={column} title="Reported" />,
    cell: ({ getValue }) => qty(getValue()),
  }),
  gapCol.accessor("quantity_requested", {
    header: ({ column }) => <SortableHeader column={column} title="Requested" />,
    cell: ({ getValue }) => qty(getValue()),
  }),
  gapCol.accessor("quantity_allocated", {
    header: ({ column }) => <SortableHeader column={column} title="Allocated" />,
    cell: ({ getValue }) => qty(getValue()),
  }),
  gapCol.accessor("quantity_unmet", {
    header: ({ column }) => <SortableHeader column={column} title="Unmet" />,
    cell: ({ getValue }) => qty(getValue()),
  }),
]);

/** The first ACTIVE emergency by name, or failing that the first by name. */
function defaultEmergency(list: EmergencyRow[]): EmergencyRow | undefined {
  const byName = [...list].sort((a, b) => a.name.localeCompare(b.name));
  return byName.find((e) => e.status === "ACTIVE") ?? byName[0];
}

function GapResult({ emergencyId }: { emergencyId: number }) {
  const query = useApi<GapData>(`/api/analytics/gap?emergency=${emergencyId}`);
  return (
    <Loaded query={query}>
      {({ rows, counts }) => (
        <>
          <ChartCard
            title="Needs seen in field reports"
            description={`${counts.OBSERVED_ONLY} seen but not requested, ${counts.BOTH} seen and requested, ${counts.REQUESTED_ONLY} requested but not seen`}
          >
            <GapChart rows={rows} />
          </ChartCard>
          <DataTable columns={gapColumns} data={rows} getRowId={(r) => r.key} emptyMessage="No field reports or requests for this emergency yet." />
          <p className="text-muted-foreground">
            Reported adds up every report&apos;s estimate, so a need seen repeatedly counts repeatedly. Compare it with Requested as a signal, not a shortfall.
          </p>
        </>
      )}
    </Loaded>
  );
}

function GapTab() {
  const emergencies = useApi<EmergencyRow[]>("/api/emergencies");
  const [picked, setPicked] = useState<number | null>(null);

  return (
    <Loaded query={emergencies}>
      {(list) => {
        const selected = picked ?? defaultEmergency(list)?.emergency_id;
        if (selected === undefined) return <p className="text-muted-foreground">No emergencies yet.</p>;
        return (
          <>
            <Select value={String(selected)} onValueChange={(v) => setPicked(Number(v))}>
              <SelectTrigger aria-label="Emergency" className="w-72 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.map((e) => (
                  <SelectItem key={e.emergency_id} value={String(e.emergency_id)}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <GapResult key={selected} emergencyId={selected} />
          </>
        );
      }}
    </Loaded>
  );
}

export function AnalyticsView() {
  return (
    <Tabs defaultValue="unmet">
      <TabsList className="max-w-full overflow-x-auto">
        <TabsTrigger value="unmet">Unmet demand</TabsTrigger>
        <TabsTrigger value="fulfilment">Fulfilment</TabsTrigger>
        <TabsTrigger value="escalating">Escalating impacts</TabsTrigger>
        <TabsTrigger value="gap">Field vs request gap</TabsTrigger>
      </TabsList>
      <TabsContent value="unmet">
        <UnmetTab />
      </TabsContent>
      <TabsContent value="fulfilment">
        <FulfilmentTab />
      </TabsContent>
      <TabsContent value="escalating">
        <EscalatingTab />
      </TabsContent>
      <TabsContent value="gap">
        <GapTab />
      </TabsContent>
    </Tabs>
  );
}
