import type { MarkerStyle } from "./map-types";

// A map legend entry drawn like its marker: the same outline or ring, and the
// same .eras-marker halo. No Leaflet, so legends render on the server like the
// rest of the page.

function MapSwatch({ color, shape, hollow }: MarkerStyle) {
  return (
    <span
      aria-hidden
      className={`eras-marker inline-block size-3.5 shrink-0 ${shape === "square" ? "rounded-[3px]" : "rounded-full"}`}
      style={hollow ? { border: `3px solid ${color}` } : { background: color, border: "2px solid #fff" }}
    />
  );
}

/** One legend row: the swatch, then its label in foreground text. */
export function MapKey({ label, ...style }: MarkerStyle & { label: string }) {
  return (
    <li className="flex items-center gap-1.5 text-foreground">
      <MapSwatch {...style} />
      {label}
    </li>
  );
}
