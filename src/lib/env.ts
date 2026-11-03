import "server-only";

/** A required setting from .env.local (Next loads it into process.env). Never logs the value. */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}
