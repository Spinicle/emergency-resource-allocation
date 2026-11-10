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
import { GRID_ID_MAX, gridIdFor, gridPrefix, type LatLng, nearest, sameGridId } from "@/lib/geo";

// Picks a grid location for a form: search the existing grid ids, click one on
// the map, or click anywhere else for a new one, named <PREFIX>-<AREA>. The
// choice goes into hidden grid_id / latitude / longitude inputs, so the form
// sends the same body it always did and the server keeps the last word (an
// existing grid id keeps its saved coordinates; ids match ignoring case).
//
// mode "impact" (Add impact) can use an existing location. mode "admin" (admin
// Locations, add and edit) only places one: existing ones are shown for
// reference, and an id already taken is flagged, since the API would refuse it.

/** A click this close to an existing location offers to use it instead. */
const NEAR_KM = 1;
/** A new location takes the prefix of the nearest location this close. */
const PREFIX_KM = 50;

const DOT_COLOR = "#64748b";
const CHOSEN_COLOR = "var(--primary)";

type Mode = "impact" | "admin";
type Choice = { kind: "none" } | { kind: "existing"; location: LocationRow } | { kind: "new"; at: LatLng };
type Offer = { at: LatLng; place: LocationRow; km: number };

/** Picked points keep 5 decimal places (about 1 m), the precision shown. */
const round5 = (n: number) => Number(n.toFixed(5));
const formatCoords = ({ lat, lng }: LatLng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
const formatKm = (km: number) => (km < 0.1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
const atOf = (l: LocationRow): LatLng => ({ lat: l.latitude, lng: l.longitude });

export function LocationPicker({ mode, editing, errors }: { mode: Mode; editing?: LocationRow; errors: FieldErrors }) {
  const list = useApi<LocationRow[]>("/api/locations");
  if (list.error && !list.data) return <InlineError error={list.error} onRetry={() => void list.mutate()} />;
  if (!list.data) return <Skeleton className="h-80 w-full" />;
  return <Picker mode={mode} editing={editing} errors={errors} locations={list.data} />;
}

function Picker({ mode, editing, errors, locations }: { mode: Mode; editing?: LocationRow; errors: FieldErrors; locations: LocationRow[] }) {
  // Everything but the location being edited: it can't be its own duplicate or neighbour.
  const others = editing ? locations.filter((l) => l.location_id !== editing.location_id) : locations;
  const editingPrefix = editing ? gridPrefix(editing.grid_id) : null;

  const [choice, setChoice] = useState<Choice>(editing ? { kind: "new", at: atOf(editing) } : { kind: "none" });
  const [offer, setOffer] = useState<Offer | null>(null);
  const [focus, setFocus] = useState<LatLng | null>(editing ? atOf(editing) : null);
  const [area, setArea] = useState(editing ? editing.grid_id.slice(editingPrefix ? editingPrefix.length + 1 : 0) : "");
  const [prefixText, setPrefixText] = useState("");
  /** A grid id typed over the preview; null follows the preview. An edit starts with the current id. */
  const [typedId, setTypedId] = useState<string | null>(editing?.grid_id ?? null);

  const at = choice.kind === "new" ? choice.at : null;
  // Itself included: an edited location keeps its own prefix.
  const prefixFrom = at ? nearest(locations, atOf, at, PREFIX_KM) : null;
  const autoPrefix = prefixFrom ? gridPrefix(prefixFrom.place.grid_id) : null;
  const gridId = typedId ?? gridIdFor(autoPrefix ?? prefixText, area);
  const duplicate = at && gridId ? others.find((l) => sameGridId(l.grid_id, gridId)) : undefined;
  const nearby = at ? nearest(others, atOf, at, NEAR_KM) : null;

  function chooseExisting(location: LocationRow) {
    setChoice({ kind: "existing", location });
    setOffer(null);
  }

  function placeNew(point: LatLng) {
    setChoice({ kind: "new", at: point });
    setOffer(null);
  }

  /** A map click or typed coordinates. Near an existing location, Add impact asks which is meant. */
  function pickPoint(raw: LatLng) {
    const point = { lat: round5(raw.lat), lng: round5(raw.lng) };
    const near = mode === "impact" ? nearest(others, atOf, point, NEAR_KM) : null;
    if (near) setOffer({ at: point, ...near });
    else placeNew(point);
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
      // In admin mode a click on a dot is a click on the map at that spot.
      onClick: mode === "impact" ? () => chooseExisting(l) : undefined,
    };
  });
  if (offer) points.push({ id: "offer", ...offer.at, color: CHOSEN_COLOR, hollow: true, radius: 8, rank: 1, label: "Clicked here" });
  if (at) points.push({ id: "new", ...at, color: CHOSEN_COLOR, radius: 8, rank: 2, label: gridId || "New location" });

  const submitted =
    choice.kind === "existing"
      ? { grid_id: choice.location.grid_id, latitude: String(choice.location.latitude), longitude: String(choice.location.longitude) }
      : choice.kind === "new"
        ? { grid_id: gridId, latitude: String(choice.at.lat), longitude: String(choice.at.lng) }
        : { grid_id: "", latitude: "", longitude: "" };
  const error = errors.grid_id ?? errors.latitude ?? errors.longitude;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {mode === "impact" && (
        <GridSearch
          locations={locations}
          selected={choice.kind === "existing" ? choice.location : null}
          onSelect={(l) => {
            chooseExisting(l);
            setFocus(atOf(l));
          }}
        />
      )}

      <div className="flex flex-col gap-1.5">
        <ErasMap points={points} height="16rem" fitKey="locations" focus={focus} onMapClick={pickPoint} />
        <p className="text-xs text-muted-foreground">
          {mode === "impact"
            ? "Click a dot to use that location, or anywhere else on the map for a new one."
            : "Click the map to place the location. Dots are the existing locations."}
        </p>
      </div>

      {offer && (
        <div role="status" className="flex flex-col gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <p>
            That point is {formatKm(offer.km)} from <span className="font-medium">{offer.place.grid_id}</span>.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => chooseExisting(offer.place)}>
              Use {offer.place.grid_id} ({formatKm(offer.km)} away)
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => placeNew(offer.at)}>
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

      {choice.kind === "new" && (
        <NewLocationFields
          mode={mode}
          at={choice.at}
          area={area}
          onArea={(value) => {
            setArea(value);
            setTypedId(null);
          }}
          prefix={autoPrefix}
          prefixFrom={prefixFrom}
          editingId={editing?.location_id}
          prefixText={prefixText}
          onPrefixText={(value) => {
            setPrefixText(value);
            setTypedId(null);
          }}
          gridId={gridId}
          onGridId={setTypedId}
          duplicate={duplicate}
          onUseDuplicate={mode === "impact" ? chooseExisting : undefined}
          nearby={mode === "admin" ? nearby : null}
        />
      )}

      <CoordinateEntry
        onApply={(point) => {
          pickPoint(point);
          setFocus(point);
        }}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
      <input type="hidden" name="grid_id" value={submitted.grid_id} />
      <input type="hidden" name="latitude" value={submitted.latitude} />
      <input type="hidden" name="longitude" value={submitted.longitude} />
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
      <Label htmlFor={id}>Grid id</Label>
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
  mode,
  at,
  area,
  onArea,
  prefix,
  prefixFrom,
  editingId,
  prefixText,
  onPrefixText,
  gridId,
  onGridId,
  duplicate,
  onUseDuplicate,
  nearby,
}: {
  mode: Mode;
  at: LatLng;
  area: string;
  onArea: (value: string) => void;
  /** From the nearest location within PREFIX_KM; null means the user types one. */
  prefix: string | null;
  prefixFrom: { place: LocationRow; km: number } | null;
  editingId?: number;
  prefixText: string;
  onPrefixText: (value: string) => void;
  gridId: string;
  onGridId: (value: string) => void;
  duplicate: LocationRow | undefined;
  onUseDuplicate?: (location: LocationRow) => void;
  nearby: { place: LocationRow; km: number } | null;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3 rounded-md border px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium">{mode === "impact" ? "New location" : "Location"}</span>
        <span className="text-muted-foreground tabular-nums">{formatCoords(at)}</span>
      </div>
      {nearby && (
        <p className="text-muted-foreground">
          {formatKm(nearby.km)} from {nearby.place.grid_id}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        {prefix === null && (
          <div className="flex flex-col gap-1.5 sm:w-28">
            <Label htmlFor={`${id}-prefix`}>Prefix</Label>
            <Input id={`${id}-prefix`} value={prefixText} onChange={(e) => onPrefixText(e.target.value)} placeholder="BLR" maxLength={10} />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-area`}>Area name</Label>
          <Input id={`${id}-area`} value={area} onChange={(e) => onArea(e.target.value)} placeholder="HSR Layout" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-grid`}>Grid id</Label>
        <Input
          id={`${id}-grid`}
          value={gridId}
          onChange={(e) => onGridId(e.target.value)}
          maxLength={GRID_ID_MAX}
          aria-invalid={!!duplicate}
          aria-describedby={`${id}-grid-hint`}
        />
        <p id={`${id}-grid-hint`} className="text-xs text-muted-foreground">
          {!prefix || !prefixFrom
            ? `No location within ${PREFIX_KM} km to take a prefix from, so enter one. Edit the id if you need to.`
            : prefixFrom.place.location_id === editingId
              ? `${prefix} is this location's current prefix. Edit the id if you need to.`
              : `${prefix} is the prefix of ${prefixFrom.place.grid_id}, ${formatKm(prefixFrom.km)} away. Edit the id if you need to.`}
        </p>
      </div>
      {duplicate && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <span>
            <span className="font-medium">{duplicate.grid_id}</span> already exists
            {onUseDuplicate ? "." : ", so choose another grid id."}
          </span>
          {onUseDuplicate && (
            <Button type="button" size="sm" variant="outline" onClick={() => onUseDuplicate(duplicate)}>
              Use {duplicate.grid_id}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Typed coordinates for keyboard users; applied like a click on the map. */
function CoordinateEntry({ onApply }: { onApply: (at: LatLng) => void }) {
  const id = useId();
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function apply() {
    const point = { lat: Number(lat), lng: Number(lng) };
    if (lat.trim() === "" || lng.trim() === "" || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      setProblem("Enter a latitude and a longitude");
    } else if (Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
      setProblem("Latitude is between -90 and 90, longitude between -180 and 180");
    } else {
      setProblem(null);
      onApply(point);
    }
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
