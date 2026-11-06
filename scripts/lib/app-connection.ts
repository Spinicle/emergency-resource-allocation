import mysql, { type Connection } from "mysql2/promise";
import type { MYSQL_APP_KEYS } from "./script";

/**
 * A MYSQL_USER connection with the app pool's settings (src/lib/mysql.ts):
 * DATETIMEs as IST wall-clock strings, DECIMALs as numbers.
 */
export function appConnection(env: Record<(typeof MYSQL_APP_KEYS)[number], string>): Promise<Connection> {
  return mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    dateStrings: true,
    decimalNumbers: true,
  });
}
