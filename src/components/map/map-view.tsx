"use client";

import "leaflet/dist/leaflet.css";
import { type DivIcon, divIcon } from "leaflet";
import { cn } from "cn";
import { useEffect } from "react";
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { BASEMAP_CHOICES, BASEMAPS, type BasemapChoice, setBasemapChoice, useBasemapChoice, usePrefersDark } from "./basemap";
import type { ErasMapProps, MapPoint } from "./map-types";

// The Leaflet map itself. Leaflet needs `window`, so only ./index.tsx may import
// this, through next/dynamic with ssr: false. CircleMarker rather than an image
// Marker: Leaflet's default icon images break under bundlers. Squares are Markers
// with a divIcon, which uses no images.

const KARNATAKA = { lat: 12.9, lng: 76.8 };

const SQUARE_SIZE = 14;
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
      border: "1px solid #fff",
      borderRadius: "2px",
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

/** Zooms to the points whenever the set of points changes. */
function FitToPoints({ points }: { points: readonly MapPoint[] }) {
  const map = useMap();
  const ids = points.map((p) => p.id).join("|");
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

export default function MapView({ points, center = KARNATAKA, zoom = 8, fitPoints = true, onMapClick, height = "24rem" }: ErasMapProps) {
  const choice = useBasemapChoice();
  const dark = usePrefersDark();
  const basemap = choice === "auto" ? (dark ? "dark" : "light") : choice;
  const tiles = BASEMAPS[basemap];
  return (
    <div className="relative">
      <BasemapSwitch choice={choice} />
      <MapContainer center={[center.lat, center.lng]} zoom={zoom} style={{ height, width: "100%" }} className="rounded-md border">
        {/* The key swaps the layer whole: react-leaflet doesn't update attribution in place. */}
        <TileLayer key={basemap} url={tiles.url} attribution={tiles.attribution} subdomains={tiles.subdomains} maxZoom={tiles.maxZoom} />
        {fitPoints && <FitToPoints points={points} />}
        {onMapClick && <ClickHandler onMapClick={onMapClick} />}
        {points.map((p) =>
          p.shape === "square" ? (
            <Marker
              key={p.id}
              position={[p.lat, p.lng]}
              icon={squareIcon(p.color)}
              eventHandlers={p.onClick ? { click: p.onClick } : undefined}
            >
              <Tooltip>{p.label}</Tooltip>
            </Marker>
          ) : (
            <CircleMarker
              key={p.id}
              center={[p.lat, p.lng]}
              radius={p.radius ?? 7}
              pathOptions={{ color: p.color, fillColor: p.color, fillOpacity: 0.7, weight: 1 }}
              eventHandlers={p.onClick ? { click: p.onClick } : undefined}
            >
              <Tooltip>{p.label}</Tooltip>
            </CircleMarker>
          ),
        )}
      </MapContainer>
    </div>
  );
}
