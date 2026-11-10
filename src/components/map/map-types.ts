import type { CenterStatus, Severity } from "@/lib/enums";

// The map's props and colours. No Leaflet imports, so server-rendered client
// components can use these without pulling in code that needs `window`.

export type MapPoint = {
  id: string;
  lat: number;
  lng: number;
  /** Any CSS colour, var(--token) included; see severityMarker and centerStatusColor. */
  color: string;
  /** Shown on hover. */
  label: string;
  /** A circle unless set. Squares always draw above circles. */
  shape?: "circle" | "square";
  /** Circles only: just the outline, in `color`. */
  hollow?: boolean;
  /** Circles only. */
  radius?: number;
  /** Circles only, 0-9: a higher rank draws above a lower one. See severityMarker. */
  rank?: number;
  onClick?: () => void;
};

/** How a marker or its legend swatch is drawn. */
export type MarkerStyle = Pick<MapPoint, "color" | "shape" | "hollow">;

export type ErasMapProps = {
  points: readonly MapPoint[];
  /** The starting view. Ignored while fitPoints is on and there are points. */
  center?: { lat: number; lng: number };
  zoom?: number;
  /** Zooms to the points when the set of points changes. */
  fitPoints?: boolean;
  /** With fitPoints: zoom to the points only when this changes, not when points come and go. */
  fitKey?: string;
  /** Pans here, zooming in to at least 13, whenever these coordinates change. */
  focus?: { lat: number; lng: number } | null;
  onMapClick?: (at: { lat: number; lng: number }) => void;
  /** CSS height of the map. */
  height?: string;
};

// The StatusBadge hues (allocate/bits.tsx), stronger so they read on both
// basemaps. Markers get a white outline and a dark halo, which carries the
// lighter fills on the light basemap and the darker ones on the dark one.

const SEVERITY_COLORS: Record<Severity, string> = {
  LOW: "#64748b",
  MODERATE: "#3b82f6",
  HIGH: "#f97316",
  CRITICAL: "#dc2626",
};

/** The hollow ring for an impact with no observation: at least 3:1 on both basemaps. */
const NO_OBSERVATION_COLOR = "#8a8a8a";

/** A severity's marker colour; NO_OBSERVATION_COLOR when there's no observation. */
export function severityColor(severity: Severity | null): string {
  return severity ? SEVERITY_COLORS[severity] : NO_OBSERVATION_COLOR;
}

const SEVERITY_RANK: Record<Severity, number> = { LOW: 1, MODERATE: 2, HIGH: 3, CRITICAL: 4 };

/** How to draw a severity: its colour, CRITICAL on top, and a hollow ring when there's no observation. */
export function severityMarker(severity: Severity | null): MarkerStyle & Pick<MapPoint, "rank"> {
  return { color: severityColor(severity), hollow: severity === null, rank: severity ? SEVERITY_RANK[severity] : 0 };
}

const CENTER_STATUS_COLORS: Record<CenterStatus, string> = {
  OPERATIONAL: "#16a34a",
  LIMITED: "#eab308",
  CLOSED: "#3f3f46",
};

/** A resource center's marker colour. */
export function centerStatusColor(status: CenterStatus): string {
  return CENTER_STATUS_COLORS[status];
}
