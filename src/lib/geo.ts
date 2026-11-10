// Distances and grid ids for the location picker. No imports, so the browser,
// scripts and the server can all use it.

export type LatLng = { lat: number; lng: number };

/** Great-circle (haversine) distance in km, R = 6371 like fn_distance_km. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The closest of `places` to `point` within maxKm, with its distance; null if none is that close. */
export function nearest<T extends LatLng>(places: readonly T[], point: LatLng, maxKm: number): { place: T; km: number } | null {
  let best: { place: T; km: number } | null = null;
  for (const place of places) {
    const km = distanceKm(place, point);
    if (km <= maxKm && (!best || km < best.km)) best = { place, km };
  }
  return best;
}

/** location.grid_id is VARCHAR(50). */
export const GRID_ID_MAX = 50;

/** Uppercase, with every run of spaces and punctuation as one hyphen, none at the ends: "hsr layout, 2" -> "HSR-LAYOUT-2". */
export function gridPart(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** A grid id's prefix, the part before its first hyphen ("KDG-MADIKERI" -> "KDG"); null without one. */
export function gridPrefix(gridId: string): string | null {
  const cut = gridId.indexOf("-");
  return cut > 0 ? gridId.slice(0, cut) : null;
}

/** <PREFIX>-<AREA>, at most GRID_ID_MAX characters; either part may be blank. */
export function gridIdFor(prefix: string, area: string): string {
  const id = [gridPart(prefix), gridPart(area)].filter(Boolean).join("-");
  return Array.from(id).slice(0, GRID_ID_MAX).join("").replace(/-+$/, "");
}

/** The same grid id as the database sees it: utf8mb4_0900_ai_ci ignores case and accents. */
export function sameGridId(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), "en", { sensitivity: "base" }) === 0;
}
