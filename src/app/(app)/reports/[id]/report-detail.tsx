"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { InlineError, StatusBadge } from "@/app/(app)/allocate/bits";
import { formatIst, formatQty } from "@/app/(app)/allocate/format";
import { humanize } from "@/app/(app)/emergencies/format";
import { ErasMap, severityMarker } from "@/components/map";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/lib/client";
import type { ReportDetail } from "@/lib/report-types";
import { isWebUrl } from "@/lib/validators/reports";
import { TrendBadge } from "../report-columns";

// /reports/[id]: the MySQL fields, then the document's sections. Only sections
// the report has are shown, because a report's shape varies by emergency type.

/** One value from a report's free-form details. */
function formatDetail(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return formatQty(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function Facts({ facts }: { facts: readonly [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Report({ report }: { report: ReportDetail }) {
  const details = Object.entries(report.details).filter(([key]) => key !== "trend");
  const casualties = report.casualties ? Object.entries(report.casualties) : [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
            {report.grid_id ?? "Unknown location"}
            {report.severity && <StatusBadge value={report.severity} />}
          </CardTitle>
          <CardDescription>
            {humanize(report.emergency_type)} report · {formatIst(report.reported_at)} · filed by {report.reporter}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Facts
            facts={[
              [
                "Emergency",
                report.emergency_name ? (
                  <Link href={`/emergencies/${report.emergency_id}`} className="underline-offset-4 hover:underline">
                    {report.emergency_name}
                  </Link>
                ) : (
                  "—"
                ),
              ],
              ["Emergency status", report.emergency_status ? humanize(report.emergency_status) : "—"],
              ["Affected", report.affected_percentage === null ? "—" : `${formatQty(report.affected_percentage)} %`],
              ["Trend", <TrendBadge key="trend" trend={report.trend} />],
              ["Observed", formatIst(report.observed_at)],
              ["Coordinates", `${report.latitude}, ${report.longitude}`],
            ]}
          />
          {report.severity === null && (
            <p className="mt-3 text-muted-foreground">This report&apos;s observation record is missing from MySQL.</p>
          )}
        </CardContent>
      </Card>

      <ErasMap
        points={[
          {
            id: "report",
            lat: report.latitude,
            lng: report.longitude,
            ...severityMarker(report.severity),
            label: report.grid_id ?? "Report",
            radius: 11,
          },
        ]}
        height="16rem"
      />

      {details.length > 0 && (
        <Section title="Details">
          <Facts facts={details.map(([key, value]) => [humanize(key), formatDetail(value)])} />
        </Section>
      )}
      {casualties.length > 0 && (
        <Section title="Casualties">
          <Facts facts={casualties.map(([key, value]) => [humanize(key), formatQty(value)])} />
        </Section>
      )}
      {report.needs_observed.length > 0 && (
        <Section title="Needs observed">
          <ul className="flex flex-col gap-1">
            {report.needs_observed.map((need, i) => (
              <li key={i}>
                <span className="font-medium">{need.item}</span>
                {(need.est_qty !== undefined || need.unit) && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {need.est_qty !== undefined && `about ${formatQty(need.est_qty)} `}
                    {need.unit}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {report.infrastructure.length > 0 && (
        <Section title="Infrastructure">
          <ul className="flex flex-col gap-1">
            {report.infrastructure.map((part, i) => (
              <li key={i}>
                <span className="font-medium">{part.kind}</span>
                {part.name && <span> · {part.name}</span>}
                {part.status && <span className="text-muted-foreground"> · {part.status}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {report.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-line">{report.notes}</p>
        </Section>
      )}
      {report.tags.length > 0 && (
        <Section title="Tags">
          <div className="flex flex-wrap gap-1">
            {report.tags.map((tag, i) => (
              <Badge key={i} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        </Section>
      )}
      {report.photos.length > 0 && (
        <Section title="Photos">
          <ul className="flex flex-col gap-1">
            {report.photos.map((photo, i) => (
              <li key={i} className="break-all">
                {/* The API stores any text here, and React doesn't block javascript: links. */}
                {isWebUrl(photo) ? (
                  <a href={photo} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">
                    {photo}
                  </a>
                ) : (
                  photo
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

export function ReportDetailView({ id }: { id: number }) {
  const report = useApi<ReportDetail>(`/api/reports/${id}`);

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <Link href="/reports" className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        All field reports
      </Link>
      {/* A failed refetch keeps the last good data on screen, with the error above it. */}
      {report.error && report.error.status !== 404 && (
        <InlineError error={report.error} onRetry={() => void report.mutate()} />
      )}
      {report.data ? (
        <Report report={report.data} />
      ) : report.error ? (
        report.error.status === 404 && <p className="text-muted-foreground">{report.error.message}.</p>
      ) : (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}
    </div>
  );
}
