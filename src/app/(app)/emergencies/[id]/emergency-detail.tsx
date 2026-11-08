"use client";

import { ArrowLeft, Construction, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { InlineError, StatusBadge } from "@/app/(app)/allocate/bits";
import { formatIst, formatQty } from "@/app/(app)/allocate/format";
import { emergencyReportColumns } from "@/app/(app)/reports/report-columns";
import { emergencyRequestColumns } from "@/app/(app)/requests/request-columns";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useApi } from "@/lib/client";
import type { EmergencyDetail, ImpactRow, ImpactUpdated, ObservationRow } from "@/lib/emergency-types";
import { IMPACT_STATUSES } from "@/lib/enums";
import type { ReportList } from "@/lib/report-types";
import type { RequestRow } from "@/lib/request-types";
import { PhaseBadge } from "../badges";
import { EmergencyDialog } from "../emergency-dialog";
import { humanize } from "../format";
import { AddImpactDialog } from "./add-impact-dialog";

// /emergencies/[id]: header with edit and close, then tabs. Impacts, the
// observations timeline, field reports and requests are live; unmet demand
// arrives with P2.5.

/** One impact's status: a Select for writers (PATCH /api/impacts/[id]), a badge otherwise. */
function ImpactStatusCell({ impact, editable, onChanged }: { impact: ImpactRow; editable: boolean; onChanged: () => void }) {
  const [pending, setPending] = useState(false);
  if (!editable) return <PhaseBadge value={impact.status} />;

  async function change(status: string) {
    setPending(true);
    try {
      const updated = await api<ImpactUpdated>(`/api/impacts/${impact.impact_id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      toast.success(`${impact.grid_id} is now ${humanize(updated.status).toLowerCase()}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change the status");
    } finally {
      setPending(false);
      onChanged(); // refetch after success or a 409 alike
    }
  }

  return (
    <Select value={impact.status} onValueChange={(v) => void change(v)} disabled={pending}>
      <SelectTrigger size="sm" aria-label={`Status of ${impact.grid_id}`} className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {IMPACT_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {humanize(s)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const impactCol = dataTableColumns<ImpactRow>();

function impactColumns(editable: boolean, onChanged: () => void) {
  return impactCol.columns([
    impactCol.accessor("grid_id", {
      header: ({ column }) => <SortableHeader column={column} title="Grid" />,
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    impactCol.display({
      id: "coordinates",
      header: "Coordinates",
      cell: ({ row }) => (
        <span className="text-muted-foreground tabular-nums">
          {row.original.latitude}, {row.original.longitude}
        </span>
      ),
    }),
    impactCol.accessor("status", {
      header: ({ column }) => <SortableHeader column={column} title="Status" />,
      cell: ({ row }) => <ImpactStatusCell impact={row.original} editable={editable} onChanged={onChanged} />,
    }),
    impactCol.accessor("latest_severity", {
      header: "Latest severity",
      cell: ({ getValue }) => {
        const v = getValue();
        return v ? <StatusBadge value={v} /> : <span className="text-muted-foreground">No observation yet</span>;
      },
    }),
    impactCol.accessor("latest_affected_pct", {
      header: ({ column }) => <SortableHeader column={column} title="Affected" />,
      cell: ({ getValue }) => {
        const v = getValue();
        return v === null ? "—" : `${formatQty(v)} %`;
      },
    }),
    impactCol.accessor("latest_observed_at", {
      header: ({ column }) => <SortableHeader column={column} title="Last observed" />,
      cell: ({ getValue }) => formatIst(getValue()),
    }),
    impactCol.accessor("request_count", { header: ({ column }) => <SortableHeader column={column} title="Requests" /> }),
  ]);
}

const obsCol = dataTableColumns<ObservationRow>();
const observationColumns = obsCol.columns([
  obsCol.accessor("observed_at", {
    header: ({ column }) => <SortableHeader column={column} title="Observed" />,
    cell: ({ getValue }) => formatIst(getValue()),
  }),
  obsCol.accessor("grid_id", { header: ({ column }) => <SortableHeader column={column} title="Grid" /> }),
  obsCol.accessor("severity", { header: "Severity", cell: ({ getValue }) => <StatusBadge value={getValue()} /> }),
  obsCol.accessor("affected_percentage", {
    header: ({ column }) => <SortableHeader column={column} title="Affected" />,
    cell: ({ getValue }) => `${formatQty(getValue())} %`,
  }),
  obsCol.accessor("observed_by", { header: "Observed by" }),
]);

function Placeholder({ task, children }: { task: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 text-muted-foreground">
        <p className="flex items-center gap-2">
          <Construction className="size-4" />
          Arrives with {task}.
        </p>
        {children}
      </CardContent>
    </Card>
  );
}

/** The Requests tab. The API limits a Field Officer to their own, like the counts above. */
function EmergencyRequests({ emergencyId, canEdit }: { emergencyId: number; canEdit: boolean }) {
  const router = useRouter();
  const list = useApi<RequestRow[]>(`/api/requests?emergency=${emergencyId}`);

  if (list.error && !list.data) return <InlineError error={list.error} onRetry={() => void list.mutate()} />;
  if (!list.data) return <Skeleton className="h-48 w-full" />;
  return (
    <DataTable
      columns={emergencyRequestColumns}
      data={list.data}
      getRowId={(r) => String(r.request_id)}
      onRowClick={(r) => router.push(`/requests/${r.request_id}`)}
      emptyMessage={canEdit ? "No requests for this emergency yet." : "You have no requests for this emergency."}
    />
  );
}

/** The Field reports tab: every report on this emergency, newest first. */
function EmergencyReports({ emergencyId }: { emergencyId: number }) {
  const router = useRouter();
  const list = useApi<ReportList>(`/api/reports?emergency=${emergencyId}`);

  if (list.error && !list.data) return <InlineError error={list.error} onRetry={() => void list.mutate()} />;
  if (!list.data) return <Skeleton className="h-48 w-full" />;
  return (
    <>
      <DataTable
        columns={emergencyReportColumns}
        data={list.data.reports}
        getRowId={(r) => String(r.observation_id)}
        onRowClick={(r) => router.push(`/reports/${r.observation_id}`)}
        emptyMessage="No field reports for this emergency yet."
      />
      {list.data.capped && (
        <p className="mt-2 text-muted-foreground">
          Showing the latest {list.data.reports.length} of {list.data.total} reports.
        </p>
      )}
    </>
  );
}

function CloseEmergency({ detail, onClosed }: { detail: EmergencyDetail; onClosed: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { emergency, counts } = detail;

  async function close() {
    setBusy(true);
    try {
      await api(`/api/emergencies/${emergency.emergency_id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "CLOSED" }),
      });
      toast.success(`${emergency.name} is closed`);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't close the emergency");
    } finally {
      setBusy(false);
      onClosed();
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Lock />
        Close
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close this emergency?</AlertDialogTitle>
          <AlertDialogDescription>
            Its end time is set to now, and a closed emergency can&apos;t be edited or reopened, takes no new impacts
            or field reports, and can&apos;t be allocated to.{" "}
            {counts.open_items > 0
              ? `${counts.open_items} open request item${counts.open_items === 1 ? "" : "s"} will leave the allocation queue.`
              : "No open request items are waiting on it."}{" "}
            Existing allocations can still be dispatched and delivered.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it open</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(e) => {
              e.preventDefault(); // stay open until the close has finished
              void close();
            }}
          >
            {busy ? "Closing…" : "Close emergency"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function EmergencyDetailView({ id, canEdit }: { id: number; canEdit: boolean }) {
  const detail = useApi<EmergencyDetail>(`/api/emergencies/${id}`);
  const refresh = detail.mutate;
  const data = detail.data;
  const editable = canEdit && data !== undefined && data.emergency.status !== "CLOSED";

  // DataTable wants stable columns: rebuilt only when editability changes.
  const impactCols = useMemo(() => impactColumns(editable, () => void refresh()), [editable, refresh]);

  const back = (
    <Link href="/emergencies" className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" />
      All emergencies
    </Link>
  );

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        {detail.error ? (
          // An unknown id isn't worth retrying.
          detail.error.status === 404 ? (
            <p className="text-muted-foreground">{detail.error.message}.</p>
          ) : (
            <InlineError error={detail.error} onRetry={() => void refresh()} />
          )
        ) : (
          <div className="flex flex-col gap-2" aria-busy>
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}
      </div>
    );
  }

  const { emergency, impacts, observations, counts } = data;
  return (
    <div className="flex flex-col gap-4">
      {back}
      {/* A failed refetch keeps the last good data on screen, with the error above it. */}
      {detail.error && <InlineError error={detail.error} onRetry={() => void refresh()} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
            {emergency.name}
            <PhaseBadge value={emergency.status} />
          </CardTitle>
          <CardDescription>
            {humanize(emergency.type)} · started {formatIst(emergency.start_time)}
            {emergency.end_time && ` · ended ${formatIst(emergency.end_time)}`}
          </CardDescription>
          {editable && (
            <CardAction className="flex gap-2">
              <EmergencyDialog emergency={emergency} onSaved={() => void refresh()} />
              <CloseEmergency detail={data} onClosed={() => void refresh()} />
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {emergency.description && <p className="whitespace-pre-line">{emergency.description}</p>}
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
            <div>
              <dt className="inline">Impacts: </dt>
              <dd className="inline font-medium text-foreground">{impacts.length}</dd>
            </div>
            <div>
              <dt className="inline">Observations: </dt>
              <dd className="inline font-medium text-foreground">{counts.observations}</dd>
            </div>
            <div>
              <dt className="inline">{canEdit ? "Requests: " : "Your requests: "}</dt>
              <dd className="inline font-medium text-foreground">{counts.requests}</dd>
            </div>
            <div>
              <dt className="inline">Field reports: </dt>
              <dd className="inline font-medium text-foreground">{counts.reports}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Tabs defaultValue="impacts">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="impacts">Impacts</TabsTrigger>
          <TabsTrigger value="observations">Observations timeline</TabsTrigger>
          <TabsTrigger value="reports">Field reports</TabsTrigger>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="unmet">Unmet demand</TabsTrigger>
        </TabsList>

        <TabsContent value="impacts" className="flex flex-col gap-3">
          {editable && (
            <div className="flex justify-end">
              <AddImpactDialog emergencyId={emergency.emergency_id} onAdded={() => void refresh()} />
            </div>
          )}
          <DataTable
            columns={impactCols}
            data={impacts}
            getRowId={(r) => String(r.impact_id)}
            emptyMessage={editable ? "No impacted locations yet. Add the first one." : "No impacted locations yet."}
          />
        </TabsContent>

        <TabsContent value="observations">
          <DataTable
            columns={observationColumns}
            data={observations}
            getRowId={(r) => String(r.observation_id)}
            emptyMessage="No observations yet. Field officers file them as field reports."
          />
          {counts.observations > observations.length && (
            <p className="mt-2 text-muted-foreground">
              Showing the latest {observations.length} of {counts.observations} observations.
            </p>
          )}
        </TabsContent>

        <TabsContent value="reports">
          <EmergencyReports emergencyId={emergency.emergency_id} />
        </TabsContent>

        <TabsContent value="requests">
          <EmergencyRequests emergencyId={emergency.emergency_id} canEdit={canEdit} />
        </TabsContent>

        <TabsContent value="unmet">
          <Placeholder task="P2.5">
            <p>Requested vs allocated per resource for this emergency.</p>
          </Placeholder>
        </TabsContent>
      </Tabs>
    </div>
  );
}

