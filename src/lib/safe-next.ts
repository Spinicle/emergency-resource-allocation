// The ?next= target after sign-in, kept on this site. A pure check with no
// imports, so it runs anywhere (the login page today).

const FALLBACK = "/dashboard";

/**
 * value if it's a path on this site, else /dashboard. Refuses //host and /\host
 * (browsers read both as another site), any whitespace or control character
 * ("/\t/evil.com" resolves to //evil.com), and, as a last check, anything that
 * resolves to another origin.
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string") return FALLBACK;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return FALLBACK;
  if (/[\s\p{Cc}]/u.test(value)) return FALLBACK;
  try {
    if (new URL(value, "http://x").origin !== "http://x") return FALLBACK;
  } catch {
    return FALLBACK;
  }
  return value;
}
