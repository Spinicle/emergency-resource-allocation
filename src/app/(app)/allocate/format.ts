// Display helpers for /allocate. MySQL DATETIME / DATE values arrive as IST
// wall-clock strings; they're shown as written, never through new Date(),
// which would read them in the browser's time zone.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-05 09:08:45" -> "5 Nov 09:08"; "2026-11-05" -> "5 Nov 2026". */
export function formatIst(value: string | null): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value);
  if (!m) return value;
  const [, y, mo, d, hh, mm] = m;
  const day = `${Number(d)} ${MONTHS[Number(mo) - 1]}`;
  return hh ? `${day} ${hh}:${mm}` : `${day} ${y}`;
}

const qty = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

/** A quantity with up to 2 decimals and Indian digit grouping. */
export function formatQty(value: number): string {
  return qty.format(value);
}

/** Whole cents, so sums and comparisons of 2-dp quantities are exact. */
export function toCents(value: number): number {
  return Math.round(value * 100);
}
