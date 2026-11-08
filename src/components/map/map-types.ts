import type { Severity } from "@/lib/enums";

// The map's props and colours. No Leaflet imports, so server-rendered client
// components can use these without pulling in code that needs `window`.

export type MapPoint = {
  id: string;
  lat: number;
  lng: number;
  /** Any CSS colour; see severityColor. */
  color: string;
  /** Shown on hover. */
  label: string;
  radius?: number;
  onClick?: () => void;
};

export type ErasMapProps = {
  points: readonly MapPoint[];
  /** The starting view. Ignored while fitPoints is on and there are points. */
  center?: { lat: number; lng: number };
  zoom?: number;
  /** Zooms to the points when the set of points changes. */
  fitPoints?: boolean;
  onMapClick?: (at: { lat: number; lng: number }) => void;
  /** CSS height of the map. */
  height?: string;
};

const SEVERITY_COLORS: Record<Severity, string> = {
  LOW: "#64748b",
  MODERATE: "#0284c7",
  HIGH: "#d97706",
  CRITICAL: "#dc2626",
};

/** A severity's marker colour; grey-blue when there's no observation. */
export function severityColor(severity: Severity | null): string {
  return severity ? SEVERITY_COLORS[severity] : "#94a3b8";
}
