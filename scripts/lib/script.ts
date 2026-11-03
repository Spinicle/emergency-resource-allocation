/**
 * Shared plumbing for the scripts in scripts/: loading .env.local with safety
 * guards, and a top-level runner that prints failures without leaking secrets.
 */

export const MYSQL_APP_KEYS = [
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_DATABASE",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
] as const;
export const MYSQL_ADMIN_KEYS = ["MYSQL_ADMIN_USER", "MYSQL_ADMIN_PASSWORD"] as const;
export const MONGO_KEYS = ["MONGODB_URI", "MONGODB_DB"] as const;

type EnvKey =
  | (typeof MYSQL_APP_KEYS)[number]
  | (typeof MYSQL_ADMIN_KEYS)[number]
  | (typeof MONGO_KEYS)[number];

// Scripts run DROP DATABASE / DROP USER as admin, so these names are refused.
const SYSTEM_MYSQL_SCHEMAS = ["mysql", "sys", "information_schema", "performance_schema"];
const SYSTEM_MONGO_DBS = ["admin", "local", "config"];

/** An expected failure: its message is safe and complete, so it's printed as-is. */
export class ScriptError extends Error {}

/**
 * Loads .env.local and returns the requested keys, trimmed. Stops if the file is
 * missing, a key is empty, a key is already set in the shell, or a value is unsafe.
 */
export function loadEnv<K extends EnvKey>(keys: readonly K[]): Record<K, string> {
  // process.loadEnvFile keeps values already set in the shell, so a stale export
  // would silently win over .env.local. Stop and name it instead.
  const fromShell = keys.filter((k) => process.env[k] !== undefined);
  if (fromShell.length > 0) {
    throw new ScriptError(
      `set in your shell, so they would override .env.local: ${fromShell.join(", ")}. Unset them and rerun.`,
    );
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    throw new ScriptError(".env.local not found. Copy .env.example to .env.local and fill it in.");
  }
  const missing = keys.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    throw new ScriptError(`.env.local has no value for: ${missing.join(", ")}`);
  }
  checkValues();
  return Object.fromEntries(keys.map((k) => [k, process.env[k]!.trim()])) as Record<K, string>;
}

/** Guards on whichever of these values .env.local sets, whether or not the script needs them. */
function checkValues(): void {
  const value = (k: EnvKey) => process.env[k]?.trim() ?? "";

  // These end up in identifiers and CLI arguments, so keep them plain.
  for (const k of ["MYSQL_DATABASE", "MYSQL_USER", "MONGODB_DB"] as const) {
    if (value(k) && !/^[A-Za-z0-9_]+$/.test(value(k))) {
      throw new ScriptError(`${k} may only contain letters, digits and underscores.`);
    }
  }
  if (SYSTEM_MYSQL_SCHEMAS.includes(value("MYSQL_DATABASE").toLowerCase())) {
    throw new ScriptError(`MYSQL_DATABASE=${value("MYSQL_DATABASE")} is a MySQL system schema; refusing to use it.`);
  }
  if (SYSTEM_MONGO_DBS.includes(value("MONGODB_DB").toLowerCase())) {
    throw new ScriptError(`MONGODB_DB=${value("MONGODB_DB")} is a MongoDB system database; refusing to use it.`);
  }
  // db:reset drops and recreates the app user with database-level grants only.
  const appUser = value("MYSQL_USER").toLowerCase();
  if (appUser && (appUser === "root" || appUser === value("MYSQL_ADMIN_USER").toLowerCase())) {
    throw new ScriptError(
      "MYSQL_USER must be its own least-privilege account, not root or MYSQL_ADMIN_USER " +
        "(db:reset drops and recreates it).",
    );
  }
}

/** Runs a script's main(); on failure prints one line and sets exit code 1. */
export function runScript(name: string, main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    console.error(`\n${name} failed: ${describe(err)}`);
    process.exitCode = 1;
  });
}

/**
 * One line for a failure. Only the message (plus a driver error code): mysql2
 * errors also carry the SQL text, which can include a password.
 */
function describe(err: unknown): string {
  if (err instanceof ScriptError) return err.message;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
