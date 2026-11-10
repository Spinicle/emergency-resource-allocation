"use client";

import { ChevronsUpDown } from "lucide-react";
import { useId, useState } from "react";
import { InlineError } from "@/app/(app)/allocate/bits";
import { ErasMap, type MapPoint } from "@/components/map";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type { LocationRow } from "@/lib/admin-types";
import type { FieldErrors } from "@/lib/api-contract";
import { useApi } from "@/lib/client";
import { GRID_ID_MAX, gridIdFor, type LatLng, nearest, sameGridId, splitGridId } from "@/lib/geo";
import { createImpactSchema } from "@/lib/validators/emergencies";

// Picks a grid location for a form: search the existing grid ids, click one on
// the map, or click anywhere else for a new one, named <PREFIX>-<AREA>. The
// choice goes into hidden grid_id / latitude / longitude inputs, so the form
// sends the same body it always did and the server keeps the last word (an
// existing grid id keeps its saved coordinates; ids match ignoring case).
//
// With canUseExisting (Add impact) an existing location can be chosen. Without
// it (admin Locations, add and edit) the picker only places one: existing ones
// are shown for reference, and an id already taken is flagged, since the API
// would refuse it.

/** A click this close to an existing location asks whether that one is meant. */
const NEAR_KM = 1;
/** A new location takes the prefix of the nearest location this close. */
const PREFIX_KM = 50;

const DOT_COLOR = "#64748b";
const CHOSEN_COLOR = "var(--primary)";

/** "near": a click within NEAR_KM of `place` while existing locations can be used, waiting for "Use" or "New location here". */
type Choice =
  | { kind: "none" }
  | { kind: "existing"; location: LocationRow }
  | { kind: "near"; at: LatLng; place: LocationRow; km: number }
  | { kind: "new"; at: LatLng };

/** A new location's name as typed. `typed` overrides the <PREFIX>-<AREA> preview until the area or prefix changes. */
type NameDraft = { area: string; prefix: string; typed: string | null };

type PickerProps = {
  /** Lets an existing location be searched for and chosen (Add impact). */
  canUseExisting?: boolean;
  /** Admin edit: the location being moved or renamed. */
  editing?: LocationRow;
  errors: FieldErrors;
};

/** Picked points keep 5 decimal places (about 1 m), the precision shown. */
const round5 = (n: number) => Number(n.toFixed(5));
const formatCoords = ({ lat, lng }: LatLng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
const formatKm = (km: number) => (km < 0.1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
const atOf = (l: LocationRow): LatLng => ({ lat: l.latitude, lng: l.longitude });

/** Everything shown about a new location at `at`, derived from the draft and the existing locations. */
function describeNewLocation(at: LatLng, draft: NameDraft, locations: LocationRow[], editing: LocationRow | undefined) {
  // The edited location counts for its prefix (it keeps its own), not as a duplicate or a neighbour.
  const others = locations.filter((l) => l.location_id !== editing?.location_id);
  const prefixFrom = nearest(locations, atOf, at, PREFIX_KM);
  const prefix = prefixFrom && splitGridId(prefixFrom.place.grid_id).prefix;
  const gridId = draft.typed ?? gridIdFor(prefix ?? draft.prefix, draft.area);
  const source =
    !prefixFrom || !prefix
      ? `No location within ${PREFIX_KM} km to take a prefix from, so enter one.`
      : prefixFrom.place.location_id === editing?.location_id
        ? `${prefix} is this location's current prefix.`
        : `${prefix} is the prefix of ${prefixFrom.place.grid_id}, ${formatKm(prefixFrom.km)} away.`;
  return {
    at,
    gridId,
    needsPrefix: !prefix,
    hint: `${source} Edit the id if you need to.`,
    duplicate: gridId ? others.find((l) => sameGridId(l.grid_id, gridId)) : undefined,
    nearby: nearest(others, atOf, at, NEAR_KM),
  };
}

type NewLocation = ReturnType<typeof describeNewLocation>;

export function LocationPicker(props: PickerProps) {
  const list = useApi<LocationRow[]>("/api/locations");
  if (list.error && !list.data) return <InlineError error={list.error} onRetry={() => void list.mutate()} />;
  if (!list.data) return <Skeleton className="h-80 w-full" />;
  return <Picker {...props} locations={list.data} />;
}

function Picker({ canUseExisting = false, editing, errors, locations }: PickerProps & { locations: LocationRow[] }) {
  const others = locations.filter((l) => l.location_id !== editing?.location_id);
  const [choice, setChoice] = useState<Choice>(editing ? { kind: "new", at: atOf(editing) } : { kind: "none" });
  const [draft, setDraft] = useState<NameDraft>(() => ({ area: editing ? splitGridId(editing.grid_id).area : "", prefix: "", typed: editing?.grid_id ?? null }));
  const [focus, setFocus] = useState<LatLng | null>(editing ? atOf(editing) : null);

  const fresh = choice.kind === "new" ? describeNewLocation(choice.at, draft, locations, editing) : null;
  const use = (location: LocationRow) => setChoice({ kind: "existing", location });

  /** A map click or typed coordinates. */
  function pick(raw: LatLng) {
    const at = { lat: round5(raw.lat), lng: round5(raw.lng) };
    const near = canUseExisting ? nearest(others, atOf, at, NEAR_KM) : null;
    setChoice(near ? { kind: "near", at, ...near } : { kind: "new", at });
  }

  const chosenId = choice.kind === "existing" ? choice.location.location_id : null;
  const points: MapPoint[] = others.map((l) => {
    const chosen = l.location_id === chosenId;
    return {
      id: `location-${l.location_id}`,
      lat: l.latitude,
      lng: l.longitude,
      color: chosen ? CHOSEN_COLOR : DOT_COLOR,
      radius: chosen ? 8 : 5,
      rank: chosen ? 2 : 0,
      label: l.grid_id,
      // Otherwise a click on a dot is a click on the map at that spot.
      onClick: canUseExisting ? () => use(l) : undefined,
    };
  });
  if (choice.kind === "near") points.push({ id: "near", ...choice.at, color: CHOSEN_COLOR, hollow: true, radius: 8, rank: 1, label: "Clicked here" });
  if (fresh) points.push({ id: "new", ...fresh.at, color: CHOSEN_COLOR, radius: 8, rank: 2, label: fresh.gridId || "New location" });

  const sent =
    choice.kind === "existing"
      ? { grid_id: choice.location.grid_id, ...atOf(choice.location) }
      : fresh
        ? { grid_id: fresh.gridId, ...fresh.at }
        : null;
  const error = errors.grid_id ?? errors.latitude ?? errors.longitude;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {canUseExisting && (
        <GridSearch
          locations={locations}
          selected={choice.kind === "existing" ? choice.location : null}
          onSelect={(l) => {
            use(l);
            setFocus(atOf(l));
          }}
        />
      )}

      <div className="flex flex-col gap-1.5">
        <ErasMap points={points} height="16rem" fitKey="locations" focus={focus} onMapClick={pick} />
        <p className="text-xs text-muted-foreground">
          {canUseExisting
            ? "Click a dot to use that location, or anywhere else on the map for a new one."
            : "Click the map to place the location. Dots are the existing locations."}
        </p>
      </div>

      {choice.kind === "near" && (
        <div role="status" className="flex flex-col gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <p>
            That point is {formatKm(choice.km)} from <span className="font-medium">{choice.place.grid_id}</span>.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => use(choice.place)}>
              Use {choice.place.grid_id} ({formatKm(choice.km)} away)
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setChoice({ kind: "new", at: choice.at })}>
              New location here
            </Button>
          </div>
        </div>
      )}

      {choice.kind === "existing" && (
        <div className="rounded-md border bg-muted/40 px-3 py-2">
          <p className="font-medium">{choice.location.grid_id}</p>
          <p className="text-muted-foreground">
            <span className="tabular-nums">{formatCoords(atOf(choice.location))}</span> · its saved coordinates are used
          </p>
        </div>
      )}

      {fresh && (
        <NewLocationFields
          title={canUseExisting ? "New location" : "Location"}
          location={fresh}
          draft={draft}
          // Any change but the id itself goes back to the preview.
          onDraft={(change) => setDraft((d) => ({ ...d, typed: null, ...change }))}
          onUse={canUseExisting ? use : undefined}
        />
      )}

      <CoordinateEntry
        onApply={(at) => {
          pick(at);
          setFocus(at);
        }}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
      <input type="hidden" name="grid_id" value={sent?.grid_id ?? ""} />
      <input type="hidden" name="latitude" value={sent?.lat ?? ""} />
      <input type="hidden" name="longitude" value={sent?.lng ?? ""} />
    </div>
  );
}

/** A combobox over the existing grid ids. */
function GridSearch({
  locations,
  selected,
  onSelect,
}: {
  locations: LocationRow[];
  selected: LocationRow | null;
  onSelect: (location: LocationRow) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Existing location</Label>
      {/* modal: inside a dialog, so the list scrolls and focus stays in the popover. */}
      <Popover open={open} onOpenChange={setOpen} modal>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
            {selected ? selected.grid_id : <span className="text-muted-foreground">Search the existing grid ids…</span>}
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) gap-0 p-0">
          <Command>
            <CommandInput placeholder="Search grid ids…" />
            <CommandList>
              <CommandEmpty>No grid id matches. Click the map for a new location.</CommandEmpty>
              <CommandGroup>
                {locations.map((l) => (
                  <CommandItem
                    key={l.location_id}
                    value={l.grid_id}
                    data-checked={selected?.location_id === l.location_id}
                    onSelect={() => {
                      onSelect(l);
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{l.grid_id}</span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatCoords(atOf(l))}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function NewLocationFields({
  title,
  location: { at, gridId, needsPrefix, hint, duplicate, nearby },
  draft,
  onDraft,
  onUse,
}: {
  title: string;
  location: NewLocation;
  draft: NameDraft;
  onDraft: (change: Partial<NameDraft>) => void;
  /** Offered for a duplicate id when an existing location can be used. */
  onUse?: (location: LocationRow) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3 rounded-md border px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground tabular-nums">{formatCoords(at)}</span>
      </div>
      {nearby && (
        <p className="text-muted-foreground">
          {formatKm(nearby.km)} from {nearby.place.grid_id}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        {needsPrefix && (
          <div className="flex flex-col gap-1.5 sm:w-28">
            <Label htmlFor={`${id}-prefix`}>Prefix</Label>
            <Input id={`${id}-prefix`} value={draft.prefix} onChange={(e) => onDraft({ prefix: e.target.value })} placeholder="BLR" maxLength={10} />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-area`}>Area name</Label>
          <Input id={`${id}-area`} value={draft.area} onChange={(e) => onDraft({ area: e.target.value })} placeholder="HSR Layout" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-grid`}>Grid id</Label>
        <Input
          id={`${id}-grid`}
          value={gridId}
          onChange={(e) => onDraft({ typed: e.target.value })}
          maxLength={GRID_ID_MAX}
          aria-invalid={!!duplicate}
          aria-describedby={`${id}-grid-hint`}
        />
        <p id={`${id}-grid-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
      {duplicate && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <span>
            <span className="font-medium">{duplicate.grid_id}</span> already exists
            {onUse ? "." : ", so choose another grid id."}
          </span>
          {onUse && (
            <Button type="button" size="sm" variant="outline" onClick={() => onUse(duplicate)}>
              Use {duplicate.grid_id}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The API's own coordinate rules, so typed coordinates get the messages a submit would. */
const typedCoordinates = createImpactSchema.pick({ latitude: true, longitude: true });

/** Blank is NaN, which the schema reports as missing; anything else is kept to 5 decimal places like a click. */
const typedCoordinate = (text: string) => (text.trim() === "" ? Number.NaN : round5(Number(text)));

/** Typed coordinates for keyboard users; applied like a click on the map. */
function CoordinateEntry({ onApply }: { onApply: (at: LatLng) => void }) {
  const id = useId();
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function apply() {
    const parsed = typedCoordinates.safeParse({ latitude: typedCoordinate(lat), longitude: typedCoordinate(lng) });
    setProblem(parsed.success ? null : parsed.error.issues[0].message);
    if (parsed.success) onApply({ lat: parsed.data.latitude, lng: parsed.data.longitude });
  }

  // Enter applies the coordinates instead of submitting the dialog's form.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  };

  return (
    <details className="group rounded-md border px-3 py-2">
      <summary className="cursor-pointer font-medium text-muted-foreground select-none group-open:mb-2 hover:text-foreground">
        Enter coordinates
      </summary>
      <div className="flex flex-col gap-2">
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-lat`}>Latitude</Label>
            <Input id={`${id}-lat`} type="number" step="any" placeholder="12.91210" value={lat} onChange={(e) => setLat(e.target.value)} onKeyDown={onKeyDown} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-lng`}>Longitude</Label>
            <Input id={`${id}-lng`} type="number" step="any" placeholder="77.64460" value={lng} onChange={(e) => setLng(e.target.value)} onKeyDown={onKeyDown} />
          </div>
          <Button type="button" variant="outline" onClick={apply}>
            Use these
          </Button>
        </div>
        {problem && <p className="text-sm text-destructive">{problem}</p>}
      </div>
    </details>
  );
}
