"use client";

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import type { ErasMapProps, MapPoint } from "./map-types";

// The Leaflet map itself. Leaflet needs `window`, so only ./index.tsx may import
// this, through next/dynamic with ssr: false. CircleMarker rather than Marker:
// Leaflet's default icon images break under bundlers.

const KARNATAKA = { lat: 12.9, lng: 76.8 };

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

export default function MapView({ points, center = KARNATAKA, zoom = 8, fitPoints = true, onMapClick, height = "24rem" }: ErasMapProps) {
  return (
    <MapContainer center={[center.lat, center.lng]} zoom={zoom} style={{ height, width: "100%" }} className="rounded-md border">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {fitPoints && <FitToPoints points={points} />}
      {onMapClick && <ClickHandler onMapClick={onMapClick} />}
      {points.map((p) => (
        <CircleMarker
          key={p.id}
          center={[p.lat, p.lng]}
          radius={p.radius ?? 7}
          pathOptions={{ color: p.color, fillColor: p.color, fillOpacity: 0.7, weight: 1 }}
          eventHandlers={p.onClick ? { click: p.onClick } : undefined}
        >
          <Tooltip>{p.label}</Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
