/**
 * Runs SQL files through the mysql CLI (needed for DELIMITER in routine files)
 * without ever putting a password on the command line.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScriptError } from "./script";

export type MysqlCredentials = { host: string; port: string; user: string; password: string };

/** The CLI stopped on an SQL error. stdout holds whatever it printed before that. */
export class MysqlCliError extends ScriptError {
  constructor(
    message: string,
    readonly stdout: string,
  ) {
    super(message);
  }
}

/**
 * Writes the credentials to a temporary MySQL option file, runs fn with its
 * path, and deletes it afterwards: on return, on any process exit, and on Ctrl+C.
 */
export async function withOptionFile<T>(
  creds: MysqlCredentials,
  fn: (optionFile: string) => Promise<T>,
): Promise<T> {
  const pw = creds.password;
  const quote = pw.includes('"') ? "'" : '"';
  if (pw.includes(quote)) {
    throw new ScriptError("A MySQL password can't contain both ' and \" (option-file limit).");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "eras-mysql-"));
  const file = path.join(dir, "client.cnf");
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const onSigint = () => {
    remove();
    process.exit(130);
  };
  process.on("exit", remove);
  process.once("SIGINT", onSigint);
  try {
    const lines = [
      "[client]",
      `host=${creds.host}`,
      `port=${creds.port}`,
      `user=${creds.user}`,
      `password=${quote}${pw.replaceAll("\\", "\\\\")}${quote}`,
      "",
    ];
    writeFileSync(file, lines.join("\n"), { mode: 0o600 });
    return await fn(file);
  } finally {
    remove();
    process.off("exit", remove);
    process.off("SIGINT", onSigint);
  }
}

/**
 * Feeds one SQL file to the mysql CLI and resolves with its stdout. The CLI stops
 * at the first error; this then rejects with a MysqlCliError carrying the CLI's
 * error text and the output printed before it.
 * table: true prints result sets as boxed tables (for test output).
 */
export function runMysql(
  file: string,
  optionFile: string,
  database: string,
  opts: { table?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "mysql",
      [
        `--defaults-extra-file=${optionFile}`,
        opts.table ? "--table" : "--batch",
        "--default-character-set=utf8mb4",
        database,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "ENOENT"
          ? new ScriptError("mysql CLI not found. Add MySQL Server's bin folder to PATH.")
          : err,
      ),
    );
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      const msg = stderr
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .join("\n");
      reject(new MysqlCliError(msg || `mysql exited with code ${code}`, stdout));
    });
    child.stdin.end(readFileSync(file));
  });
}
