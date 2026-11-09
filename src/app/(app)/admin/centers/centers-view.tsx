"use client";

import { Pencil, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { InlineError } from "@/app/(app)/allocate/bits";
import { ChoiceSelect } from "@/app/(app)/emergencies/emergency-dialog";
import { humanize } from "@/app/(app)/emergencies/format";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import { FormField } from "@/components/form-field";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminCenterRow, AdminLocationRow } from "@/lib/admin-types";
import { api, useApi } from "@/lib/client";
import { CENTER_STATUSES, CENTER_TYPES, type CenterStatus } from "@/lib/enums";
import type { UpdateCenterInput } from "@/lib/validators/admin";
import { ConfirmAction } from "../confirm-action";
import { FormDialog } from "../form-dialog";

// /admin/centers: resource centers. A center keeps its location once created.
// Closing asks first; a closed center can be reopened from the same control.

function StatusCell({ center, onDone }: { center: AdminCenterRow; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function change(status: CenterStatus) {
    setPending(true);
    try {
      await api(`/api/admin/centers/${center.center_id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast.success(`${center.name} is now ${humanize(status).toLowerCase()}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change the status");
    } finally {
      setPending(false);
      setConfirming(false);
      onDone();
    }
  }

  return (
    <>
      <Select
        value={center.status}
        disabled={pending}
        onValueChange={(v) => {
          if (v === "CLOSED") setConfirming(true);
          else void change(v as CenterStatus);
        }}
      >
        <SelectTrigger size="sm" aria-label={`Status of ${center.name}`} className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CENTER_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {humanize(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <AlertDialog open={confirming} onOpenChange={(next) => !pending && setConfirming(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {center.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its stock stays, but it stops being suggested and can&apos;t be allocated from or receive new batches. Allocations already made
              can still be dispatched and delivered, and stock can still be adjusted. You can reopen it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep it open</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                void change("CLOSED");
              }}
            >
              {pending ? "Closing…" : "Close center"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const col = dataTableColumns<AdminCenterRow>();

function columns(onDone: () => void) {
  return col.columns([
    col.accessor("name", {
      header: ({ column }) => <SortableHeader column={column} title="Name" />,
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    col.accessor("center_type", {
      header: ({ column }) => <SortableHeader column={column} title="Type" />,
      cell: ({ getValue }) => humanize(getValue()),
    }),
    col.accessor("status", { header: "Status", cell: ({ row }) => <StatusCell center={row.original} onDone={onDone} /> }),
    col.accessor("grid_id", { header: ({ column }) => <SortableHeader column={column} title="Location" /> }),
    col.accessor("batch_count", { header: ({ column }) => <SortableHeader column={column} title="Batches" /> }),
    col.accessor("user_count", { header: ({ column }) => <SortableHeader column={column} title="Managers" /> }),
    col.display({
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const center = row.original;
        return (
          <div className="flex justify-end gap-2">
            <FormDialog
              trigger={
                <Button variant="outline" size="sm">
                  <Pencil />
                  Edit
                </Button>
              }
              title={`Edit ${center.name}`}
              savedMessage="Center updated"
              onDone={onDone}
              submit={async (read) => {
                const name = read("name").trim();
                const center_type = read("center_type") as UpdateCenterInput["center_type"];
                const body: UpdateCenterInput = {
                  ...(name !== center.name && { name }),
                  ...(center_type !== center.center_type && { center_type }),
                };
                if (Object.keys(body).length === 0) return false;
                await api(`/api/admin/centers/${center.center_id}`, { method: "PATCH", body: JSON.stringify(body) });
              }}
            >
              {(fields) => (
                <>
                  <FormField htmlFor="name" label="Name" error={fields.name}>
                    <Input id="name" name="name" defaultValue={center.name} aria-invalid={!!fields.name} autoFocus />
                  </FormField>
                  <FormField htmlFor="center_type" label="Type" error={fields.center_type}>
                    <ChoiceSelect id="center_type" name="center_type" defaultValue={center.center_type} options={CENTER_TYPES} invalid={!!fields.center_type} />
                  </FormField>
                </>
              )}
            </FormDialog>
            <ConfirmAction
              label="Delete"
              title={`Delete ${center.name}?`}
              description="A center with stock or an assigned manager can't be deleted."
              actionLabel="Delete"
              doneMessage="Center deleted"
              run={() => api(`/api/admin/centers/${center.center_id}`, { method: "DELETE" })}
              onDone={onDone}
            />
          </div>
        );
      },
    }),
  ]);
}

export function CentersView() {
  const list = useApi<AdminCenterRow[]>("/api/admin/centers");
  const locations = useApi<AdminLocationRow[]>("/api/admin/locations");
  const refresh = list.mutate;
  const cols = useMemo(() => columns(() => void refresh()), [refresh]);

  if (list.error && !list.data) return <InlineError error={list.error} onRetry={() => void refresh()} />;
  if (locations.error && !locations.data) return <InlineError error={locations.error} onRetry={() => void locations.mutate()} />;
  if (!list.data || !locations.data) return <Skeleton className="h-72 w-full" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <FormDialog
          trigger={
            <Button size="sm">
              <Plus />
              New center
            </Button>
          }
          title="New center"
          description="Its location can't change after this. Add a new location first if it isn't listed."
          savedMessage="Center created"
          onDone={() => void refresh()}
          submit={async (read) => {
            const location = read("location_id");
            await api("/api/admin/centers", {
              method: "POST",
              body: JSON.stringify({
                name: read("name"),
                center_type: read("center_type"),
                status: read("status"),
                location_id: location ? Number(location) : undefined,
              }),
            });
          }}
        >
          {(fields) => (
            <>
              <FormField htmlFor="name" label="Name" error={fields.name}>
                <Input id="name" name="name" aria-invalid={!!fields.name} autoFocus />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField htmlFor="center_type" label="Type" error={fields.center_type}>
                  <ChoiceSelect id="center_type" name="center_type" defaultValue="DEPOT" options={CENTER_TYPES} invalid={!!fields.center_type} />
                </FormField>
                <FormField htmlFor="status" label="Status" error={fields.status}>
                  <ChoiceSelect id="status" name="status" defaultValue="OPERATIONAL" options={CENTER_STATUSES} invalid={!!fields.status} />
                </FormField>
              </div>
              <FormField htmlFor="location_id" label="Location" error={fields.location_id}>
                <Select name="location_id">
                  <SelectTrigger id="location_id" aria-invalid={!!fields.location_id} className="w-full">
                    <SelectValue placeholder="Choose a location" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.data?.map((l) => (
                      <SelectItem key={l.location_id} value={String(l.location_id)}>
                        {l.grid_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </>
          )}
        </FormDialog>
      </div>
      <DataTable
        columns={cols}
        data={list.data}
        getRowId={(r) => String(r.center_id)}
        filters={[{ column: "name", placeholder: "Filter by name…" }]}
        emptyMessage="No centers yet."
      />
    </div>
  );
}
