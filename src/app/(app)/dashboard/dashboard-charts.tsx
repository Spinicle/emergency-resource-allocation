"use client";

import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis } from "recharts";
import { formatIst, formatQty } from "@/app/(app)/allocate/format";
import { humanize } from "@/app/(app)/emergencies/format";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { ReportDayBucket, TopNeed } from "@/lib/dashboard-types";
import { EMERGENCY_TYPES, type EmergencyType } from "@/lib/enums";

// Colours are the --chart-N tokens, which swap with the OS theme in globals.css.
// shadcn's `theme` option needs a .dark class this app doesn't have, so it's not used.

/**
 * One colour per type, so a line keeps its colour as types enter and leave the
 * window. There are 5 tokens and 8 types; the last 3 are mid-tones that read on
 * both themes.
 */
const TYPE_COLORS: Record<EmergencyType, string> = {
  FLOOD: "var(--chart-1)",
  LANDSLIDE: "var(--chart-2)",
  EPIDEMIC: "var(--chart-3)",
  FIRE: "var(--chart-4)",
  CYCLONE: "var(--chart-5)",
  EARTHQUAKE: "oklch(0.62 0.17 350)",
  HEATWAVE: "oklch(0.64 0.15 140)",
  OTHER: "oklch(0.6 0.02 260)",
};

/** "2026-11-05" -> "5 Nov". */
const dayLabel = (day: string) => formatIst(day).replace(/ \d{4}$/, "");

function NoData({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-muted-foreground">{children}</p>;
}

/** One line per emergency type reported in the window. */
export function ReportsByDayChart({ buckets }: { buckets: ReportDayBucket[] }) {
  const types = EMERGENCY_TYPES.filter((t) => buckets.some((b) => b.counts[t] !== undefined));
  if (types.length === 0) return <NoData>No field reports in the last 14 days.</NoData>;

  const config: ChartConfig = Object.fromEntries(types.map((t) => [t, { label: humanize(t), color: TYPE_COLORS[t] }]));
  const rows = buckets.map((b) => ({
    label: dayLabel(b.day),
    ...Object.fromEntries(types.map((t) => [t, b.counts[t] ?? 0])),
  }));

  return (
    <ChartContainer config={config} className="aspect-auto h-72 w-full">
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {types.map((t) => (
          <Line key={t} dataKey={t} type="monotone" stroke={`var(--color-${t})`} strokeWidth={2} dot={{ r: 2 }} />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

const needsConfig = { quantity: { label: "Estimated quantity", color: "var(--chart-1)" } } satisfies ChartConfig;

/** Units differ between bars, so each one names its unit and prints its value. */
export function TopNeedsChart({ needs }: { needs: TopNeed[] }) {
  if (needs.length === 0) return <NoData>No needs observed in the last 14 days.</NoData>;
  const rows = needs.map((n) => ({ label: n.unit ? `${n.item} (${n.unit})` : n.item, quantity: n.quantity }));

  return (
    <ChartContainer config={needsConfig} className="aspect-auto h-72 w-full">
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 56, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={150} interval={0} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="quantity" fill="var(--color-quantity)" radius={3}>
          <LabelList dataKey="quantity" position="right" className="fill-foreground" formatter={(v) => formatQty(Number(v))} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
