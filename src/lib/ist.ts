// MySQL DATETIME values are IST wall-clock strings (docs/HANDOFF.md 4.5, 8);
// MongoDB stores UTC instants. Convert only through these two, never through
// the process time zone (new Date("2026-11-04 10:00:00") reads it as local).
//
// No imports: this file is shared by server code, client code and scripts.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/** "YYYY-MM-DD HH:MM:SS" (IST) → the instant. Throws on anything else, including a Date. */
export function istToDate(value: unknown): Date {
  const m = typeof value === "string" ? DATETIME.exec(value) : null;
  const date = m ? new Date(`${m[1]}T${m[2]}+05:30`) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(`Expected an IST DATETIME string "YYYY-MM-DD HH:MM:SS", got ${JSON.stringify(value)}`);
  }
  return date;
}

/** The instant → "YYYY-MM-DD HH:MM:SS" in IST, for a DATETIME column. Drops milliseconds. */
export function dateToIst(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}
