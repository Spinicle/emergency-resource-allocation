"use client";

import "leaflet/dist/leaflet.css";
import { type DivIcon, divIcon } from "leaflet";
import { cn } from "cn";
import { useEffect } from "react";
import { CircleMarker, MapContainer, Marker, Pane, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { BASEMAP_CHOICES, BASEMAPS, type BasemapChoice, setBasemapChoice, useBasemapChoice, usePrefersDark } from "./basemap";
import type { ErasMapProps, MapPoint } from "./map-types";

// The Leaflet map itself. Leaflet needs `window`, so only ./index.tsx may import
// this, through next/dynamic with ssr: false. CircleMarker rather than an image
// Marker: Leaflet's default icon images break under bundlers. Squares are Markers
// with a divIcon, which uses no images.
//
// Every marker has a 2px white outline (a hollow one just its ring) and the
// dark halo of .eras-marker in globals.css, so it reads on both basemaps.

const KARNATAKA = { lat: 12.9, lng: 76.8 };
const FOCUS_ZOOM = 13;

const CIRCLE_RADIUS = 9;
const SQUARE_SIZE = 16;
const squareIcons = new Map<string, DivIcon>();

/**
 * One icon per colour, made once, so react-leaflet doesn't reset it on every
 * render. html is a string because Leaflet appends an element as it is, and
 * markers sharing this icon would take it from each other; setting style on a
 * real element leaves the escaping to the browser. className replaces the
 * default leaflet-div-icon, which would draw a white box behind the square,
 * with the halo every marker has.
 */
function squareIcon(color: string): DivIcon {
  let icon = squareIcons.get(color);
  if (!icon) {
    const square = document.createElement("span");
    Object.assign(square.style, {
      display: "block",
      boxSizing: "border-box",
      width: "100%",
      height: "100%",
      background: color,
      border: "2px solid #fff",
      borderRadius: "3px",
    });
    icon = divIcon({
      className: "eras-marker",
      html: square.outerHTML,
      iconSize: [SQUARE_SIZE, SQUARE_SIZE],
      iconAnchor: [SQUARE_SIZE / 2, SQUARE_SIZE / 2],
    });
    squareIcons.set(color, icon);
  }
  return icon;
}

const resolvedColors = new Map<string, string>();

/**
 * A circle's colour as an SVG attribute takes it: var(--token) read off the
 * page, once per theme, since the tokens change with it. Any other colour as is.
 */
function svgColor(color: string, dark: boolean): string {
  if (!color.startsWith("var(")) return color;
  const key = `${dark ? "dark" : "light"} ${color}`;
  let resolved = resolvedColors.get(key);
  if (resolved === undefined) {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = color;
    resolved = getComputedStyle(probe).color || color;
    probe.remove();
    resolvedColors.set(key, resolved);
  }
  return resolved;
}

/**
 * Zooms to the points whenever the set of points changes, or only when fitKey
 * does. The top padding keeps points clear of the zoom buttons and the basemap
 * switch, the bottom padding clear of the credits.
 */
function FitToPoints({ points, fitKey }: { points: readonly MapPoint[]; fitKey?: string }) {
  const map = useMap();
  const ids = fitKey ?? points.map((p) => p.id).join("|");
  useEffect(() => {
    if (points.length > 0) {
      map.fitBounds(
        points.map((p) => [p.lat, p.lng] as [number, number]),
        { paddingTopLeft: [24, 56], paddingBottomRight: [24, 32], maxZoom: 14 },
      );
    }
    // ids stands for points: a new array with the same reports shouldn't move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ids]);
  return null;
}

function FocusOn({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng], Math.max(map.getZoom(), FOCUS_ZOOM));
  }, [map, lat, lng]);
  return null;
}

function ClickHandler({ onMapClick }: { onMapClick: NonNullable<ErasMapProps["onMapClick"]> }) {
  useMapEvents({
    click: (e) => {
      // wrap(): the map repeats sideways, and longitudes past 180 aren't valid coordinates.
      const { lat, lng } = e.latlng.wrap();
      onMapClick({ lat, lng });
    },
  });
  return null;
}

const CHOICE_LABELS: Record<BasemapChoice, string> = { auto: "Auto", light: "Light", dark: "Dark", street: "Street" };

/** Auto / Light / Dark / Street, over the map's top-right corner (zoom is top-left, credits bottom-right). */
function BasemapSwitch({ choice }: { choice: BasemapChoice }) {
  return (
    <div
      role="group"
      aria-label="Map style"
      className="absolute top-2 right-2 z-[1000] flex gap-0.5 rounded-md border bg-background/90 p-0.5 text-xs shadow-sm backdrop-blur-sm"
    >
      {BASEMAP_CHOICES.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={choice === c}
          onClick={() => setBasemapChoice(c)}
          className={cn(
            "rounded-sm px-2 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
            choice === c ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {CHOICE_LABELS[c]}
        </button>
      ))}
    </div>
  );
}

/**
 * Circles go into one pane per rank, z-index 410-419: above the tiles and
 * Leaflet's overlay pane (400), below the marker pane (600) where the squares
 * are. A pane fixes the order however the points arrive or change; SVG would
 * otherwise draw them in the order Leaflet happened to add them.
 */
function CircleLayers({ points, dark }: { points: readonly MapPoint[]; dark: boolean }) {
  const byRank = new Map<number, MapPoint[]>();
  for (const p of points) {
    const rank = Math.min(9, Math.max(0, Math.round(p.rank ?? 0)));
    const group = byRank.get(rank);
    if (group) group.push(p);
    else byRank.set(rank, [p]);
  }
  return [...byRank].map(([rank, group]) => (
    <Pane key={rank} name={`eras-rank-${rank}`} style={{ zIndex: 410 + rank }}>
      {group.map((p) => {
        const color = svgColor(p.color, dark);
        return (
          <CircleMarker
            key={p.id}
            center={[p.lat, p.lng]}
            radius={p.radius ?? CIRCLE_RADIUS}
            pathOptions={
              p.hollow
                ? { className: "eras-marker", color, weight: 3, fillOpacity: 0 }
                : { className: "eras-marker", color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.9 }
            }
            // A clicked marker isn't also a click on the map behind it.
            bubblingMouseEvents={!p.onClick}
            eventHandlers={p.onClick ? { click: p.onClick } : undefined}
          >
            <Tooltip>{p.label}</Tooltip>
          </CircleMarker>
        );
      })}
    </Pane>
  ));
}

export default function MapView({
  points,
  center = KARNATAKA,
  zoom = 8,
  fitPoints = true,
  fitKey,
  focus,
  onMapClick,
  height = "24rem",
}: ErasMapProps) {
  const choice = useBasemapChoice();
  const dark = usePrefersDark();
  const basemap = choice === "auto" ? (dark ? "dark" : "light") : choice;
  const tiles = BASEMAPS[basemap];
  const circles = points.filter((p) => p.shape !== "square");
  const squares = points.filter((p) => p.shape === "square");
  return (
    <div className="relative">
      <BasemapSwitch choice={choice} />
      <MapContainer center={[center.lat, center.lng]} zoom={zoom} style={{ height, width: "100%" }} className="rounded-md border">
        {/* The key swaps the layer whole: react-leaflet doesn't update attribution in place. */}
        <TileLayer key={basemap} url={tiles.url} attribution={tiles.attribution} maxZoom={tiles.maxZoom} />
        {fitPoints && <FitToPoints points={points} fitKey={fitKey} />}
        {/* After FitToPoints, so a focus given from the start wins over the first fit. */}
        {focus && <FocusOn lat={focus.lat} lng={focus.lng} />}
        {onMapClick && <ClickHandler onMapClick={onMapClick} />}
        <CircleLayers points={circles} dark={dark} />
        {/* Markers don't pass clicks to the map (bubblingMouseEvents is false for them). */}
        {squares.map((p) => (
          <Marker key={p.id} position={[p.lat, p.lng]} icon={squareIcon(p.color)} eventHandlers={p.onClick ? { click: p.onClick } : undefined}>
            <Tooltip>{p.label}</Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
