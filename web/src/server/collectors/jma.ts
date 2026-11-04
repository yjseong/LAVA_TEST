// JMA volcanic alert levels - WITHOUT Selenium.
//
// The Python app launched headless Chrome, waited 8 s for https://www.jma.go.jp/bosai/map.html#contents=volcano and
// scraped the rendered page. A serverless function cannot run Chrome, and the page is only a viewer for JMA's own
// JSON files, which this module reads directly (the same ones the map's JavaScript requests):
//
//   data/warning.json                one report per volcano under a warning/forecast, newest only
//   const/volcano_dictionary.json    volcano code -> English name (the map's English labels)
//   const/volcano_list.json          same, as a fallback
//
// Shapes match the Python scraper: jma_raw {English name: level}, jma_issued {English name: "YYYY-MM-DD HH:MM UTC"}.
import { fetchText } from "../http";
import { utcMinuteStamp } from "../time";

const BASE = "https://www.jma.go.jp/bosai/volcano/";
export const JMA_WARNING_URL = BASE + "data/warning.json";
const DICTIONARY_URL = BASE + "const/volcano_dictionary.json";
const LIST_URL = BASE + "const/volcano_list.json";
/** Human-facing page (the source link shown in the UI). */
export const JMA_URL = "https://www.jma.go.jp/bosai/map.html#5/34.5/135/&contents=volcano&lang=en";

/** "Eruption warning/forecast (target volcano)" - the block of a report that names the volcano and its level. */
const TARGET_VOLCANO_TYPE = "噴火警報・予報（対象火山）";
/** Reports that are not about one volcano (the map's own code skips these ids). */
const NOT_A_VOLCANO = new Set(["901", "902"]);

/**
 * Alert level a warning "kind" code stands for. This is function q() of the JMA map (map.html), which picks the
 * CSS class volcano-level{N} the Python scraper read: 11/21/35 -> 1, 12/22 -> 2, 13/23/36 -> 3, 14 -> 4, 15/25 -> 5.
 * Codes 2x are the older keyword scheme of volcanoes without an alert-level system (Ioto: 22, Nishinoshima: 22),
 * 35/36 the sea-area wording of submarine volcanoes (Fukutoku-Oka-no-Ba: 36). Anything else is level 0 = not drawn.
 */
export function jmaLevelOfKind(code: string): number {
  switch (code) {
    case "15":
    case "25":
      return 5;
    case "14":
      return 4;
    case "13":
    case "23":
    case "36":
      return 3;
    case "12":
    case "22":
      return 2;
    case "11":
    case "21":
    case "35":
      return 1;
    default:
      return 0;
  }
}

interface JmaReport {
  reportDatetime: string;
  eventId: string;
  volcanoInfos?: { type: string; items?: { name: string; code: string; areas?: { name: string; code: string }[] }[] }[];
}

export interface JmaAlerts {
  raw: Record<string, number>;
  issued: Record<string, string>;
}

/** Pure part: reports + code->name table -> the two Python-shaped dicts. Level 0 (no level) is skipped, like the page. */
export function parseJmaWarnings(reports: JmaReport[], names: ReadonlyMap<string, string>): JmaAlerts {
  const raw: Record<string, number> = {};
  const issued: Record<string, string> = {};
  for (const report of reports) {
    if (NOT_A_VOLCANO.has(report.eventId)) continue;
    const info = report.volcanoInfos?.find((v) => v.type === TARGET_VOLCANO_TYPE);
    const item = info?.items?.[0];
    const area = item?.areas?.[0];
    if (!item || !area) continue;
    const level = jmaLevelOfKind(item.code);
    if (!level) continue;
    // English name as the map's English view writes it ("Sumisujima(Smith Rocks)"), so JMA_NAME_MAP keys still match
    const name = names.get(area.code) || area.name;
    if (name in raw) continue; // the page showed each name once
    const reported = new Date(report.reportDatetime);
    raw[name] = level;
    if (!Number.isNaN(reported.getTime())) issued[name] = utcMinuteStamp(reported); // JST in, UTC out
  }
  return { raw, issued };
}

// code -> English name; a day is plenty, the list of volcanoes hardly ever changes.
const NAMES_TTL_MS = 24 * 3600 * 1000;
let namesCache: { at: number; names: Map<string, string> } | null = null;

async function loadNames(): Promise<Map<string, string>> {
  if (namesCache && Date.now() - namesCache.at < NAMES_TTL_MS) return namesCache.names;
  const [dictionary, list] = await Promise.allSettled([
    fetchText(DICTIONARY_URL, { timeoutMs: 10_000 }).then((t) => JSON.parse(t) as { volcanoes?: { code: string; enName?: string }[] }),
    fetchText(LIST_URL, { timeoutMs: 10_000 }).then((t) => JSON.parse(t) as { code: string; name_en?: string }[]),
  ]);
  const names = new Map<string, string>();
  // The list is the fallback, the dictionary (what the map labels with) wins.
  if (list.status === "fulfilled") for (const v of list.value) if (v.name_en) names.set(v.code, v.name_en);
  if (dictionary.status === "fulfilled") for (const v of dictionary.value.volcanoes ?? []) if (v.enName) names.set(v.code, v.enName);
  if (names.size === 0) {
    if (namesCache) return namesCache.names; // both failed: keep the old table
    return names; // the Japanese names are used then (they will not resolve, which is logged by the caller)
  }
  namesCache = { at: Date.now(), names };
  return names;
}

/** Current JMA alert levels. Throws when JMA is unreachable (the caller keeps its previous values). */
export async function getJmaAlerts(): Promise<JmaAlerts> {
  const [text, names] = await Promise.all([fetchText(JMA_WARNING_URL, { timeoutMs: 15_000, tries: 2 }), loadNames()]);
  const reports = JSON.parse(text) as JmaReport[];
  if (!Array.isArray(reports)) throw new Error("JMA warning.json: unexpected format");
  return parseJmaWarnings(reports, names);
}

/** test hook */
export function _resetJmaNamesCache(): void {
  namesCache = null;
}
