"use client";

import Link from "next/link";
import { useMemo } from "react";
import { InlineError, StatusBadge } from "@/app/(app)/allocate/bits";
import { formatIst, formatQty } from "@/app/(app)/allocate/format";
import { humanize } from "@/app/(app)/emergencies/format";
import { ActivityTimeline } from "@/components/activity-timeline";
import { centerStatusColor, ErasMap, type MapPoint, severityColor } from "@/components/map";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/lib/client";
import type { DashboardData } from "@/lib/dashboard-types";
import { ReportsByDayChart, TopNeedsChart } from "./dashboard-charts";
import { feedDetail } from "./feed-subject";
import { MapLegend } from "./map-legend";

// /dashboard (P2.4): one request, scoped to the role by the API.

type Kpi = { label: string; value: number | null; hint?: string };

function kpisFor({ role, kpis }: DashboardData): Kpi[] {
  const openLabel =
    role === "FIELD_OFFICER" ? "Your open items" : role === "CENTER_MANAGER" ? "Open items you can supply" : "Open request items";
  const list: Kpi[] = [
    { label: "Active emergencies", value: kpis.active_emergencies },
    { label: openLabel, value: kpis.open_items },
    { label: role === "CENTER_MANAGER" ? "Critical items you can supply" : "Critical items", value: kpis.critical_items, hint: "Still to allocate" },
    { label: "Batches expiring", value: kpis.expiring_batches, hint: "Within 7 days" },
    { label: "Resources out of stock", value: kpis.out_of_stock, hint: "At a center that stocks them" },
  ];
  // A null is a card this role doesn't get.
  return list.filter((k) => k.value !== null);
}

function KpiCards({ data }: { data: DashboardData }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
      {kpisFor(data).map((k) => (
        <Card key={k.label} size="sm">
          <CardHeader>
            <CardDescription>{k.label}</CardDescription>
            <CardTitle className="tabular-nums group-data-[size=sm]/card:text-2xl">{formatQty(k.value ?? 0)}</CardTitle>
            {k.hint && <CardDescription>{k.hint}</CardDescription>}
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function ImpactMap({ data }: { data: DashboardData }) {
  const points = useMemo<MapPoint[]>(
    () => [
      ...data.impacts.map((i) => ({
        id: `impact-${i.impact_id}`,
        lat: i.latitude,
        lng: i.longitude,
        color: severityColor(i.latest_severity),
        label: `${i.grid_id} · ${i.emergency_name} · ${i.latest_severity ? humanize(i.latest_severity) : "No observation"} · ${humanize(i.status)}`,
      })),
      ...data.centers.map((c) => ({
        id: `center-${c.center_id}`,
        lat: c.latitude,
        lng: c.longitude,
        color: centerStatusColor(c.status),
        shape: "square" as const,
        label: `${c.name} · ${humanize(c.status)}`,
      })),
    ],
    [data.impacts, data.centers],
  );
  return (
    <>
      <ErasMap points={points} height="24rem" />
      <MapLegend />
    </>
  );
}

function CountRow({ label, count }: { label: string; count: number }) {
  return (
    <li className="flex justify-between gap-3">
      <span>{label}</span>
      <span className="tabular-nums text-muted-foreground">{formatQty(count)}</span>
    </li>
  );
}

function ReportCounts({ summary }: { summary: DashboardData["summary"] }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="mb-1 font-medium">By type</h3>
        {summary.byType.length === 0 ? (
          <p className="text-muted-foreground">No field reports yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {summary.byType.map((t) => (
              <CountRow key={t.type} label={humanize(t.type)} count={t.count} />
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-1 font-medium">By trend</h3>
        <ul className="flex flex-col gap-1">
          {summary.byTrend.map((t) => (
            <CountRow key={t.trend ?? "none"} label={t.trend ? humanize(t.trend) : "Not reported"} count={t.count} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function LatestReports({ reports }: { reports: DashboardData["summary"]["latest"] }) {
  if (reports.length === 0) return <p className="text-muted-foreground">No field reports yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {reports.map((r) => (
        <li key={r.observation_id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link href={`/reports/${r.observation_id}`} className="font-medium text-primary underline-offset-4 hover:underline">
            {r.grid_id ?? `Report ${r.observation_id}`}
          </Link>
          {r.severity && <StatusBadge value={r.severity} />}
          <span className="text-muted-foreground">
            {r.emergency_name ?? humanize(r.emergency_type)} · {r.reporter} · {formatIst(r.reported_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Panel({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Dashboard({ data }: { data: DashboardData }) {
  const seesReports = data.role !== "CENTER_MANAGER";
  return (
    <>
      <KpiCards data={data} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Impacts and centers" className="min-w-0 lg:col-span-2">
          <ImpactMap data={data} />
        </Panel>
        <Panel title="Field reports" description={`${formatQty(data.summary.total)} in all`}>
          <ReportCounts summary={data.summary} />
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Reports per day" description="Last 14 days, IST" className="min-w-0">
          <ReportsByDayChart buckets={data.reportsByDay} />
        </Panel>
        <Panel title="Top observed needs" description="Last 14 days, by item and unit" className="min-w-0">
          <TopNeedsChart needs={data.topNeeds} />
        </Panel>
      </div>
      <div className={seesReports ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
        {seesReports && (
          <Panel title="Latest field reports">
            <LatestReports reports={data.summary.latest} />
          </Panel>
        )}
        <Panel title="Recent activity">
          <ActivityTimeline entries={data.recentActivity} detail={feedDetail} />
        </Panel>
      </div>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-96 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}

export function DashboardView() {
  const dashboard = useApi<DashboardData>("/api/dashboard");
  return (
    <div className="flex flex-col gap-4">
      {/* A failed refetch keeps the last good data on screen, with the error above it. */}
      {dashboard.error && <InlineError error={dashboard.error} onRetry={() => void dashboard.mutate()} />}
      {dashboard.data ? <Dashboard data={dashboard.data} /> : !dashboard.error && <DashboardSkeleton />}
    </div>
  );
}
