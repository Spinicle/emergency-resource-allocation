"use client";

import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { InlineError } from "@/app/(app)/allocate/bits";
import { humanize } from "@/app/(app)/emergencies/format";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FieldErrors } from "@/lib/api-contract";
import { api, ApiError, useApi } from "@/lib/client";
import type { EmergencyDetail, EmergencyRow } from "@/lib/emergency-types";
import { URGENCIES, type Urgency } from "@/lib/enums";
import type { RequestCreated } from "@/lib/request-types";
import type { ResourceRow } from "@/lib/stock-types";
import { type CreateRequestInput, createRequestSchema } from "@/lib/validators/requests";

// /requests/new: emergency -> impact, then item rows. The form runs the API's
// own schema before it submits. A resource picked twice is deliberately let
// through: the database refuses it and the whole request rolls back.

/** One item row as typed. key keeps React's row identity when a middle row is removed. */
type ItemRow = { key: number; resource_id: string; quantity: string; urgency: Urgency };

/** A form box's text as a number. Number("") is 0, so blank becomes NaN and fails with a clear message. */
const toNumber = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));

const newRow = (key: number): ItemRow => ({ key, resource_id: "", quantity: "", urgency: "MEDIUM" });

export function NewRequestForm() {
  const router = useRouter();
  const emergencies = useApi<EmergencyRow[]>("/api/emergencies");
  const resources = useApi<ResourceRow[]>("/api/resources");

  const [emergencyId, setEmergencyId] = useState("");
  const [impactId, setImpactId] = useState("");
  const [requiredBy, setRequiredBy] = useState("");
  const [description, setDescription] = useState("");
  const nextKey = useRef(1);
  const [items, setItems] = useState<ItemRow[]>([newRow(0)]);
  const [fields, setFields] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);

  // null skips the request until an emergency is chosen.
  const emergency = useApi<EmergencyDetail>(emergencyId ? `/api/emergencies/${emergencyId}` : null);

  // A closed emergency refuses new requests, so it isn't offered.
  const openEmergencies = emergencies.data?.filter((e) => e.status !== "CLOSED") ?? [];

  function updateItem(key: number, change: Partial<ItemRow>) {
    setItems((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const body: CreateRequestInput = {
      impact_id: toNumber(impactId),
      ...(requiredBy && { required_by: requiredBy }),
      description,
      items: items.map((row) => ({
        resource_id: toNumber(row.resource_id),
        quantity_requested: toNumber(row.quantity),
        urgency: row.urgency,
      })),
    };

    // The same schema the API runs, so most mistakes are caught without a round trip.
    const checked = createRequestSchema.safeParse(body);
    if (!checked.success) {
      const found: FieldErrors = {};
      for (const issue of checked.error.issues) found[issue.path.join(".")] ??= issue.message;
      setFields(found);
      toast.error("Check the highlighted fields");
      return;
    }

    setPending(true);
    setFields({});
    try {
      const created = await api<RequestCreated>("/api/requests", { method: "POST", body: JSON.stringify(body) });
      toast.success(`Request #${created.request_id} created`);
      router.push(`/requests/${created.request_id}`);
    } catch (err) {
      // E.g. a repeated resource (409): the API rolled everything back, so the
      // form stays as typed and can be fixed and resubmitted.
      toast.error(err instanceof Error ? err.message : "Couldn't create the request");
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      setPending(false);
    }
  }

  const loadError = emergencies.error ?? resources.error ?? emergency.error;

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-4">
      <Link href="/requests" className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        All requests
      </Link>

      {loadError && (
        <InlineError
          error={loadError}
          onRetry={() => {
            void emergencies.mutate();
            void resources.mutate();
            void emergency.mutate();
          }}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Where it&apos;s needed</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField htmlFor="emergency" label="Emergency">
              <Select
                value={emergencyId}
                onValueChange={(value) => {
                  setEmergencyId(value);
                  setImpactId(""); // the chosen location belonged to the previous emergency
                }}
              >
                <SelectTrigger id="emergency" className="w-full">
                  <SelectValue placeholder="Choose an emergency" />
                </SelectTrigger>
                <SelectContent>
                  {openEmergencies.map((e) => (
                    <SelectItem key={e.emergency_id} value={String(e.emergency_id)}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField htmlFor="impact" label="Impacted location" error={fields.impact_id}>
              <Select value={impactId} onValueChange={setImpactId} disabled={!emergency.data}>
                <SelectTrigger id="impact" aria-invalid={!!fields.impact_id} className="w-full">
                  <SelectValue placeholder={emergencyId ? "Choose a location" : "Choose an emergency first"} />
                </SelectTrigger>
                <SelectContent>
                  {emergency.data?.impacts.map((i) => (
                    // A resolved location refuses new requests until it's set back to active.
                    <SelectItem key={i.impact_id} value={String(i.impact_id)} disabled={i.status === "RESOLVED"}>
                      {i.grid_id} ({humanize(i.status)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
          <FormField htmlFor="required_by" label="Needed by (IST, optional)" error={fields.required_by}>
            <Input
              id="required_by"
              type="datetime-local"
              value={requiredBy}
              onChange={(e) => setRequiredBy(e.target.value)}
              aria-invalid={!!fields.required_by}
              className="sm:w-64"
            />
          </FormField>
          <FormField htmlFor="description" label="Description (optional)" error={fields.description}>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-invalid={!!fields.description}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What&apos;s needed</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {fields.items && <p className="text-sm text-destructive">{fields.items}</p>}
          {items.map((row, index) => {
            const unit = resources.data?.find((r) => String(r.resource_id) === row.resource_id)?.unit;
            const resourceError = fields[`items.${index}.resource_id`];
            const quantityError = fields[`items.${index}.quantity_requested`];
            return (
              <div
                key={row.key}
                className="grid items-start gap-2 border-b pb-3 last:border-b-0 sm:grid-cols-[1fr_8rem_8rem_auto]"
              >
                <FormField htmlFor={`resource-${row.key}`} label="Resource" error={resourceError}>
                  <Select value={row.resource_id} onValueChange={(value) => updateItem(row.key, { resource_id: value })}>
                    <SelectTrigger id={`resource-${row.key}`} aria-invalid={!!resourceError} className="w-full">
                      <SelectValue placeholder="Choose a resource" />
                    </SelectTrigger>
                    <SelectContent>
                      {resources.data?.map((r) => (
                        <SelectItem key={r.resource_id} value={String(r.resource_id)}>
                          {r.name} ({humanize(r.category)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField
                  htmlFor={`quantity-${row.key}`}
                  label={unit ? `Quantity (${unit})` : "Quantity"}
                  error={quantityError}
                >
                  <Input
                    id={`quantity-${row.key}`}
                    type="number"
                    min="0"
                    step="any"
                    value={row.quantity}
                    onChange={(e) => updateItem(row.key, { quantity: e.target.value })}
                    aria-invalid={!!quantityError}
                  />
                </FormField>
                <FormField htmlFor={`urgency-${row.key}`} label="Urgency" error={fields[`items.${index}.urgency`]}>
                  <Select
                    value={row.urgency}
                    onValueChange={(value) => updateItem(row.key, { urgency: value as Urgency })}
                  >
                    <SelectTrigger id={`urgency-${row.key}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {URGENCIES.map((u) => (
                        <SelectItem key={u} value={u}>
                          {humanize(u)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="sm:mt-6"
                  disabled={items.length === 1}
                  aria-label={`Remove item ${index + 1}`}
                  onClick={() => {
                    setItems((rows) => rows.filter((r) => r.key !== row.key));
                    setFields({}); // messages are keyed by position, which just shifted
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => setItems((rows) => [...rows, newRow(nextKey.current++)])}
          >
            <Plus />
            Add item
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create request"}
        </Button>
      </div>
    </form>
  );
}
