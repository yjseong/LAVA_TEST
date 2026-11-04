// Alert interpretation shared by the markers, the big bubbles and the side panel.
// Port of the decision helpers in pages/home.py (_matches, _vaa_status, _alert_for_volcano, _official_alert,
// build_map_markers ...). Pure functions - no React, no Leaflet - so they are cheap to test.
//
// The Python code compared every volcano with every advisory row by normalising both names each time. Here the
// normalised keys are computed once per payload (prepareAlerts) and then only looked up.
import { JMA_NAME_MAP } from "./jmaNames";
import { timeShort, timeLabel, vaaIssuedDate } from "./format";
import type { AlertEvent, AlertPayload, MirovaRow, RegistryAlert, VaacRow, Volcano } from "./types";
import { VolcanoIndex, displayName } from "./volcanoes";

/** a volcano counts as "VAAC advisory current" for this long after its latest VAA */
export const VAA_WINDOW_HOURS = 24;

// ── Name matching ──────────────────────────────────────────

/** Unicode-aware version of Python's "".join(c for c in s.casefold() if c.isalnum()) */
export const normName = (value: unknown): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

const aliasCache = new Map<string, Set<string>>();

/** Every spelling under which a master volcano name can appear in the sources (normalised). */
export function aliasesOf(name: string): Set<string> {
  let cached = aliasCache.get(name);
  if (cached) return cached;
  const names = new Set<string>([name, name === "Aira" ? "Sakurajima" : name]);
  if (name === "Aira" || name === "Sakurajima") {
    ["Aira", "Sakurajima", "Sakurajima (Aira Caldera)"].forEach((n) => names.add(n));
  }
  for (const [original, mapped] of Object.entries(JMA_NAME_MAP)) {
    if (names.has(mapped)) names.add(original);
  }
  cached = new Set([...names].map(normName));
  aliasCache.set(name, cached);
  return cached;
}

/** `candidateKey` is normName(candidate). */
export function matchesKey(name: string, candidateKey: string): boolean {
  if (aliasesOf(name).has(candidateKey)) return true;
  // Tokyo VAA sometimes appends the caldera name and/or volcano number.
  if (name === "Aira" || name === "Sakurajima") {
    return candidateKey.startsWith("sakurajima") || candidateKey === "aira" || candidateKey.includes("282080");
  }
  return false;
}

export const matches = (name: string, candidate: string): boolean => matchesKey(name, normName(candidate));

// ── Prepared payload ───────────────────────────────────────

interface PreparedVaac { row: VaacRow; key: string; issued: Date | null }
interface PreparedJma { name: string; level: number; key: string; mappedKey: string }
interface PreparedMirova { row: MirovaRow; key: string; vrp: number | null }

export interface PreparedAlerts {
  data: AlertPayload | null;
  /** the "now" the 24 h window was evaluated against (ms since epoch) */
  now: number;
  vaac: PreparedVaac[];
  jma: PreparedJma[];
  jmaIssued: { key: string; mappedKey: string; value: string }[];
  mirova: PreparedMirova[];
}

const parseNumber = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function prepareAlerts(data: AlertPayload | null, now: number): PreparedAlerts {
  const d = data ?? ({} as Partial<AlertPayload>);
  return {
    data,
    now,
    vaac: (d.vaac_rows ?? []).map((row) => ({ row, key: normName(row.volcano), issued: vaaIssuedDate(row.datetime) })),
    jma: Object.entries(d.jma_raw ?? {}).map(([name, level]) => ({
      name, level: Number(level), key: normName(name), mappedKey: normName(JMA_NAME_MAP[name] ?? name),
    })),
    jmaIssued: Object.entries(d.jma_issued ?? {}).map(([name, value]) => ({
      key: normName(name), mappedKey: normName(JMA_NAME_MAP[name] ?? name), value,
    })),
    mirova: (d.mirova_rows ?? []).map((row) => ({
      row, key: normName(row.our_name || row.volcano), vrp: parseNumber(row.vrp_mw),
    })),
  };
}

// ── VAAC advisories ────────────────────────────────────────

export interface VaaStatus {
  /** advisories issued within the last VAA_WINDOW_HOURS (blinking triangle); empty if the latest says "no further advisories" */
  current: VaacRow[];
  /** that latest advisory, when it says "no further advisories": the volcano keeps a quiet, non-blinking bubble for the rest of the 24 hours */
  ended: VaacRow | null;
}

/** Sort key by real issue time; the sources write the time in different formats, so raw strings do not compare. */
export const vaaSortKey = (row: VaacRow): number => vaaIssuedDate(row.datetime)?.getTime() ?? 0;

/**
 * State of one volcano's advisories in BoM's 24-hour feed (all VAACs).
 * A bulletin that appears twice (same issuing VAAC, same volcano, same issue minute) is kept once; it counts as
 * "no further advisories" if any copy says so.
 */
export function vaaStatus(p: PreparedAlerts, name: string): VaaStatus {
  const cutoff = p.now - VAA_WINDOW_HOURS * 3600_000;
  const found = new Map<string, { row: VaacRow; issued: number; terminal: boolean }>();
  for (const v of p.vaac) {
    if (!matchesKey(name, v.key)) continue;
    if (!v.issued || v.issued.getTime() < cutoff) continue;
    const issued = v.issued.getTime();
    const minute = v.issued.toISOString().slice(0, 16);
    const key = `${v.row.source}|${v.key.slice(0, 10)}|${minute}`;
    const hit = found.get(key);
    if (hit) hit.terminal = hit.terminal || Boolean(v.row.is_terminal);
    else found.set(key, { row: v.row, issued, terminal: Boolean(v.row.is_terminal) });
  }
  if (found.size === 0) return { current: [], ended: null };
  const all = [...found.values()];
  const latest = all.reduce((a, b) => (b.issued > a.issued ? b : a));
  if (latest.terminal) return { current: [], ended: latest.row };
  return { current: all.filter((c) => !c.terminal).map((c) => c.row), ended: null };
}

// ── Per-volcano summary values ─────────────────────────────

/** JMA level (0 when none), current VAA rows, highest MIROVA VRP (null when none). */
export function alertForVolcano(p: PreparedAlerts, name: string, status?: VaaStatus) {
  let jma = 0;
  for (const j of p.jma) {
    if (matchesKey(name, j.key) || matchesKey(name, j.mappedKey)) {
      if (Number.isFinite(j.level)) jma = Math.max(jma, j.level);
    }
  }
  const vaa = (status ?? vaaStatus(p, name)).current;
  let vrp: number | null = null;
  for (const m of p.mirova) {
    if (matchesKey(name, m.key) && m.vrp !== null) vrp = vrp === null ? m.vrp : Math.max(vrp, m.vrp);
  }
  return { jma, vaa, vrp };
}

/** The MIROVA row with the highest VRP for this volcano (unparseable VRP ranks last). */
export function mirovaFor(p: PreparedAlerts, name: string): MirovaRow | null {
  let best: PreparedMirova | null = null;
  for (const m of p.mirova) {
    if (!matchesKey(name, m.key)) continue;
    if (!best || (m.vrp ?? -1) > (best.vrp ?? -1)) best = m;
  }
  return best?.row ?? null;
}

export function jmaIssued(p: PreparedAlerts, name: string): string {
  for (const j of p.jmaIssued) {
    if (matchesKey(name, j.mappedKey) || matchesKey(name, j.key)) return timeLabel(j.value);
  }
  return "Issue time unavailable";
}

/** MIROVA volcanic radiative power class -> triangle border colour. */
export function mirovaStyle(vrp: number | string | null | undefined): string | null {
  const value = typeof vrp === "number" ? vrp : parseNumber(vrp);
  if (value === null) return null;
  if (value > 10000) return "#8e44ad";
  if (value >= 1000) return "#e74c3c";
  if (value >= 100) return "#e67e22";
  if (value >= 10) return "#f1c40f";
  return "#2ecc71";
}

// ── Official agency level ──────────────────────────────────

// Level 0 (no alert) is deliberately absent -> transparent marker, like PVMBG level I.
export const OFFICIAL_COLORS: Record<string, Record<string, string>> = {
  JMA: { "2": "#FFD400", "3": "#FF8C00", "4": "#E02020", "5": "#B000B0" },
  PVMBG: { "2": "#FFD400", "3": "#FF8C00", "4": "#B000B0" },
  KVERT: { GREEN: "#2ecc71", YELLOW: "#FFD400", ORANGE: "#FF8C00", RED: "#E02020" },
  PHIVOLCS: { "1": "#FFD400", "2": "#FF8C00", "3": "#E02020", "4": "#B000B0", "5": "#5b0a7a" },
};

let sharedIndex: VolcanoIndex | null = null;
const volcanoIndex = () => (sharedIndex ??= new VolcanoIndex());

/** The alert whose level colours the triangle: the country's own agency first (Japan JMA, Indonesia PVMBG, Philippines PHIVOLCS, Kamchatka KVERT), a fresh record before a stale one. */
export function officialAlert(data: AlertPayload | null, name: string, number?: number | null): RegistryAlert | null {
  try {
    const index = volcanoIndex();
    const n = index.resolve({ volcano_number: number, name });
    if (n === null) return null;
    const records = data?.registry?.by_number?.[String(n)] ?? [];
    const options = records.filter(
      (r) => r.source in OFFICIAL_COLORS && (r.alert_type === "volcano_level" || r.alert_type === "aviation_code"),
    );
    const country = index.country(n).toLowerCase();
    const preferred = country.includes("indonesia") ? "PVMBG" : country.includes("russia") ? "KVERT"
      : country.includes("philippines") ? "PHIVOLCS" : "JMA";
    const rank = (r: RegistryAlert) => (r.source === preferred ? 2 : 0) + (r.stale ? 0 : 1);
    options.sort((a, b) => rank(b) - rank(a));
    return options[0] ?? null;
  } catch {
    return null;
  }
}

export function officialColor(record: RegistryAlert | null): string {
  if (!record || record.stale) return "transparent";
  return OFFICIAL_COLORS[record.source]?.[String(record.level)] ?? "transparent";
}

export function officialLine(record: RegistryAlert | null): string {
  if (!record) return "Official alert: not available";
  return String(record.label || record.source) + (record.stale ? " · STALE (last successful record)" : "");
}

// ── Marker state ───────────────────────────────────────────

export interface MarkerState {
  volcano: Volcano;
  name: string; // display name
  size: number;
  fill: string;
  stroke: string;
  width: number;
  opacity: number;
  /** null: no VAAC bubble. blink: advisory current. ended: "no further advisories" (quiet, grey) */
  bubble: null | { kind: "blink" | "ended"; timeLine: string };
}

/**
 * One state per mappable volcano.
 *  - no alert: small and see-through, so the 1,200+ quiet volcanoes do not compete with the alerts (8 px);
 *  - alert level (or an ended advisory): 18 px;
 *  - VAAC advisory current (blinking): the largest (24 px) with a glow (.marker-blink in home.css).
 */
export function computeMarkerStates(p: PreparedAlerts, volcanoes: Volcano[]): MarkerState[] {
  const out: MarkerState[] = [];
  for (const v of volcanoes) {
    if (v.lat === null || v.lon === null) continue;
    const status = vaaStatus(p, v.name);
    const vaa = status.current;
    const ended = status.ended;
    const { jma, vrp } = alertForVolcano(p, v.name, status);
    const official = officialAlert(p.data, v.name, v.n);
    const fill = officialColor(official);
    const hasBubble = vaa.length > 0 || ended !== null;
    const active = jma >= 2 || hasBubble || vrp !== null || fill !== "transparent";
    const size = vaa.length > 0 ? 24 : active ? 18 : 8;
    const stroke = vrp !== null ? (mirovaStyle(vrp) ?? "#ffffff") : "#ffffff";
    const width = vrp !== null ? 3.4 : active ? 1.7 : 2.4;
    let bubble: MarkerState["bubble"] = null;
    if (hasBubble) {
      // the small bubble names the volcano and the time of the LATEST advisory
      const latest = vaa.length > 0 ? vaa.reduce((a, b) => (vaaSortKey(b) > vaaSortKey(a) ? b : a)) : ended!;
      bubble = {
        kind: vaa.length > 0 ? "blink" : "ended",
        timeLine: "VAAC " + timeShort(latest.datetime) + (vaa.length > 0 ? "" : " · final"),
      };
    }
    out.push({ volcano: v, name: displayName(v.name), size, fill, stroke, width, opacity: active ? 1 : 0.5, bubble });
  }
  return out;
}

// ── Alert history ──────────────────────────────────────────

export function eventColor(e: Pick<AlertEvent, "source" | "level" | "kind">): string {
  const source = e.source || "";
  const level = String(e.level ?? "");
  if (OFFICIAL_COLORS[source]?.[level]) return OFFICIAL_COLORS[source][level];
  if (e.kind === "vaa" || source.includes("VAA")) return "#b42318";
  if (source === "MIROVA") return mirovaStyle(level) ?? "#667085";
  return "#667085";
}

export interface AlertGroup { number: number; name: string; items: AlertEvent[] }

/**
 * "Active alerts" cards: one group per volcano, newest first (events arrive newest first). Normal status is
 * not an active alert. `count` is the number of volcanoes (the tab badge); at most 100 cards are shown.
 */
export function groupActiveAlerts(events: AlertEvent[], names: Map<number, string>): { cards: AlertGroup[]; count: number } {
  const groups = new Map<number, AlertEvent[]>();
  for (const e of events) {
    const level = String(e.level ?? "");
    if ((e.source === "PVMBG" && level === "1") || (e.source === "KVERT" && level === "GREEN") ||
        (e.source === "PHIVOLCS" && level === "0")) continue;
    const list = groups.get(e.volcano_number);
    if (list) list.push(e);
    else groups.set(e.volcano_number, [e]);
  }
  const sorted = [...groups.entries()].sort((a, b) => (a[1][0].event_time < b[1][0].event_time ? 1 : a[1][0].event_time > b[1][0].event_time ? -1 : 0));
  return {
    cards: sorted.slice(0, 100).map(([number, items]) => ({ number, name: names.get(number) ?? `Volcano ${number}`, items })),
    count: groups.size,
  };
}
