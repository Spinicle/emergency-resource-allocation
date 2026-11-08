"use client";

import { ArrowLeft, Ban } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { InlineError, StatusBadge } from "@/app/(app)/allocate/bits";
import { formatIst, formatQty } from "@/app/(app)/allocate/format";
import { humanize } from "@/app/(app)/emergencies/format";
import { DataTable, dataTableColumns } from "@/components/data-table";
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
import { Skeleton } from "@/components/ui/skeleton";
import { api, useApi } from "@/lib/client";
import type {
  RequestAllocationRow,
  RequestCancelled,
  RequestDetail,
  RequestItemRow,
  TimelineEntry,
} from "@/lib/request-types";

// /requests/[id]: the header with Cancel, then items, allocations and the
// activity_log timeline. Open items link to /allocate for those who can use it.

const OPEN_ITEM_STATUSES: readonly string[] = ["PENDING", "PARTIAL"];

const itemCol = dataTableColumns<RequestItemRow>();

function itemColumns(allocatable: boolean) {
  return itemCol.columns([
    itemCol.accessor("resource_name", {
      header: "Resource",
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    itemCol.accessor("urgency", { header: "Urgency", cell: ({ getValue }) => <StatusBadge value={getValue()} /> }),
    itemCol.accessor("status", { header: "Status", cell: ({ getValue }) => <StatusBadge value={getValue()} /> }),
    itemCol.accessor("quantity_requested", {
      header: "Requested",
      cell: ({ row }) => `${formatQty(row.original.quantity_requested)} ${row.original.unit}`,
    }),
    itemCol.accessor("quantity_allocated", { header: "Allocated", cell: ({ getValue }) => formatQty(getValue()) }),
    itemCol.accessor("quantity_remaining", { header: "Remaining", cell: ({ getValue }) => formatQty(getValue()) }),
    itemCol.display({
      id: "allocate",
      header: "",
      cell: ({ row }) =>
        allocatable && OPEN_ITEM_STATUSES.includes(row.original.status) ? (
          <Link
            href={`/allocate?item=${row.original.request_item_id}`}
            className="underline-offset-4 hover:underline"
          >
            Allocate
          </Link>
        ) : null,
    }),
  ]);
}

const allocationCol = dataTableColumns<RequestAllocationRow>();
const allocationColumns = allocationCol.columns([
  allocationCol.accessor("resource_name", { header: "Resource" }),
  allocationCol.accessor("quantity_allocated", {
    header: "Quantity",
    cell: ({ row }) => `${formatQty(row.original.quantity_allocated)} ${row.original.unit}`,
  }),
  allocationCol.accessor("status", { header: "Status", cell: ({ getValue }) => <StatusBadge value={getValue()} /> }),
  allocationCol.accessor("center_name", { header: "Center" }),
  allocationCol.accessor("batch_code", { header: "Batch" }),
  allocationCol.accessor("expiry_date", { header: "Expires", cell: ({ getValue }) => formatIst(getValue()) }),
  allocationCol.accessor("allocated_by", { header: "Allocated by" }),
  allocationCol.accessor("allocated_at", { header: "Allocated", cell: ({ getValue }) => formatIst(getValue()) }),
]);

/** What an allocation entry moved, from its payload (HANDOFF 4.4's shapes); nothing for a request entry. */
function payloadSummary(payload: TimelineEntry["payload"]): string | null {
  if (typeof payload?.resource !== "string") return null;
  const quantity = payload.quantity ?? payload.change_qty;
  return [
    typeof quantity === "number" ? `${formatQty(quantity)} ${payload.resource}` : payload.resource,
    typeof payload.batch_code === "string" ? payload.batch_code : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return <p className="text-muted-foreground">No activity recorded yet.</p>;
  return (
    <ol className="flex flex-col gap-2">
      {entries.map((e, index) => {
        const summary = payloadSummary(e.payload);
        return (
          <li key={`${e.ts}-${e.action}-${e.entity_id}-${index}`}>
            <span className="font-medium">{humanize(e.action)}</span>
            {summary && <span> · {summary}</span>}
            <span className="text-muted-foreground">
              {" "}
              · {e.actor_name} · {formatIst(e.ts)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CancelRequest({ requestId, onDone }: { requestId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function cancel() {
    setBusy(true);
    try {
      await api<RequestCancelled>(`/api/requests/${requestId}/cancel`, { method: "POST" });
      toast.success("Request cancelled");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't cancel the request");
    } finally {
      setBusy(false);
      onDone(); // refetch after success or a 409 alike: whatever blocked it should now show
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Ban />
        Cancel request
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel request #{requestId}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its items leave the allocation queue. A cancelled request can&apos;t be reopened.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep request</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(e) => {
              e.preventDefault(); // stay open until the cancel has finished
              void cancel();
            }}
          >
            {busy ? "Cancelling…" : "Cancel request"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RequestDetailView({ id, canAllocate }: { id: number; canAllocate: boolean }) {
  const detail = useApi<RequestDetail>(`/api/requests/${id}`);
  const data = detail.data;
  const closed = data?.request.emergency_status === "CLOSED";
  // A CLOSED emergency's items aren't in the queue, so /allocate couldn't serve them.
  const allocatable = canAllocate && data !== undefined && !closed && data.request.status !== "CANCELLED";

  // DataTable wants stable columns: rebuilt only when the link's visibility changes.
  const itemCols = useMemo(() => itemColumns(allocatable), [allocatable]);

  const back = (
    <Link href="/requests" className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" />
      All requests
    </Link>
  );

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        {detail.error ? (
          // A missing or someone else's request isn't worth retrying.
          detail.error.status === 404 || detail.error.status === 403 ? (
            <p className="text-muted-foreground">{detail.error.message}.</p>
          ) : (
            <InlineError error={detail.error} onRetry={() => void detail.mutate()} />
          )
        ) : (
          <div className="flex flex-col gap-2" aria-busy>
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}
      </div>
    );
  }

  const { request, items, allocations, timeline } = data;
  // Mirrors the API so the button appears only when it can work. The API still
  // decides: someone may allocate after this page loaded.
  const canCancel =
    request.status !== "CANCELLED" && !closed && items.length > 0 && items.every((i) => i.quantity_allocated === 0);

  return (
    <div className="flex flex-col gap-4">
      {back}
      {/* A failed refetch keeps the last good data on screen, with the error above it. */}
      {detail.error && <InlineError error={detail.error} onRetry={() => void detail.mutate()} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
            Request #{request.request_id}
            <StatusBadge value={request.status} />
          </CardTitle>
          <CardDescription>
            <Link href={`/emergencies/${request.emergency_id}`} className="underline-offset-4 hover:underline">
              {request.emergency_name}
            </Link>{" "}
            · {request.grid_id} · by {request.requested_by}
          </CardDescription>
          {canCancel && (
            <CardAction>
              <CancelRequest requestId={request.request_id} onDone={() => void detail.mutate()} />
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-muted-foreground">
            Requested {formatIst(request.requested_at)}
            {request.required_by && ` · needed by ${formatIst(request.required_by)}`}
          </p>
          {request.description && <p className="whitespace-pre-line">{request.description}</p>}
        </CardContent>
      </Card>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Items</h3>
        <DataTable columns={itemCols} data={items} pageSize={50} getRowId={(r) => String(r.request_item_id)} />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Allocations</h3>
        <DataTable
          columns={allocationColumns}
          data={allocations}
          pageSize={50}
          getRowId={(r) => String(r.allocation_id)}
          emptyMessage="Nothing allocated yet."
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline entries={timeline} />
        </CardContent>
      </Card>
    </div>
  );
}
