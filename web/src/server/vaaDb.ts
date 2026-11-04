// Optional: month-long VAA history of one volcano from the institute's advisory database (get_vaa_history).
//
// The database lives on the institute network; Vercel cannot reach it unless it is exposed to the internet. So this is
// OFF unless VAA_DB_URL (mysql://user:password@host:3306/VAAC) is set, and it is best effort: any error returns [].
import { isoSeconds } from "./time";

export interface VaaHistoryRow {
  event_time: string; // ISO 8601 UTC
  detail: string;
}

export const vaaDbConfigured = (): boolean => !!process.env.VAA_DB_URL;

const pad = (n: number) => String(n).padStart(2, "0");
const sqlUtc = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/** Recent VAA records for one volcano; [] if the DB is unset or unreachable. Short timeouts: the UI never hangs on it. */
export async function getVaaHistory(volcanoNumber: number, days = 30): Promise<VaaHistoryRow[]> {
  const url = process.env.VAA_DB_URL;
  if (!url) return [];
  let conn: import("mysql2/promise").Connection | undefined;
  try {
    const mysql = await import("mysql2/promise");
    const u = new URL(url);
    conn = await mysql.createConnection({
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
      charset: "utf8mb4",
      timezone: "Z", // date_time is stored in UTC
      connectTimeout: 4000,
    });
    const since = sqlUtc(new Date(Date.now() - days * 86_400_000));
    const [rows] = await conn.query(
      {
        sql:
          "SELECT date_time, eruption_details FROM volcano_ash_advisory " +
          "WHERE volcano_number = ? AND date_time >= ? ORDER BY date_time DESC LIMIT 100",
        timeout: 8000,
      },
      [Math.trunc(volcanoNumber), since],
    );
    return (rows as { date_time: Date; eruption_details: string | null }[]).map((r) => ({
      event_time: isoSeconds(new Date(r.date_time)),
      detail: String(r.eruption_details ?? ""),
    }));
  } catch (err) {
    console.error("[get_vaa_history]", err instanceof Error ? err.message : err);
    return [];
  } finally {
    await conn?.end().catch(() => {});
  }
}
