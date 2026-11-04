// Time helpers shared by the collectors and the registry. Everything is UTC.

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Python's datetime.isoformat(timespec="seconds") for a UTC datetime: 2026-10-30T07:20:22+00:00 */
export function isoSeconds(d: Date = new Date()): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
  );
}

/** "2026-10-30 07:35:56 UTC" (the `fetched_at` format of the Python snapshot) */
export function utcStamp(d: Date = new Date()): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/** "2026-10-16 01:00 UTC" (the `jma_issued` format) */
export function utcMinuteStamp(d: Date): string {
  return utcStamp(d).replace(/:\d{2} UTC$/, " UTC");
}

/** Date.UTC that rejects impossible dates (strptime raises ValueError for them; Date.UTC silently rolls over). */
function strictUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number | null {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi
  ) {
    return null;
  }
  return ms;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The part of pandas.to_datetime(raw, utc=True) the sources need. A string without a zone is taken as UTC
 * (the Python code passed utc=True). Returns epoch ms or null.
 */
function looseParse(raw: string): number | null {
  // 2026-10-12T06:04:00+00:00 | 2026-10-12 06:04 | 2026-10-12
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(raw);
  if (m) {
    const base = strictUtc(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    if (base === null) return null;
    let offsetMin = 0;
    const z = m[7];
    if (z && z.toUpperCase() !== "Z") {
      const sign = z[0] === "-" ? -1 : 1;
      const digits = z.slice(1).replace(":", "");
      offsetMin = sign * (+digits.slice(0, 2) * 60 + +(digits.slice(2, 4) || 0));
    }
    return base - offsetMin * 60_000;
  }
  // MIROVA: 29-Oct-2026 23:24:02
  m = /^(\d{1,2})-([A-Za-z]{3})[A-Za-z]*-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return strictUtc(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  // Oct 21, 2026 06:03
  m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return strictUtc(+m[3], MONTHS[m[1].toLowerCase()], +m[2], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  return null;
}

const VAA_TIME = /(\d{8})[/ ](\d{4})/;

/**
 * Best-effort UTC ISO timestamp from the formats the sources use ('20261012/0604Z', ISO strings,
 * '2026-10-12 06:04 UTC', MIROVA '29-Oct-2026 23:24:02' ...). Port of event_time_iso().
 */
export function eventTimeIso(value: unknown, fallback: string | null = null): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const raw = String(value).trim();
  const m = VAA_TIME.exec(raw);
  let ms: number | null;
  if (m) {
    const d = m[1];
    const t = m[2];
    ms = strictUtc(+d.slice(0, 4), +d.slice(4, 6), +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4));
  } else {
    ms = looseParse(raw.replaceAll(" UTC", ""));
  }
  return ms === null ? fallback : isoSeconds(new Date(ms));
}
