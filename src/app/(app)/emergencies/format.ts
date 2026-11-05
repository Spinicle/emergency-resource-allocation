// Display helpers for /emergencies. Dates go through /allocate's formatIst
// (IST wall-clock strings, never new Date()); these cover the rest.

/** "PARTIALLY_FULFILLED" -> "Partially fulfilled". */
export function humanize(value: string): string {
  const text = value.replaceAll("_", " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "2026-11-05 14:30:00" -> "2026-11-05T14:30", what <input type="datetime-local"> expects. */
export function toDateTimeInput(value: string | null | undefined): string {
  return value ? value.slice(0, 16).replace(" ", "T") : "";
}

/** A path with a query string, leaving out blank values: withQuery("/api/x", { q: "", a: "1" }) -> "/api/x?a=1". */
export function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}
