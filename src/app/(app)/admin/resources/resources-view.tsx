"use client";

import { Pencil, Plus } from "lucide-react";
import { useMemo } from "react";
import { InlineError } from "@/app/(app)/allocate/bits";
import { ChoiceSelect } from "@/app/(app)/emergencies/emergency-dialog";
import { humanize } from "@/app/(app)/emergencies/format";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminResourceRow } from "@/lib/admin-types";
import type { FieldErrors } from "@/lib/api-contract";
import { api, useApi } from "@/lib/client";
import { RESOURCE_CATEGORIES } from "@/lib/enums";
import type { UpdateResourceInput } from "@/lib/validators/admin";
import { ConfirmAction } from "../confirm-action";
import { FormDialog, type ReadField } from "../form-dialog";

// /admin/resources: the catalogue. A used resource keeps its name and unit,
// because requests and field reports match on them. The API enforces that; here
// the inputs are only disabled.

const used = (r: AdminResourceRow) => r.stock_count + r.item_count > 0;

function ResourceFields({ fields, resource, units }: { fields: FieldErrors; resource?: AdminResourceRow; units: string[] }) {
  const locked = resource !== undefined && used(resource);
  return (
    <>
      <FormField htmlFor="name" label="Name" error={fields.name}>
        <Input id="name" name="name" defaultValue={resource?.name} disabled={locked} aria-invalid={!!fields.name} autoFocus />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField htmlFor="category" label="Category" error={fields.category}>
          <ChoiceSelect id="category" name="category" defaultValue={resource?.category ?? "OTHER"} options={RESOURCE_CATEGORIES} invalid={!!fields.category} />
        </FormField>
        <FormField htmlFor="unit" label="Unit" error={fields.unit}>
          <Input id="unit" name="unit" list="known-units" defaultValue={resource?.unit} disabled={locked} aria-invalid={!!fields.unit} />
          <datalist id="known-units">
            {units.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </FormField>
      </div>
    </>
  );
}

function changes(resource: AdminResourceRow, read: ReadField): UpdateResourceInput {
  const locked = used(resource);
  const name = read("name").trim();
  const unit = read("unit").trim();
  const category = read("category") as UpdateResourceInput["category"];
  return {
    ...(!locked && name !== resource.name && { name }),
    ...(category !== resource.category && { category }),
    ...(!locked && unit !== resource.unit && { unit }),
  };
}

const col = dataTableColumns<AdminResourceRow>();

function columns(units: string[], onDone: () => void) {
  return col.columns([
    col.accessor("name", {
      header: ({ column }) => <SortableHeader column={column} title="Name" />,
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    col.accessor("category", {
      header: ({ column }) => <SortableHeader column={column} title="Category" />,
      cell: ({ getValue }) => humanize(getValue()),
    }),
    col.accessor("unit", { header: "Unit" }),
    col.accessor("stock_count", { header: ({ column }) => <SortableHeader column={column} title="Batches" /> }),
    col.accessor("item_count", { header: ({ column }) => <SortableHeader column={column} title="Request items" /> }),
    col.display({
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const resource = row.original;
        return (
          <div className="flex justify-end gap-2">
            <FormDialog
              trigger={
                <Button variant="outline" size="sm">
                  <Pencil />
                  Edit
                </Button>
              }
              title={`Edit ${resource.name}`}
              description={used(resource) ? "It has stock or requests, so its name and unit are locked." : undefined}
              savedMessage="Resource updated"
              onDone={onDone}
              submit={async (read) => {
                const body = changes(resource, read);
                if (Object.keys(body).length === 0) return false;
                await api(`/api/admin/resources/${resource.resource_id}`, { method: "PATCH", body: JSON.stringify(body) });
              }}
            >
              {(fields) => <ResourceFields fields={fields} resource={resource} units={units} />}
            </FormDialog>
            <ConfirmAction
              label="Delete"
              title={`Delete ${resource.name}?`}
              description="A resource with stock or requests can't be deleted."
              actionLabel="Delete"
              doneMessage="Resource deleted"
              run={() => api(`/api/admin/resources/${resource.resource_id}`, { method: "DELETE" })}
              onDone={onDone}
            />
          </div>
        );
      },
    }),
  ]);
}

export function ResourcesView() {
  const list = useApi<AdminResourceRow[]>("/api/admin/resources");
  const refresh = list.mutate;
  // Keyed on the text, so a refetch with the same units keeps the columns, and any open edit dialog with them.
  const unitKey = [...new Set((list.data ?? []).map((r) => r.unit))].sort().join("\n");
  const units = useMemo(() => (unitKey ? unitKey.split("\n") : []), [unitKey]);
  const cols = useMemo(() => columns(units, () => void refresh()), [units, refresh]);

  if (list.error && !list.data) return <InlineError error={list.error} onRetry={() => void refresh()} />;
  if (!list.data) return <Skeleton className="h-72 w-full" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <FormDialog
          trigger={
            <Button size="sm">
              <Plus />
              New resource
            </Button>
          }
          title="New resource"
          savedMessage="Resource created"
          onDone={() => void refresh()}
          submit={async (read) => {
            await api("/api/admin/resources", {
              method: "POST",
              body: JSON.stringify({ name: read("name"), category: read("category"), unit: read("unit") }),
            });
          }}
        >
          {(fields) => <ResourceFields fields={fields} units={units} />}
        </FormDialog>
      </div>
      <DataTable
        columns={cols}
        data={list.data}
        getRowId={(r) => String(r.resource_id)}
        filters={[{ column: "name", placeholder: "Filter by name…" }]}
        emptyMessage="No resources yet."
      />
    </div>
  );
}
