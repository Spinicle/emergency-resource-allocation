import type { CSSProperties } from "react";

// A map legend entry drawn like its marker: a white outline with a dark halo
// (filled circle or square), or just a ring for a hollow circle. No Leaflet, so
// legends render on the server like the rest of the page.

const HALO = "0 0 0 0.5px rgb(0 0 0 / 0.55), 0 0 3px rgb(0 0 0 / 0.5)";

export function MapSwatch({ color, shape = "circle", hollow = false }: { color: string; shape?: "circle" | "square"; hollow?: boolean }) {
  const style: CSSProperties = hollow
    ? { border: `3px solid ${color}`, boxShadow: `${HALO}, inset ${HALO}` }
    : { background: color, border: "2px solid #fff", boxShadow: HALO };
  return <span aria-hidden className={`inline-block size-3.5 shrink-0 ${shape === "square" ? "rounded-[3px]" : "rounded-full"}`} style={style} />;
}

/** One legend row: the swatch, then its label in foreground text. */
export function MapKey({ label, color, shape, hollow }: { label: string; color: string; shape?: "circle" | "square"; hollow?: boolean }) {
  return (
    <li className="flex items-center gap-1.5 text-foreground">
      <MapSwatch color={color} shape={shape} hollow={hollow} />
      {label}
    </li>
  );
}
