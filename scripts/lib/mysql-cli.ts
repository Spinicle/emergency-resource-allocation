/**
 * Runs SQL files through the mysql CLI (needed for DELIMITER in routine files)
 * without ever putting a password on the command line.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScriptError } from "./script";

/** Who to connect as, and which database the files run in. */
export type MysqlTarget = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
};

/** Runs one SQL file and resolves with its stdout. table: true prints boxed tables. */
export type RunSqlFile = (file: string, opts?: { table?: boolean }) => Promise<string>;

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
 * Gives fn a runner for SQL files against target. The credentials live in a
 * temporary MySQL option file for the duration of fn, deleted afterwards: on
 * return, on any process exit, and on Ctrl+C.
 */
export async function withMysqlCli<T>(
  target: MysqlTarget,
  fn: (runSqlFile: RunSqlFile) => Promise<T>,
): Promise<T> {
  const optionFile = writeOptionFile(target);
  const remove = () => rmSync(path.dirname(optionFile), { recursive: true, force: true });
  const onSigint = () => {
    remove();
    process.exit(130);
  };
  process.on("exit", remove);
  process.once("SIGINT", onSigint);
  try {
    return await fn((file, opts = {}) => runMysql(file, optionFile, target.database, opts.table ?? false));
  } finally {
    remove();
    process.off("exit", remove);
    process.off("SIGINT", onSigint);
  }
}

function writeOptionFile({ host, port, user, password }: MysqlTarget): string {
  const quote = password.includes('"') ? "'" : '"';
  if (password.includes(quote)) {
    throw new ScriptError("A MySQL password can't contain both ' and \" (option-file limit).");
  }
  const file = path.join(mkdtempSync(path.join(tmpdir(), "eras-mysql-")), "client.cnf");
  const lines = [
    "[client]",
    `host=${host}`,
    `port=${port}`,
    `user=${user}`,
    `password=${quote}${password.replaceAll("\\", "\\\\")}${quote}`,
    "",
  ];
  writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  return file;
}

/**
 * Feeds one SQL file to the mysql CLI. The CLI stops at the first error; this
 * then rejects with a MysqlCliError carrying its error text and earlier output.
 */
function runMysql(file: string, optionFile: string, database: string, table: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "mysql",
      [
        `--defaults-extra-file=${optionFile}`,
        table ? "--table" : "--batch",
        "--default-character-set=utf8mb4",
        database,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // If mysql is missing or exits early (first-line error, bad login), writing
    // the file fails with EPIPE; without a handler that crashes Node on
    // macOS/Linux. The real failure is reported by "error" / "close" below.
    child.stdin.on("error", () => {});
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
