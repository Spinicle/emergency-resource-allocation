"use client";

import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { InlineError } from "@/app/(app)/allocate/bits";
import { humanize } from "@/app/(app)/emergencies/format";
import { FormField } from "@/components/form-field";
import { ErasMap, MapKey, type MapPoint } from "@/components/map";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FieldErrors } from "@/lib/api-contract";
import { api, ApiError, useApi } from "@/lib/client";
import type { EmergencyDetail, EmergencyRow } from "@/lib/emergency-types";
import { SEVERITIES } from "@/lib/enums";
import type { ReportFiled } from "@/lib/report-types";
import type { ResourceRow } from "@/lib/stock-types";
import { observationSchema, REPORT_LIMITS } from "@/lib/validators/observations";
import { isWebUrl } from "@/lib/validators/reports";
import { buildDetails, DetailsFields, type DetailValues, EMPTY_DETAILS, toNumber } from "./details-fields";

// /reports/new: posts to /api/observations. The form runs the API's own schema
// before it submits. emergency_type comes from the chosen emergency, and the
// location is the impact's unless a point is picked on the map.

const IMPACT_COLOR = "var(--foreground)";
const PICKED_COLOR = "var(--primary)";

type NeedRow = { key: number; item: string; est_qty: string; unit: string };
type InfrastructureRow = { key: number; kind: string; name: string; status: string };
type CasualtyName = "injured" | "missing" | "deceased";

const CASUALTIES: readonly CasualtyName[] = ["injured", "missing", "deceased"];

/** What to say when a required value is missing, for the fields with no number to ask for. */
const REQUIRED_MESSAGES: Record<string, string> = {
  impact_id: "Choose an impacted location",
  severity: "Choose a severity",
  affected_percentage: "Enter the affected percentage",
};

/** observationSchema has no messages of its own, so the form words them for people. */
function readableMessage(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  switch (issue.code) {
    case "invalid_type":
      if (REQUIRED_MESSAGES[path]) return REQUIRED_MESSAGES[path];
      if (issue.expected === "int") return "Enter a whole number";
      return issue.expected === "number" ? "Enter a number" : "This is required";
    case "invalid_value":
      return REQUIRED_MESSAGES[path] ?? "Choose an option";
    case "too_small":
      return issue.origin === "string" ? "This can't be blank" : `Must be at least ${issue.minimum}`;
    case "too_big":
      if (issue.origin === "string") return `Keep this under ${issue.maximum} characters`;
      return issue.origin === "array" ? `At most ${issue.maximum} entries` : `Must be at most ${issue.maximum}`;
    default:
      return issue.message;
  }
}

/** A comma-separated or line-separated box as its non-blank entries. */
const splitList = (text: string, separator: RegExp) =>
  text
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);

/** The first message at or under this field, for a box that holds a whole list. */
function firstError(fields: FieldErrors, name: string): string | undefined {
  return fields[name] ?? Object.entries(fields).find(([key]) => key.startsWith(`${name}.`))?.[1];
}

export function NewReportForm() {
  const router = useRouter();
  const suggestionsId = useId();
  const emergencies = useApi<EmergencyRow[]>("/api/emergencies");
  const resources = useApi<ResourceRow[]>("/api/resources");

  const [emergencyId, setEmergencyId] = useState("");
  const [impactId, setImpactId] = useState("");
  const [severity, setSeverity] = useState("");
  const [affected, setAffected] = useState("");
  const [details, setDetails] = useState<DetailValues>(EMPTY_DETAILS);
  const [casualties, setCasualties] = useState<Record<CasualtyName, string>>({ injured: "", missing: "", deceased: "" });
  const nextKey = useRef(1);
  const [needs, setNeeds] = useState<NeedRow[]>([]);
  const [infrastructure, setInfrastructure] = useState<InfrastructureRow[]>([]);
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [photos, setPhotos] = useState("");
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);

  // null skips the request until an emergency is chosen.
  const emergency = useApi<EmergencyDetail>(emergencyId ? `/api/emergencies/${emergencyId}` : null);

  // A closed emergency takes no new reports, so it isn't offered.
  const openEmergencies = emergencies.data?.filter((e) => e.status !== "CLOSED") ?? [];
  const type = openEmergencies.find((e) => String(e.emergency_id) === emergencyId)?.type;
  const impact = emergency.data?.impacts.find((i) => String(i.impact_id) === impactId);

  /** Drops one field's message once its value changes: it described the old value. */
  function clearField(name: string) {
    setFields((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  /** clearField for a box that holds a whole list, whose messages may be per entry (tags.0, tags.1). */
  function clearList(name: string) {
    setFields((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== name && !key.startsWith(`${name}.`))),
    );
  }

  function updateNeed(index: number, key: number, change: Partial<NeedRow>) {
    setNeeds((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
    for (const name of Object.keys(change)) clearField(`needs_observed.${index}.${name}`);
  }

  function updateInfrastructure(index: number, key: number, change: Partial<InfrastructureRow>) {
    setInfrastructure((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
    for (const name of Object.keys(change)) clearField(`infrastructure.${index}.${name}`);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Without a type the schema can only report that one problem, so ask for it first.
    if (!type) {
      setFields({ emergency_type: "Choose an emergency" });
      toast.error("Check the highlighted fields");
      return;
    }

    const built = buildDetails(type, details);
    const typedCasualties = CASUALTIES.filter((name) => casualties[name].trim() !== "");
    const photoList = splitList(photos, /\r?\n/);
    const tagList = splitList(tags, /,/);

    const body = {
      impact_id: toNumber(impactId),
      emergency_type: type,
      affected_percentage: toNumber(affected),
      severity: severity || undefined,
      ...(point && { location: point }),
      details: built.details,
      ...(typedCasualties.length > 0 && {
        casualties: Object.fromEntries(typedCasualties.map((name) => [name, toNumber(casualties[name])])),
      }),
      ...(needs.length > 0 && {
        needs_observed: needs.map((row) => ({
          item: row.item,
          ...(row.est_qty.trim() !== "" && { est_qty: toNumber(row.est_qty) }),
          ...(row.unit.trim() !== "" && { unit: row.unit }),
        })),
      }),
      ...(infrastructure.length > 0 && {
        infrastructure: infrastructure.map((row) => ({
          kind: row.kind,
          ...(row.name.trim() !== "" && { name: row.name }),
          ...(row.status.trim() !== "" && { status: row.status }),
        })),
      }),
      ...(notes.trim() !== "" && { notes }),
      ...(tagList.length > 0 && { tags: tagList }),
      ...(photoList.length > 0 && { photos: photoList }),
    };

    // The same schema the API runs, plus what only the form checks.
    const checked = observationSchema.safeParse(body);
    const found: FieldErrors = { ...built.errors };
    if (!checked.success) {
      for (const issue of checked.error.issues) found[issue.path.join(".")] ??= readableMessage(issue);
    }
    if (photoList.some((photo) => !isWebUrl(photo))) found.photos ??= "Photo links must start with http:// or https://";
    if (Object.keys(found).length > 0) {
      setFields(found);
      toast.error("Check the highlighted fields");
      return;
    }

    setPending(true);
    setFields({});
    try {
      const filed = await api<ReportFiled>("/api/observations", { method: "POST", body: JSON.stringify(body) });
      toast.success(`Report #${filed.observation_id} filed`);
      router.push(`/reports/${filed.observation_id}`);
    } catch (err) {
      // E.g. the emergency closed meanwhile (409): the form stays as typed.
      toast.error(err instanceof Error ? err.message : "Couldn't file the report");
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      setPending(false);
    }
  }

  const loadError = emergencies.error ?? resources.error ?? emergency.error;

  // Theme colours, not severity hues: on the other maps red means CRITICAL.
  const mapPoints: MapPoint[] = impact
    ? [
        { id: "impact", lat: impact.latitude, lng: impact.longitude, color: IMPACT_COLOR, hollow: true, label: impact.grid_id, radius: 11 },
        ...(point ? [{ id: "picked", ...point, color: PICKED_COLOR, label: "Where it was seen", radius: 8, rank: 1 }] : []),
      ]
    : [];

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-4">
      <Link href="/reports" className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        All field reports
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
          <CardTitle>Where</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField htmlFor="emergency" label="Emergency" error={fields.emergency_type}>
              <Select
                value={emergencyId}
                onValueChange={(value) => {
                  setEmergencyId(value);
                  setImpactId(""); // the chosen location belonged to the previous emergency
                  setPoint(null);
                  setDetails(EMPTY_DETAILS); // details differ by type
                  setFields({});
                }}
              >
                <SelectTrigger id="emergency" aria-invalid={!!fields.emergency_type} className="w-full">
                  <SelectValue placeholder="Choose an emergency" />
                </SelectTrigger>
                <SelectContent>
                  {openEmergencies.map((e) => (
                    <SelectItem key={e.emergency_id} value={String(e.emergency_id)}>
                      {e.name} ({humanize(e.type)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField htmlFor="impact" label="Impacted location" error={fields.impact_id}>
              <Select
                value={impactId}
                onValueChange={(value) => {
                  setImpactId(value);
                  setPoint(null);
                  clearField("impact_id");
                }}
                disabled={!emergency.data}
              >
                <SelectTrigger id="impact" aria-invalid={!!fields.impact_id} className="w-full">
                  <SelectValue placeholder={emergencyId ? "Choose a location" : "Choose an emergency first"} />
                </SelectTrigger>
                <SelectContent>
                  {emergency.data?.impacts.map((i) => (
                    <SelectItem key={i.impact_id} value={String(i.impact_id)}>
                      {i.grid_id} ({humanize(i.status)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          {impact && (
            <div className="flex flex-col gap-2">
              {/* A new key re-centres the map on the newly chosen impact. */}
              <ErasMap
                key={impact.impact_id}
                points={mapPoints}
                center={{ lat: impact.latitude, lng: impact.longitude }}
                zoom={13}
                fitPoints={false}
                height="18rem"
                onMapClick={(at) => setPoint({ lat: Number(at.lat.toFixed(6)), lng: Number(at.lng.toFixed(6)) })}
              />
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                <MapKey color={IMPACT_COLOR} hollow label={`Impact location (${impact.grid_id})`} />
                <MapKey color={PICKED_COLOR} label="Where it was seen" />
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                <span>
                  {point
                    ? `Using the picked point: ${point.lat}, ${point.lng}`
                    : `Using ${impact.grid_id}'s location. Click the map to pick where it was seen.`}
                </span>
                {point && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setPoint(null)}>
                    Use impact location
                  </Button>
                )}
              </div>
              {firstError(fields, "location") && <p className="text-sm text-destructive">{firstError(fields, "location")}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What was seen</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField htmlFor="severity" label="Severity" error={fields.severity}>
              <Select
                value={severity}
                onValueChange={(value) => {
                  setSeverity(value);
                  clearField("severity");
                }}
              >
                <SelectTrigger id="severity" aria-invalid={!!fields.severity} className="w-full">
                  <SelectValue placeholder="Choose a severity" />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {humanize(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField htmlFor="affected" label="Affected (%)" error={fields.affected_percentage}>
              <Input
                id="affected"
                type="number"
                min="0"
                max="100"
                step="any"
                value={affected}
                onChange={(e) => {
                  setAffected(e.target.value);
                  clearField("affected_percentage");
                }}
                aria-invalid={!!fields.affected_percentage}
              />
            </FormField>
          </div>

          {type ? (
            <DetailsFields
              type={type}
              values={details}
              fields={fields}
              onChange={(change) => setDetails((current) => ({ ...current, ...change }))}
              onClearField={clearField}
            />
          ) : (
            <p className="text-muted-foreground">Choose an emergency to see the details for its type.</p>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            {CASUALTIES.map((name) => (
              <FormField key={name} htmlFor={name} label={`${humanize(name)} (optional)`} error={fields[`casualties.${name}`]}>
                <Input
                  id={name}
                  type="number"
                  min="0"
                  step="1"
                  value={casualties[name]}
                  onChange={(e) => {
                    setCasualties((current) => ({ ...current, [name]: e.target.value }));
                    clearField(`casualties.${name}`);
                  }}
                  aria-invalid={!!fields[`casualties.${name}`]}
                />
              </FormField>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Needs observed</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {fields.needs_observed && <p className="text-sm text-destructive">{fields.needs_observed}</p>}
          <datalist id={suggestionsId}>
            {resources.data?.map((r) => <option key={r.resource_id} value={r.name} />)}
          </datalist>
          {needs.map((row, index) => (
            <div key={row.key} className="grid items-start gap-2 border-b pb-3 last:border-b-0 sm:grid-cols-[1fr_7rem_7rem_auto]">
              <FormField htmlFor={`need-${row.key}`} label="Item" error={fields[`needs_observed.${index}.item`]}>
                <Input
                  id={`need-${row.key}`}
                  list={suggestionsId}
                  maxLength={REPORT_LIMITS.text}
                  value={row.item}
                  onChange={(e) => {
                    // Picking a catalogue item fills its unit, unless one was typed.
                    const unit = resources.data?.find((r) => r.name === e.target.value)?.unit;
                    updateNeed(index, row.key, { item: e.target.value, ...(unit && row.unit === "" && { unit }) });
                  }}
                  aria-invalid={!!fields[`needs_observed.${index}.item`]}
                />
              </FormField>
              <FormField htmlFor={`need-qty-${row.key}`} label="About" error={fields[`needs_observed.${index}.est_qty`]}>
                <Input
                  id={`need-qty-${row.key}`}
                  type="number"
                  min="0"
                  step="any"
                  value={row.est_qty}
                  onChange={(e) => updateNeed(index, row.key, { est_qty: e.target.value })}
                  aria-invalid={!!fields[`needs_observed.${index}.est_qty`]}
                />
              </FormField>
              <FormField htmlFor={`need-unit-${row.key}`} label="Unit" error={fields[`needs_observed.${index}.unit`]}>
                <Input
                  id={`need-unit-${row.key}`}
                  maxLength={REPORT_LIMITS.text}
                  value={row.unit}
                  onChange={(e) => updateNeed(index, row.key, { unit: e.target.value })}
                  aria-invalid={!!fields[`needs_observed.${index}.unit`]}
                />
              </FormField>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="sm:mt-6"
                aria-label={`Remove need ${index + 1}`}
                onClick={() => {
                  setNeeds((rows) => rows.filter((r) => r.key !== row.key));
                  setFields({}); // messages are keyed by position, which just shifted
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={needs.length >= REPORT_LIMITS.list}
            onClick={() => setNeeds((rows) => [...rows, { key: nextKey.current++, item: "", est_qty: "", unit: "" }])}
          >
            <Plus />
            Add need
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Infrastructure</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {fields.infrastructure && <p className="text-sm text-destructive">{fields.infrastructure}</p>}
          {infrastructure.map((row, index) => (
            <div key={row.key} className="grid items-start gap-2 border-b pb-3 last:border-b-0 sm:grid-cols-[1fr_1fr_1fr_auto]">
              {(["kind", "name", "status"] as const).map((name) => {
                const error = fields[`infrastructure.${index}.${name}`];
                return (
                  <FormField
                    key={name}
                    htmlFor={`infra-${name}-${row.key}`}
                    label={name === "kind" ? "Kind" : `${humanize(name)} (optional)`}
                    error={error}
                  >
                    <Input
                      id={`infra-${name}-${row.key}`}
                      maxLength={REPORT_LIMITS.text}
                      value={row[name]}
                      onChange={(e) => updateInfrastructure(index, row.key, { [name]: e.target.value })}
                      aria-invalid={!!error}
                    />
                  </FormField>
                );
              })}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="sm:mt-6"
                aria-label={`Remove infrastructure ${index + 1}`}
                onClick={() => {
                  setInfrastructure((rows) => rows.filter((r) => r.key !== row.key));
                  setFields({}); // messages are keyed by position, which just shifted
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={infrastructure.length >= REPORT_LIMITS.list}
            onClick={() => setInfrastructure((rows) => [...rows, { key: nextKey.current++, kind: "", name: "", status: "" }])}
          >
            <Plus />
            Add infrastructure
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FormField htmlFor="notes" label="Notes (optional)" error={fields.notes}>
            <Textarea
              id="notes"
              maxLength={REPORT_LIMITS.notes}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                clearField("notes");
              }}
              aria-invalid={!!fields.notes}
            />
          </FormField>
          <FormField htmlFor="tags" label="Tags, separated by commas (optional)" error={firstError(fields, "tags")}>
            <Input
              id="tags"
              value={tags}
              onChange={(e) => {
                setTags(e.target.value);
                clearList("tags");
              }}
              aria-invalid={!!firstError(fields, "tags")}
            />
          </FormField>
          <FormField htmlFor="photos" label="Photo links, one per line (optional)" error={firstError(fields, "photos")}>
            <Textarea
              id="photos"
              value={photos}
              onChange={(e) => {
                setPhotos(e.target.value);
                clearList("photos");
              }}
              aria-invalid={!!firstError(fields, "photos")}
            />
          </FormField>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Filing…" : "File report"}
        </Button>
      </div>
    </form>
  );
}
