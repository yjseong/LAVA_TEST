// Time parsing / labels. Port of _time_label, _time_short and _vaa_issued_dt (pages/home.py).
// Everything is UTC; the sources write times in several formats ("20261012/0604Z", ISO strings,
// "2026-10-12 06:04 UTC"), so the parsing is explicit instead of relying on Date.parse.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

const VAA_TIME = /(\d{8})[/ ](\d{4})(?:Z)?/;
const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i;
// MIROVA writes its observation time as "29-Oct-2026 13:12:00" (UTC)
const MIROVA_LIKE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * "2026-10-12T06:04:00+00:00", "2026-10-12 06:04 UTC", "29-Oct-2026 13:12:00" -> Date, or null.
 * A string without a zone counts as UTC. Date.parse is NOT used for such strings: it reads them in the viewer's
 * local time zone, which shifted every MIROVA time by the browser's UTC offset.
 */
export function parseUtc(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const mv = MIROVA_LIKE.exec(s);
  if (mv) {
    const month = MONTHS.findIndex((m) => m.toLowerCase() === mv[2].toLowerCase());
    if (month < 0) return null;
    return new Date(Date.UTC(+mv[3], month, +mv[1], +mv[4], +mv[5], mv[6] ? +mv[6] : 0));
  }
  const m = ISO_LIKE.exec(s);
  if (m) {
    let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    const zone = m[7];
    if (zone && /^[+-]/.test(zone)) {
      const digits = zone.replace(":", "");
      const offsetMin = (+digits.slice(1, 3)) * 60 + +digits.slice(3, 5);
      ms -= (zone[0] === "-" ? -1 : 1) * offsetMin * 60_000;
    }
    return new Date(ms);
  }
  // Any other format is only trusted when it names its own zone ("... GMT", "...Z", "+0900").
  if (!/(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})\s*$/i.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Issue time of an advisory as a Date (UTC), or null. */
export function vaaIssuedDate(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  const m = VAA_TIME.exec(raw);
  if (m) {
    const d = m[1];
    const t = m[2];
    return new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4)));
  }
  return parseUtc(raw);
}

const dateOf = (value: unknown): Date | null => {
  const raw = String(value ?? "").trim();
  return VAA_TIME.test(raw) ? vaaIssuedDate(raw) : parseUtc(raw);
};

/** "Oct 20, 2026 20:52 UTC" */
export function timeLabel(value: unknown): string {
  if (!value) return "Time not available";
  const d = dateOf(value);
  if (!d) return String(value).trim();
  return `${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())}, ${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** Compact form for the small bubbles: "Oct 20 20:52Z" */
export function timeShort(value: unknown): string {
  const d = value ? dateOf(value) : null;
  if (!d) return timeLabel(value);
  return `${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}Z`;
}
