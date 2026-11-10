"use client";

import "leaflet/dist/leaflet.css";
import { type DivIcon, divIcon } from "leaflet";
import { cn } from "cn";
import { useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Marker, Pane, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { BASEMAP_CHOICES, BASEMAPS, type BasemapChoice, setBasemapChoice, useBasemapChoice, usePrefersDark } from "./basemap";
import type { ErasMapProps, MapPoint } from "./map-types";

// The Leaflet map itself. Leaflet needs `window`, so only ./index.tsx may import
// this, through next/dynamic with ssr: false. CircleMarker rather than an image
// Marker: Leaflet's default icon images break under bundlers. Squares are Markers
// with a divIcon, which uses no images.
//
// Every marker has a 2px white outline and a dark halo (.eras-marker in
// globals.css), so it reads on the light and the dark basemap alike.

const KARNATAKA = { lat: 12.9, lng: 76.8 };
const FOCUS_ZOOM = 13;

const CIRCLE_RADIUS = 9;
const SQUARE_SIZE = 16;
const HALO = "0 0 0 0.5px rgb(0 0 0 / 0.55), 0 0 3px rgb(0 0 0 / 0.6)";
const squareIcons = new Map<string, DivIcon>();

/**
 * One icon per colour, made once, so react-leaflet doesn't reset it on every
 * render. html is a string because Leaflet appends an element as it is, and
 * markers sharing this icon would take it from each other; setting style on a
 * real element leaves the escaping to the browser. className replaces the
 * default leaflet-div-icon, which would draw a white box behind the square.
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
      boxShadow: HALO,
    });
    icon = divIcon({
      className: "eras-map-square",
      html: square.outerHTML,
      iconSize: [SQUARE_SIZE, SQUARE_SIZE],
      iconAnchor: [SQUARE_SIZE / 2, SQUARE_SIZE / 2],
    });
    squareIcons.set(color, icon);
  }
  return icon;
}

/**
 * SVG attributes don't take var(--token), so a token colour is read off the
 * page. dark is only there to read it again when the theme flips.
 */
function useResolvedColors(points: readonly MapPoint[], dark: boolean): Map<string, string> {
  return useMemo(() => {
    void dark;
    const resolved = new Map<string, string>();
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    for (const { color } of points) {
      if (color.startsWith("var(") && !resolved.has(color)) {
        probe.style.color = color;
        resolved.set(color, getComputedStyle(probe).color || color);
      }
    }
    probe.remove();
    return resolved;
  }, [points, dark]);
}

/** Zooms to the points whenever the set of points changes, or only when fitKey does. */
function FitToPoints({ points, fitKey }: { points: readonly MapPoint[]; fitKey?: string }) {
  const map = useMap();
  const ids = fitKey ?? points.map((p) => p.id).join("|");
  useEffect(() => {
    if (points.length > 0) {
      map.fitBounds(
        points.map((p) => [p.lat, p.lng] as [number, number]),
        { padding: [24, 24], maxZoom: 14 },
      );
    }
    // ids stands for points: a new array with the same reports shouldn't move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ids]);
  return null;
}

function FocusOn({ focus }: { focus: { lat: number; lng: number } }) {
  const map = useMap();
  useEffect(() => {
    map.setView([focus.lat, focus.lng], Math.max(map.getZoom(), FOCUS_ZOOM));
  }, [map, focus]);
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
function CircleLayers({ points, colors }: { points: readonly MapPoint[]; colors: Map<string, string> }) {
  const byRank = new Map<number, MapPoint[]>();
  for (const p of points) {
    const rank = Math.min(9, Math.max(0, Math.round(p.rank ?? 0)));
    byRank.set(rank, [...(byRank.get(rank) ?? []), p]);
  }
  return [...byRank].map(([rank, group]) => (
    <Pane key={rank} name={`eras-rank-${rank}`} style={{ zIndex: 410 + rank }}>
      {group.map((p) => {
        const color = colors.get(p.color) ?? p.color;
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
  const colors = useResolvedColors(points, dark);
  const circles = points.filter((p) => p.shape !== "square");
  return (
    <div className="relative">
      <BasemapSwitch choice={choice} />
      <MapContainer center={[center.lat, center.lng]} zoom={zoom} style={{ height, width: "100%" }} className="rounded-md border">
        {/* The key swaps the layer whole: react-leaflet doesn't update attribution in place. */}
        <TileLayer key={basemap} url={tiles.url} attribution={tiles.attribution} maxZoom={tiles.maxZoom} />
        {fitPoints && <FitToPoints points={points} fitKey={fitKey} />}
        {/* After FitToPoints, so a focus given from the start wins over the first fit. */}
        {focus && <FocusOn focus={focus} />}
        {onMapClick && <ClickHandler onMapClick={onMapClick} />}
        <CircleLayers points={circles} colors={colors} />
        {/* Markers don't pass clicks to the map (bubblingMouseEvents is false for them). */}
        {points
          .filter((p) => p.shape === "square")
          .map((p) => (
            <Marker key={p.id} position={[p.lat, p.lng]} icon={squareIcon(p.color)} eventHandlers={p.onClick ? { click: p.onClick } : undefined}>
              <Tooltip>{p.label}</Tooltip>
            </Marker>
          ))}
      </MapContainer>
    </div>
  );
}
