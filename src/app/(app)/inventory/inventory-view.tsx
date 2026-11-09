"use client";

import { Plus, ScrollText, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { InlineError, StatusBadge, ToneBadge } from "@/app/(app)/allocate/bits";
import { formatIst, formatQty } from "@/app/(app)/allocate/format";
import { FormDialog } from "@/components/form-dialog";
import { ChoiceSelect } from "@/components/choice-select";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AdminCenterRow } from "@/lib/admin-types";
import { api, useApi } from "@/lib/client";
import type { CenterAllocationRow, LedgerRow, ResourceRow, StockRow } from "@/lib/stock-types";
import { ADJUST_REASONS } from "@/lib/validators/stock";

// /inventory: one center's batches and allocations, on Part 1's stock API
// (docs/HANDOFF.md 4.10), which enforces the scope and every rule. Refusals are
// the API's own messages, shown as is.

function ExpiryBadge({ batch }: { batch: StockRow }) {
  const { days_left: days } = batch;
  if (days === null) return <span className="text-muted-foreground">No expiry</span>;
  if (days < 0) return <ToneBadge tone="red">Expired {formatIst(batch.expiry_date)}</ToneBadge>;
  if (days === 0) return <ToneBadge tone="red">Expires today</ToneBadge>;
  if (days <= 7) return <ToneBadge tone="amber">{days} day{days === 1 ? "" : "s"} left</ToneBadge>;
  return <span>{formatIst(batch.expiry_date)}</span>;
}

function AddBatchDialog({ centerId, isAdmin, resources, onDone }: { centerId: number; isAdmin: boolean; resources: ResourceRow[] | undefined; onDone: () => void }) {
  return (
    <FormDialog
      trigger={
        <Button size="sm" disabled={!resources}>
          <Plus />
          Add batch
        </Button>
      }
      title="Add batch"
      description="A past expiry date is allowed: the batch is recorded as expired and isn't usable."
      savedMessage="Batch received"
      onDone={onDone}
      submit={async (read) => {
        const resource = read("resource_id");
        await api("/api/stock", {
          method: "POST",
          body: JSON.stringify({
            resource_id: resource ? Number(resource) : undefined,
            ...(isAdmin && { center_id: centerId }),
            batch_code: read("batch_code"),
            quantity: Number(read("quantity") || NaN),
            ...(read("expiry_date") && { expiry_date: read("expiry_date") }),
          }),
        });
      }}
    >
      {(fields) => (
        <>
          <FormField htmlFor="resource_id" label="Resource" error={fields.resource_id}>
            <Select name="resource_id">
              <SelectTrigger id="resource_id" aria-invalid={!!fields.resource_id} className="w-full">
                <SelectValue placeholder="Choose a resource" />
              </SelectTrigger>
              <SelectContent>
                {resources?.map((r) => (
                  <SelectItem key={r.resource_id} value={String(r.resource_id)}>
                    {r.name} ({r.unit})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField htmlFor="batch_code" label="Batch code" error={fields.batch_code}>
            <Input id="batch_code" name="batch_code" aria-invalid={!!fields.batch_code} />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField htmlFor="quantity" label="Quantity" error={fields.quantity}>
              <Input id="quantity" name="quantity" type="number" step="0.01" min="0" aria-invalid={!!fields.quantity} />
            </FormField>
            <FormField htmlFor="expiry_date" label="Expiry date (optional)" error={fields.expiry_date}>
              <Input id="expiry_date" name="expiry_date" type="date" aria-invalid={!!fields.expiry_date} />
            </FormField>
          </div>
        </>
      )}
    </FormDialog>
  );
}

function AdjustDialog({ batch, onDone }: { batch: StockRow; onDone: () => void }) {
  return (
    <FormDialog
      trigger={
        <Button variant="outline" size="sm">
          <SlidersHorizontal />
          Adjust
        </Button>
      }
      title={`Adjust ${batch.batch_code}`}
      description={`Now ${formatQty(batch.quantity_available)} ${batch.unit}. Use a negative number to reduce it.`}
      savedMessage="Batch adjusted"
      onDone={onDone}
      submit={async (read) => {
        await api(`/api/stock/${batch.stock_id}/adjust`, {
          method: "POST",
          body: JSON.stringify({ delta: Number(read("delta") || NaN), reason: read("reason") }),
        });
      }}
    >
      {(fields) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField htmlFor="delta" label="Change" error={fields.delta}>
            <Input id="delta" name="delta" type="number" step="0.01" aria-invalid={!!fields.delta} autoFocus />
          </FormField>
          <FormField htmlFor="reason" label="Reason" error={fields.reason}>
            <ChoiceSelect id="reason" name="reason" defaultValue="ADJUSTMENT" options={ADJUST_REASONS} invalid={!!fields.reason} />
          </FormField>
        </div>
      )}
    </FormDialog>
  );
}

function LedgerSheet({ batch, onClose }: { batch: StockRow | null; onClose: () => void }) {
  const ledger = useApi<LedgerRow[]>(batch ? `/api/stock/${batch.stock_id}/ledger` : null);
  return (
    <Sheet open={batch !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Ledger: {batch?.batch_code}</SheetTitle>
          <SheetDescription>{batch ? `${batch.resource_name}, ${batch.center_name}` : ""}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {ledger.error && !ledger.data ? (
            <InlineError error={ledger.error} onRetry={() => void ledger.mutate()} />
          ) : !ledger.data ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Balance</TableHead>
                  <TableHead>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.data.map((row) => (
                  <TableRow key={row.ledger_id}>
                    <TableCell>{formatIst(row.changed_at)}</TableCell>
                    <TableCell>{row.reason.replaceAll("_", " ")}</TableCell>
                    <TableCell className="tabular-nums">{row.change_qty > 0 ? `+${formatQty(row.change_qty)}` : formatQty(row.change_qty)}</TableCell>
                    <TableCell className="tabular-nums">{formatQty(row.balance_after)}</TableCell>
                    <TableCell>{row.changed_by}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const batchCol = dataTableColumns<StockRow>();

function batchColumns(onDone: () => void, openLedger: (batch: StockRow) => void) {
  return batchCol.columns([
    batchCol.accessor("resource_name", {
      header: ({ column }) => <SortableHeader column={column} title="Resource" />,
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    batchCol.accessor("batch_code", { header: ({ column }) => <SortableHeader column={column} title="Batch" /> }),
    batchCol.accessor("quantity_available", {
      header: ({ column }) => <SortableHeader column={column} title="Quantity" />,
      cell: ({ getValue, row }) => `${formatQty(getValue())} ${row.original.unit}`,
    }),
    // Sorts on the days left, with no-expiry batches after every dated one.
    batchCol.accessor((row) => row.days_left ?? Number.MAX_SAFE_INTEGER, {
      id: "days_left",
      header: ({ column }) => <SortableHeader column={column} title="Expiry" />,
      cell: ({ row }) => <ExpiryBadge batch={row.original} />,
    }),
    batchCol.accessor("usable", {
      header: "Usable",
      cell: ({ getValue }) => (getValue() ? <ToneBadge tone="green">Usable</ToneBadge> : <ToneBadge tone="grey">Not usable</ToneBadge>),
    }),
    batchCol.display({
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          <AdjustDialog batch={row.original} onDone={onDone} />
          <Button variant="outline" size="sm" onClick={() => openLedger(row.original)}>
            <ScrollText />
            Ledger
          </Button>
        </div>
      ),
    }),
  ]);
}

function AllocationActions({ allocation, onDone }: { allocation: CenterAllocationRow; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const step = allocation.status === "RESERVED" ? "dispatch" : allocation.status === "DISPATCHED" ? "deliver" : null;
  if (!step) return null;

  async function move() {
    setPending(true);
    try {
      await api(`/api/stock/allocations/${allocation.allocation_id}/${step}`, { method: "POST" });
      toast.success(step === "dispatch" ? "Allocation dispatched" : "Allocation delivered");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That didn't work");
    } finally {
      setPending(false);
      onDone();
    }
  }

  return (
    <div className="flex justify-end">
      <Button size="sm" disabled={pending} onClick={() => void move()}>
        {step === "dispatch" ? "Dispatch" : "Deliver"}
      </Button>
    </div>
  );
}

const allocCol = dataTableColumns<CenterAllocationRow>();

function allocationColumns(onDone: () => void) {
  return allocCol.columns([
    allocCol.accessor("resource_name", {
      header: ({ column }) => <SortableHeader column={column} title="Resource" />,
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    allocCol.accessor("batch_code", { header: ({ column }) => <SortableHeader column={column} title="Batch" /> }),
    allocCol.accessor("quantity_allocated", {
      header: ({ column }) => <SortableHeader column={column} title="Quantity" />,
      cell: ({ getValue, row }) => `${formatQty(getValue())} ${row.original.unit}`,
    }),
    allocCol.accessor("grid_id", { header: ({ column }) => <SortableHeader column={column} title="For" /> }),
    allocCol.accessor("emergency_name", { header: ({ column }) => <SortableHeader column={column} title="Emergency" /> }),
    allocCol.accessor("status", { header: "Status", cell: ({ getValue }) => <StatusBadge value={getValue()} /> }),
    allocCol.accessor("allocated_at", {
      header: ({ column }) => <SortableHeader column={column} title="Allocated" />,
      cell: ({ getValue }) => formatIst(getValue()),
    }),
    allocCol.display({ id: "actions", header: "", cell: ({ row }) => <AllocationActions allocation={row.original} onDone={onDone} /> }),
  ]);
}

function CenterInventory({ centerId, isAdmin }: { centerId: number; isAdmin: boolean }) {
  const batches = useApi<StockRow[]>(`/api/stock?center=${centerId}`);
  const allocations = useApi<CenterAllocationRow[]>(`/api/stock/allocations?center=${centerId}`);
  const resources = useApi<ResourceRow[]>("/api/resources");
  const [ledgerBatch, setLedgerBatch] = useState<StockRow | null>(null);

  const refreshBatches = batches.mutate;
  const refreshAllocations = allocations.mutate;
  const refreshBoth = useMemo(
    () => () => {
      void refreshBatches();
      void refreshAllocations();
    },
    [refreshBatches, refreshAllocations],
  );
  const batchCols = useMemo(() => batchColumns(() => void refreshBatches(), setLedgerBatch), [refreshBatches]);
  const allocationCols = useMemo(() => allocationColumns(refreshBoth), [refreshBoth]);

  return (
    <>
      <Tabs defaultValue="batches">
        <TabsList>
          <TabsTrigger value="batches">Batches</TabsTrigger>
          <TabsTrigger value="allocations">Allocations</TabsTrigger>
        </TabsList>
        <TabsContent value="batches" className="flex flex-col gap-3">
          {resources.error && !resources.data && <InlineError error={resources.error} onRetry={() => void resources.mutate()} />}
          <div className="flex justify-end">
            <AddBatchDialog centerId={centerId} isAdmin={isAdmin} resources={resources.data} onDone={() => void refreshBatches()} />
          </div>
          {batches.error && !batches.data ? (
            <InlineError error={batches.error} onRetry={() => void refreshBatches()} />
          ) : !batches.data ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <DataTable
              columns={batchCols}
              data={batches.data}
              getRowId={(r) => String(r.stock_id)}
              filters={[{ column: "resource_name", placeholder: "Filter by resource…" }]}
              emptyMessage="No batches at this center yet."
            />
          )}
        </TabsContent>
        <TabsContent value="allocations">
          {allocations.error && !allocations.data ? (
            <InlineError error={allocations.error} onRetry={() => void refreshAllocations()} />
          ) : !allocations.data ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <DataTable columns={allocationCols} data={allocations.data} getRowId={(r) => String(r.allocation_id)} emptyMessage="No allocations from this center yet." />
          )}
        </TabsContent>
      </Tabs>
      <LedgerSheet batch={ledgerBatch} onClose={() => setLedgerBatch(null)} />
    </>
  );
}

function AdminInventory() {
  const centers = useApi<AdminCenterRow[]>("/api/admin/centers");
  const [picked, setPicked] = useState<number | null>(null);

  if (centers.error && !centers.data) return <InlineError error={centers.error} onRetry={() => void centers.mutate()} />;
  if (!centers.data) return <Skeleton className="h-72 w-full" />;
  const selected = picked ?? centers.data[0]?.center_id;
  if (selected === undefined) return <p className="text-muted-foreground">No centers yet. Add one under Centers.</p>;
  return (
    <div className="flex flex-col gap-3">
      <Select value={String(selected)} onValueChange={(v) => setPicked(Number(v))}>
        <SelectTrigger aria-label="Center" className="w-72 max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {centers.data.map((c) => (
            <SelectItem key={c.center_id} value={String(c.center_id)}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <CenterInventory key={selected} centerId={selected} isAdmin />
    </div>
  );
}

export function InventoryView({ isAdmin, ownCenterId }: { isAdmin: boolean; ownCenterId: number | null }) {
  if (isAdmin) return <AdminInventory />;
  if (ownCenterId === null) return <p className="text-muted-foreground">Your account isn&apos;t linked to a center.</p>;
  return <CenterInventory centerId={ownCenterId} isAdmin={false} />;
}
