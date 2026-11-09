"use client";

import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import { formatQty } from "@/app/(app)/allocate/format";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { EscalatingRow, FulfilmentRow, GapRow, UnmetRow } from "@/lib/analytics-types";
import { SEVERITIES } from "@/lib/enums";

// Colours are the --chart-N tokens, which swap with the OS theme in globals.css.
// Every two-series chart uses tokens 1 and 4, the pair that stays furthest apart
// for colour-blind readers in both themes. Bars are horizontal because the
// category labels are long.

const TOP_UNMET = 10;
const TOP_GAP = 15;
/** Space per category row, and for the axis or legend around them. */
const ROW_PX = 30;
const CHROME_PX = 48;

const BAR_RADIUS: [number, number, number, number] = [0, 4, 4, 0];
const PERCENT_DOMAIN: [number, number] = [0, 100];

const height = (rows: number) => ({ height: Math.max(rows, 2) * ROW_PX + CHROME_PX });

function NoData({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-muted-foreground">{children}</p>;
}

const unmetConfig = { share: { label: "Share unmet (%)", color: "var(--chart-1)" } } satisfies ChartConfig;

/**
 * The biggest shortfalls an allocation could still fix: a CLOSED emergency can't
 * be allocated to. Bar length is a share, because a raw quantity would compare
 * litres with kits; each bar prints what's actually missing.
 */
export function UnmetChart({ rows }: { rows: UnmetRow[] }) {
  const top = rows
    .filter((r) => r.emergency_status !== "CLOSED" && r.quantity_unmet > 0)
    .map((r) => {
      const exactShare = r.quantity_unmet / r.quantity_requested;
      return {
        label: `${r.resource_name}, ${r.emergency_name}`,
        exactShare,
        // Two decimals for the tooltip; a small shortfall must not round away to no bar.
        share: Math.round(exactShare * 10000) / 100,
        missing: `${formatQty(r.quantity_unmet)} ${r.unit}`,
        quantity: r.quantity_unmet,
      };
    })
    .sort((a, b) => b.exactShare - a.exactShare || b.quantity - a.quantity || a.label.localeCompare(b.label))
    .slice(0, TOP_UNMET);
  if (top.length === 0) return <NoData>No open emergency has unmet demand.</NoData>;

  return (
    <ChartContainer config={unmetConfig} className="aspect-auto w-full" style={height(top.length)}>
      <BarChart data={top} layout="vertical" margin={{ top: 0, right: 88, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" domain={PERCENT_DOMAIN} tickLine={false} axisLine={false} unit="%" />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={260} interval={0} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="share" fill="var(--color-share)" radius={BAR_RADIUS}>
          <LabelList dataKey="missing" position="right" className="fill-foreground" />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

const fulfilmentConfig = {
  items: { label: "Items fulfilled (%)", color: "var(--chart-1)" },
  quantity: { label: "Average share served (%)", color: "var(--chart-4)" },
} satisfies ChartConfig;

/** Emergencies with live items; the others have no rate to draw. */
export function FulfilmentChart({ rows }: { rows: FulfilmentRow[] }) {
  const data = rows
    .filter((r) => r.item_rate_pct !== null)
    .map((r) => ({ label: r.emergency_name, items: r.item_rate_pct, quantity: r.quantity_rate_pct }));
  if (data.length === 0) return <NoData>No emergency has requests yet.</NoData>;

  return (
    <ChartContainer config={fulfilmentConfig} className="aspect-auto w-full" style={height(data.length * 2)}>
      <BarChart data={data} layout="vertical" barGap={2} margin={{ top: 0, right: 56, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" domain={PERCENT_DOMAIN} tickLine={false} axisLine={false} unit="%" />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={170} interval={0} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="items" fill="var(--color-items)" radius={BAR_RADIUS}>
          <LabelList dataKey="items" position="right" className="fill-foreground" formatter={(v) => `${v}%`} />
        </Bar>
        <Bar dataKey="quantity" fill="var(--color-quantity)" radius={BAR_RADIUS}>
          <LabelList dataKey="quantity" position="right" className="fill-foreground" formatter={(v) => `${v}%`} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

const escalatingConfig = {
  previous: { label: "Previous severity", color: "var(--chart-1)" },
  latest: { label: "Latest severity", color: "var(--chart-4)" },
} satisfies ChartConfig;

const severityName = (rank: unknown) => SEVERITIES[Number(rank) - 1] ?? "";

export function EscalatingChart({ rows }: { rows: EscalatingRow[] }) {
  if (rows.length === 0) return <NoData>No impact got worse at its latest observation.</NoData>;
  // With the emergency: one location can be impacted by more than one.
  const data = rows.map((r) => ({ label: `${r.grid_id}, ${r.emergency}`, previous: r.prev_rank, latest: r.sev_rank }));

  return (
    <ChartContainer config={escalatingConfig} className="aspect-auto w-full" style={height(data.length * 2)}>
      <BarChart data={data} layout="vertical" barGap={2} margin={{ top: 0, right: 80, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} />
        <XAxis
          type="number"
          domain={[0, SEVERITIES.length]}
          ticks={SEVERITIES.map((_, i) => i + 1)}
          tickFormatter={severityName}
          tickLine={false}
          axisLine={false}
        />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={260} interval={0} />
        <ChartTooltip content={<ChartTooltipContent hideIndicator={false} formatter={(value, name) => `${escalatingConfig[name as keyof typeof escalatingConfig]?.label}: ${severityName(value)}`} />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="previous" fill="var(--color-previous)" radius={BAR_RADIUS}>
          <LabelList dataKey="previous" position="right" className="fill-foreground" formatter={severityName} />
        </Bar>
        <Bar dataKey="latest" fill="var(--color-latest)" radius={BAR_RADIUS}>
          <LabelList dataKey="latest" position="right" className="fill-foreground" formatter={severityName} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

const gapConfig = {
  notRequested: { label: "Seen, not requested", color: "var(--chart-4)" },
  requested: { label: "Seen and requested", color: "var(--chart-1)" },
} satisfies ChartConfig;

/**
 * How many need entries name each need; a report listing a need twice counts
 * twice. Entries rather than quantities because they're comparable across units.
 * One series per status, stacked, so the legend follows the status; each row has
 * a value in only one of them.
 */
export function GapChart({ rows }: { rows: GapRow[] }) {
  const top = rows
    .filter((r) => r.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions || a.item.localeCompare(b.item))
    .slice(0, TOP_GAP)
    .map((r) => ({
      label: r.unit ? `${r.item} (${r.unit})` : r.item,
      notRequested: r.status === "OBSERVED_ONLY" ? r.mentions : undefined,
      requested: r.status === "BOTH" ? r.mentions : undefined,
    }));
  if (top.length === 0) return <NoData>No field report for this emergency names a need.</NoData>;

  return (
    <ChartContainer config={gapConfig} className="aspect-auto w-full" style={height(top.length)}>
      <BarChart data={top} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={190} interval={0} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="notRequested" stackId="mentions" fill="var(--color-notRequested)" radius={BAR_RADIUS}>
          <LabelList dataKey="notRequested" position="right" className="fill-foreground" />
        </Bar>
        <Bar dataKey="requested" stackId="mentions" fill="var(--color-requested)" radius={BAR_RADIUS}>
          <LabelList dataKey="requested" position="right" className="fill-foreground" />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
