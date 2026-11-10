"use client";

import { Pencil, Plus } from "lucide-react";
import { useMemo } from "react";
import { InlineError } from "@/app/(app)/allocate/bits";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { LocationPicker } from "@/components/location-picker";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminLocationRow } from "@/lib/admin-types";
import { api, useApi } from "@/lib/client";
import type { UpdateLocationInput } from "@/lib/validators/admin";
import { ConfirmAction } from "../confirm-action";
import { FormDialog, type ReadField } from "@/components/form-dialog";

// /admin/locations: grid locations. One used by a center or an impact can't
// change, because distances and stored field reports depend on it. The API
// enforces that; here the Edit button just goes away. Add and Edit place the
// location with the shared LocationPicker.

const used = (l: AdminLocationRow) => l.center_count + l.impact_count > 0;

/** A number from a coordinate input; blank becomes NaN, which JSON sends as null and the API refuses. */
const coordinate = (read: ReadField, key: string) => Number(read(key) || NaN);

const col = dataTableColumns<AdminLocationRow>();

function columns(onDone: () => void) {
  return col.columns([
    col.accessor("grid_id", {
      header: ({ column }) => <SortableHeader column={column} title="Grid id" />,
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    col.display({
      id: "coordinates",
      header: "Coordinates",
      cell: ({ row }) => (
        <span className="text-muted-foreground tabular-nums">
          {row.original.latitude}, {row.original.longitude}
        </span>
      ),
    }),
    col.accessor("center_count", { header: ({ column }) => <SortableHeader column={column} title="Centers" /> }),
    col.accessor("impact_count", { header: ({ column }) => <SortableHeader column={column} title="Impacts" /> }),
    col.display({
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const location = row.original;
        return (
          <div className="flex justify-end gap-2">
            {!used(location) && (
              <FormDialog
                trigger={
                  <Button variant="outline" size="sm">
                    <Pencil />
                    Edit
                  </Button>
                }
                title={`Edit ${location.grid_id}`}
                className="sm:max-w-lg"
                savedMessage="Location updated"
                onDone={onDone}
                submit={async (read) => {
                  const grid_id = read("grid_id").trim();
                  const latitude = coordinate(read, "latitude");
                  const longitude = coordinate(read, "longitude");
                  const body: UpdateLocationInput = {
                    ...(grid_id !== location.grid_id && { grid_id }),
                    ...(latitude !== location.latitude && { latitude }),
                    ...(longitude !== location.longitude && { longitude }),
                  };
                  if (Object.keys(body).length === 0) return false;
                  await api(`/api/admin/locations/${location.location_id}`, { method: "PATCH", body: JSON.stringify(body) });
                }}
              >
                {(fields) => <LocationPicker mode="admin" editing={location} errors={fields} />}
              </FormDialog>
            )}
            <ConfirmAction
              label="Delete"
              title={`Delete ${location.grid_id}?`}
              description="A location used by a center or an impact can't be deleted."
              actionLabel="Delete"
              doneMessage="Location deleted"
              run={() => api(`/api/admin/locations/${location.location_id}`, { method: "DELETE" })}
              onDone={onDone}
            />
          </div>
        );
      },
    }),
  ]);
}

export function LocationsView() {
  const list = useApi<AdminLocationRow[]>("/api/admin/locations");
  const refresh = list.mutate;
  const cols = useMemo(() => columns(() => void refresh()), [refresh]);

  if (list.error && !list.data) return <InlineError error={list.error} onRetry={() => void refresh()} />;
  if (!list.data) return <Skeleton className="h-72 w-full" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <FormDialog
          trigger={
            <Button size="sm">
              <Plus />
              New location
            </Button>
          }
          title="New location"
          className="sm:max-w-lg"
          savedMessage="Location created"
          onDone={() => void refresh()}
          submit={async (read) => {
            await api("/api/admin/locations", {
              method: "POST",
              body: JSON.stringify({ grid_id: read("grid_id"), latitude: coordinate(read, "latitude"), longitude: coordinate(read, "longitude") }),
            });
          }}
        >
          {(fields) => <LocationPicker mode="admin" errors={fields} />}
        </FormDialog>
      </div>
      <DataTable
        columns={cols}
        data={list.data}
        getRowId={(r) => String(r.location_id)}
        filters={[{ column: "grid_id", placeholder: "Filter by grid id…" }]}
        emptyMessage="No locations yet."
      />
    </div>
  );
}
