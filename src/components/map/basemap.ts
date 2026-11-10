import { useSyncExternalStore } from "react";

// Which tiles the maps draw. "auto" follows the app's theme, which follows the
// OS (prefers-color-scheme). The choice is shared by every map on the page and
// kept in localStorage, which can be missing or throw (private windows,
// blocked site data): then it's "auto" and simply isn't remembered.

export const BASEMAP_CHOICES = ["auto", "light", "dark", "street"] as const;
export type BasemapChoice = (typeof BASEMAP_CHOICES)[number];
export type Basemap = Exclude<BasemapChoice, "auto">;

const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const STADIA = `&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> ${OSM}`;

// Light and Dark are Stadia's Alidade Smooth styles (CARTO's keyless tiles now
// only return an "API key required" image). Stadia serves localhost without a
// key; any other host needs NEXT_PUBLIC_STADIA_API_KEY from .env.local, which
// ends up in the browser bundle, as Stadia's browser keys are meant to.
const STADIA_KEY = process.env.NEXT_PUBLIC_STADIA_API_KEY?.trim();
const stadia = (style: string) =>
  `https://tiles.stadiamaps.com/tiles/${style}/{z}/{x}/{y}{r}.png${STADIA_KEY ? `?api_key=${encodeURIComponent(STADIA_KEY)}` : ""}`;

/** {r} is "@2x" on high-density screens. */
export const BASEMAPS: Record<Basemap, { url: string; attribution: string; maxZoom: number }> = {
  light: { url: stadia("alidade_smooth"), attribution: STADIA, maxZoom: 20 },
  dark: { url: stadia("alidade_smooth_dark"), attribution: STADIA, maxZoom: 20 },
  street: { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: OSM, maxZoom: 19 },
};

const STORAGE_KEY = "eras.map.basemap";
const isChoice = (value: unknown): value is BasemapChoice => BASEMAP_CHOICES.includes(value as BasemapChoice);

let choice: BasemapChoice | undefined;
const listeners = new Set<() => void>();

function readChoice(): BasemapChoice {
  if (choice === undefined) {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      choice = isChoice(stored) ? stored : "auto";
    } catch {
      choice = "auto";
    }
  }
  return choice;
}

function subscribeChoice(onChange: () => void) {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
}

export function setBasemapChoice(next: BasemapChoice): void {
  choice = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not remembered; this page still switches.
  }
  for (const listener of listeners) listener();
}

/** The saved choice; "auto" until the browser has read it. */
export function useBasemapChoice(): BasemapChoice {
  return useSyncExternalStore(subscribeChoice, readChoice, () => "auto");
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeDark(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True while the OS, and so the app, is in dark mode. Follows changes live. */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(subscribeDark, () => window.matchMedia(DARK_QUERY).matches, () => false);
}
