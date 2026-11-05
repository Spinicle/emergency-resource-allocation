"use client";

import { cn } from "cn";
import { Info, PackageOpen } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type {
  AllocationRow,
  CancelAllocationResult,
  CreateAllocationsResult,
  ItemAllocations,
  ItemState,
  QueueRow,
  SuggestionRow,
} from "@/lib/allocation-types";
import { ApiError, api, useApi } from "@/lib/client";
import { allocationQuantity } from "@/lib/validators/allocations";
import { InlineError, StatusBadge, ToneBadge } from "./bits";
import { formatIst, formatQty, toCents } from "./format";
import { ScoreBreakdown } from "./score-breakdown";

// One item's panel on /allocate: its state and score, the suggested batches
// with an editable split, and its allocations. The suggestions and the totals
// here are UX only: the triggers make every decision, and their messages are
// shown as-is. After any write, success or not, everything is refetched.
//
// The in-panel lists are plain shadcn Tables, not DataTable (HANDOFF 4.7): the
// suggestion rank is the order, and a pager has no place in a side panel.

const failure = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong");

export function ItemPanel({
  itemId,
  queue,
  refreshQueue,
  onClose,
}: {
  itemId: number | null;
  /** The queue's rows; undefined until it has loaded. */
  queue: QueueRow[] | undefined;
  refreshQueue: () => Promise<unknown>;
  onClose: () => void;
}) {
  // Keep the last item while the sheet animates closed, so it doesn't go blank.
  const [shownId, setShownId] = useState(itemId);
  if (itemId !== null && itemId !== shownId) setShownId(itemId);

  return (
    <Sheet open={itemId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
      >
        {shownId !== null && (
          <PanelBody
            key={shownId}
            itemId={shownId}
            // Looked up by shownId, not itemId, so closing doesn't flash "left the queue".
            queueRow={queue?.find((r) => r.request_item_id === shownId)}
            queueLoaded={queue !== undefined}
            refreshQueue={refreshQueue}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function PanelBody({
  itemId,
  queueRow,
  queueLoaded,
  refreshQueue,
}: {
  itemId: number;
  /** The item's queue row, if it's in the queue. */
  queueRow: QueueRow | undefined;
  /** False until the queue has loaded once, so "left the queue" isn't shown while it's still coming. */
  queueLoaded: boolean;
  refreshQueue: () => Promise<unknown>;
}) {
  const detail = useApi<ItemAllocations>(`/api/allocations?item=${itemId}`);
  const item = detail.data?.item;
  const isOpen = item?.item_status === "PENDING" || item?.item_status === "PARTIAL";
  const leftQueue = queueLoaded && item !== undefined && queueRow === undefined;
  // Only once the item is known to be open (and not known to be out of the queue): a bad id gets
  // one "not found", and closed items skip the call.
  const suggestions = useApi<SuggestionRow[]>(
    isOpen && !leftQueue ? `/api/allocations/suggestions?item=${itemId}` : null,
  );

  const { mutate: mutateDetail } = detail;
  const { mutate: mutateSuggestions } = suggestions;
  // The item first: if the queue refreshed first, a still-open item could briefly look as if it had left it.
  const refreshAll = useCallback(async () => {
    await mutateDetail();
    await Promise.all([refreshQueue(), mutateSuggestions()]);
  }, [refreshQueue, mutateDetail, mutateSuggestions]);

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle>
          {item ? `${item.resource_name} · ${item.grid_id}` : detail.error ? "Request item" : "Loading…"}
        </SheetTitle>
        <SheetDescription>
          {item
            ? `${item.emergency_name} · request #${item.request_id} · item #${item.request_item_id}`
            : `Request item #${itemId}`}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-6 p-4">
        {!item ? (
          detail.error ? (
            <InlineError error={detail.error} onRetry={() => void detail.mutate()} />
          ) : (
            <Skeleton className="h-40 w-full" />
          )
        ) : (
          <>
            {/* A failed refetch keeps the last good data on screen, with the error above it. */}
            {detail.error && <InlineError error={detail.error} onRetry={() => void detail.mutate()} />}
            <ItemSummary item={item} />

            {queueRow ? (
              <ScoreBreakdown row={queueRow} />
            ) : leftQueue ? (
              <LeftQueueNotice item={item} />
            ) : (
              <Skeleton className="h-36 w-full" />
            )}

            {isOpen && !leftQueue && (
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">Suggested batches</h3>
                {suggestions.error && (
                  <InlineError error={suggestions.error} onRetry={() => void suggestions.mutate()} />
                )}
                {!suggestions.data ? (
                  !suggestions.error && <Skeleton className="h-28 w-full" />
                ) : suggestions.data.length === 0 ? (
                  <EmptySuggestions item={item} />
                ) : (
                  <Suggestions item={item} rows={suggestions.data} onWrite={refreshAll} />
                )}
              </section>
            )}

            <section className="flex flex-col gap-2">
              <h3 className="font-medium">Allocations</h3>
              <Allocations rows={detail.data?.allocations ?? []} unit={item.unit} onWrite={refreshAll} />
            </section>
          </>
        )}
      </div>
    </>
  );
}

function ItemSummary({ item }: { item: ItemState }) {
  const stat = (label: string, value: number, unit?: string) => (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-base tabular-nums">
        {formatQty(value)}
        {unit && <span className="ml-1 font-sans text-sm text-muted-foreground">{unit}</span>}
      </span>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge value={item.item_status} />
        <StatusBadge value={item.urgency} />
        <span className="text-muted-foreground">Request</span>
        <StatusBadge value={item.request_status} />
        {item.emergency_status !== "ACTIVE" && <ToneBadge tone="grey">Emergency {item.emergency_status}</ToneBadge>}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {stat("Requested", item.quantity_requested)}
        {stat("Allocated", item.quantity_allocated)}
        {stat("Remaining", item.quantity_remaining, item.unit)}
      </div>
    </div>
  );
}

function LeftQueueNotice({ item }: { item: ItemState }) {
  const why =
    item.item_status === "FULFILLED"
      ? "This item is now FULFILLED and has left the queue."
      : item.item_status === "CANCELLED"
        ? "This item was CANCELLED and has left the queue."
        : item.emergency_status === "CLOSED"
          ? "This item isn't in the queue: its emergency is CLOSED."
          : `This item isn't in the queue (request ${item.request_status.replaceAll("_", " ")}).`;
  return (
    <div role="status" className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{why} Its allocations are below.</span>
    </div>
  );
}

function EmptySuggestions({ item }: { item: ItemState }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-dashed p-6 text-center">
      <PackageOpen className="size-6 text-muted-foreground" />
      <span className="font-medium">No usable stock of {item.resource_name} at any open center</span>
      <span className="text-muted-foreground">
        Every batch is empty, expired, or at a CLOSED center. {formatQty(item.quantity_remaining)} {item.unit} still
        needed.
      </span>
    </div>
  );
}

function DaysLeft({ days }: { days: number | null }) {
  if (days === null) return <ToneBadge tone="grey">no expiry</ToneBadge>;
  if (days === 0) return <ToneBadge tone="red">expires today</ToneBadge>;
  return <ToneBadge tone={days <= 7 ? "amber" : "grey"}>{days} d left</ToneBadge>;
}

/** A typed quantity: blank counts as 0; otherwise above 0 with at most 2 decimals (the API's rule). */
function parseQty(text: string): { value: number; valid: boolean } {
  if (text.trim() === "") return { value: 0, valid: true };
  const value = Number(text);
  if (value === 0) return { value: 0, valid: true };
  return { value, valid: allocationQuantity.safeParse(value).success };
}

const initialDraft = (rows: SuggestionRow[]) =>
  Object.fromEntries(rows.map((s) => [s.stock_id, s.suggested_qty > 0 ? String(s.suggested_qty) : ""]));

function Suggestions({ item, rows, onWrite }: { item: ItemState; rows: SuggestionRow[]; onWrite: () => Promise<void> }) {
  // The typed quantities, reset to the suggested split whenever the suggestions change.
  const [draft, setDraft] = useState(() => ({ source: rows, values: initialDraft(rows) }));
  if (draft.source !== rows) setDraft({ source: rows, values: initialDraft(rows) });
  const [busy, setBusy] = useState(false);

  const parsed = rows.map((s) => ({ s, ...parseQty(draft.values[s.stock_id] ?? "") }));
  const totalCents = parsed.reduce((sum, p) => sum + (p.valid ? toCents(p.value) : 0), 0);
  const remainingCents = toCents(item.quantity_remaining);
  const anyInvalid = parsed.some((p) => !p.valid);
  const over = totalCents > remainingCents;
  const canAllocate = !busy && !anyInvalid && totalCents > 0 && !over;

  async function allocate() {
    const chosen = parsed.filter((p) => p.valid && p.value > 0);
    const batches = chosen.map((p) => ({ stock_id: p.s.stock_id, quantity: p.value }));
    setBusy(true);
    try {
      const res = await api<CreateAllocationsResult>("/api/allocations", {
        method: "POST",
        body: JSON.stringify({ request_item_id: item.request_item_id, batches }),
      });
      const from = chosen.length === 1 ? chosen[0].s.batch_code : `${chosen.length} batches`;
      toast.success(
        `Allocated ${formatQty(totalCents / 100)} ${item.unit} from ${from}. Item is now ${res.item.item_status}.`,
      );
    } catch (err) {
      toast.error(failure(err));
    } finally {
      await onWrite();
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead>Center</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead className="text-right">Distance</TableHead>
              <TableHead className="text-right">Allocate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parsed.map(({ s, valid }) => (
              <TableRow key={s.stock_id}>
                <TableCell className="font-mono tabular-nums">{s.suggestion_rank}</TableCell>
                <TableCell className="font-mono text-xs">{s.batch_code}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="whitespace-nowrap">{s.center_name}</span>
                    {s.center_status === "LIMITED" && <ToneBadge tone="amber">LIMITED</ToneBadge>}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatQty(s.quantity_available)}</TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-0.5">
                    {s.expiry_date && <span className="whitespace-nowrap">{formatIst(s.expiry_date)}</span>}
                    <DaysLeft days={s.days_left} />
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                  {s.distance_km.toFixed(1)} km
                </TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    placeholder="0"
                    aria-label={`Quantity from ${s.batch_code}`}
                    aria-invalid={!valid || undefined}
                    value={draft.values[s.stock_id] ?? ""}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, values: { ...d.values, [s.stock_id]: e.target.value } }))
                    }
                    className="ml-auto h-8 w-24 text-right font-mono tabular-nums"
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={6} className="text-right">
                Total of {formatQty(item.quantity_remaining)} {item.unit} remaining
              </TableCell>
              <TableCell
                className={cn("text-right font-mono tabular-nums", over && "text-destructive")}
                aria-live="polite"
              >
                {formatQty(totalCents / 100)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {anyInvalid && <span className="text-destructive">Quantities must be above 0 with at most 2 decimals.</span>}
        {!anyInvalid && over && (
          <span className="text-destructive">
            {formatQty((totalCents - remainingCents) / 100)} {item.unit} more than the item still needs.
          </span>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft({ source: rows, values: initialDraft(rows) })}>
          Reset to suggestion
        </Button>
        <Button disabled={!canAllocate} onClick={() => void allocate()}>
          {busy ? "Allocating…" : "Allocate"}
        </Button>
      </div>
    </div>
  );
}

function Allocations({ rows, unit, onWrite }: { rows: AllocationRow[]; unit: string; onWrite: () => Promise<void> }) {
  const [target, setTarget] = useState<AllocationRow | null>(null);
  const [busy, setBusy] = useState(false);

  async function cancel(a: AllocationRow) {
    setBusy(true);
    try {
      const res = await api<CancelAllocationResult>(`/api/allocations/${a.allocation_id}/cancel`, { method: "POST" });
      toast.success(
        `Cancelled: ${formatQty(a.quantity_allocated)} ${unit} back in ${a.batch_code}. Item is now ${res.item.item_status}.`,
      );
    } catch (err) {
      toast.error(failure(err));
    } finally {
      await onWrite();
      setBusy(false);
      setTarget(null);
    }
  }

  if (rows.length === 0) return <p className="text-muted-foreground">No allocations yet.</p>;

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Batch</TableHead>
              <TableHead>Center</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead>Allocated</TableHead>
              <TableHead>By</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.allocation_id}>
                <TableCell className="font-mono text-xs">{a.batch_code}</TableCell>
                <TableCell className="whitespace-nowrap">{a.center_name}</TableCell>
                <TableCell>
                  <StatusBadge value={a.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                  {formatQty(a.quantity_allocated)}
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatIst(a.allocated_at)}</TableCell>
                <TableCell className="whitespace-nowrap">{a.allocated_by}</TableCell>
                <TableCell>
                  {(a.status === "RESERVED" || a.status === "DISPATCHED") && (
                    <Button variant="outline" size="sm" onClick={() => setTarget(a)}>
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={target !== null} onOpenChange={(open) => !open && !busy && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this allocation?</AlertDialogTitle>
            <AlertDialogDescription>
              {target &&
                `${formatQty(target.quantity_allocated)} ${unit} from ${target.batch_code} (${target.center_name}) goes back to the batch, and the item's status is recomputed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault(); // stay open until the cancel has finished
                if (target) void cancel(target);
              }}
            >
              {busy ? "Cancelling…" : "Cancel allocation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
