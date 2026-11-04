// KVERT (Kamchatka) aviation colour codes. Port of parse_kvert_* / collect_kvert.
//
// The KVERT public Telegram mirror is a fallback for the official VAN text, not a claim that the official website is
// always reachable. A bounded recent-post feed cannot establish current codes for volcanoes absent from the feed.
import * as cheerio from "cheerio";
import type { VolcanoIndex } from "@/lib/volcanoes";
import { getText } from "../html";
import { fetchOfficial } from "../http";
import { isoSeconds } from "../time";
import type { AlertInput } from "./types";

export const KVERT_URL = "http://kvert.febras.net/van/";
export const KVERT_ARCHIVE_URL = "http://kvert.febras.net/van/index?type=2";
export const KVERT_MIRROR = "https://t.me/s/ivsfebras_kvert";
export const KVERT_MIRROR_ALT = "https://telegram.me/s/ivsfebras_kvert";

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

type Kvert = AlertInput & { issued_at: string };

/**
 * Parse the KVERT Daily Report: VOLCANO (CAVW #NNNNNN) + Aviation Colour Code.
 *
 * Only codes inside the report's volcano heading are accepted; the legend elsewhere on the page must never be
 * interpreted as an active alert.
 */
export function parseKvertDailyReport(html: string, index: VolcanoIndex, sourceUrl = KVERT_URL): Kvert[] {
  const $ = cheerio.load(html);
  // Report body is a div containing a bold KVERT DAILY REPORT header. Only direct <b> children count, which avoids
  // nested containers that would duplicate the same report.
  const reports = $("div, td")
    .toArray()
    .filter((tag) =>
      $(tag)
        .children("b")
        .toArray()
        .some((b) => getText(b, " ", true).toUpperCase().includes("KVERT DAILY REPORT")),
    );
  const latest = new Map<number, Kvert>();
  for (const report of reports) {
    const header = getText(report, " ", true).slice(0, 220);
    const dateMatch = /\b([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s*,?\s*all time is UTC/i.exec(header);
    if (!dateMatch) continue;
    const month = MONTHS[dateMatch[1].toLowerCase()];
    if (month === undefined) continue;
    const dt = new Date(Date.UTC(+dateMatch[3], month, +dateMatch[2]));
    if (dt.getUTCMonth() !== month || dt.getUTCDate() !== +dateMatch[2]) continue;
    const issuedAt = isoSeconds(dt);
    $(report)
      .find("b")
      .each((_i, bold) => {
        const heading = getText(bold, " ", true);
        const m = /([A-Za-z][A-Za-z\- ]+?)\s+VOLCANO\s*\(\s*CAVW\s*#\s*(\d{6})\s*\)/i.exec(heading);
        const c = /Aviation\s+Colou?r\s+Code\s+is\s*(GREEN|YELLOW|ORANGE|RED)\b/i.exec(heading);
        if (!(m && c)) return;
        const name = m[1].trim();
        const number = m[2];
        const code = c[1].toUpperCase();
        const n = index.resolve({ volcano_number: number, name });
        if (n === null) return;
        const item: Kvert = {
          volcano_number: n,
          alert_type: "aviation_code",
          level: code,
          label: "KVERT " + code,
          issued_at: issuedAt,
          source_url: sourceUrl,
          raw: { name, cavw: number, code, report_date_utc: issuedAt.slice(0, 10), report_type: "daily" },
        };
        const prev = latest.get(n);
        if (!prev || item.issued_at >= prev.issued_at) latest.set(n, item);
      });
  }
  return [...latest.values()];
}

/**
 * Parse both numbered KVERT VANs and newer abbreviated VONA bulletins.
 *
 * Extract one bulletin at a time; choose latest issue per volcano. Never infer current status from a previous colour
 * code or from article prose.
 */
export function parseKvertVans(html: string, index: VolcanoIndex, sourceUrl = KVERT_URL): Kvert[] {
  const daily = parseKvertDailyReport(html, index, sourceUrl);
  if (daily.length) return daily;
  const $ = cheerio.load(html);
  const blocks = $(".tgme_widget_message_text").toArray();
  let texts: string[];
  if (blocks.length) {
    texts = blocks.map((b) => getText(b, "\n", true));
  } else {
    $("script, style, nav, footer").remove();
    const raw = getText($.root().get(0), "\n", true);
    texts = raw.split(/(?=\(1\)\s*KVERT\s+VOLCANIC\s+ACTIVITY\s+NOTICE|\bVONA\s+DTG\s*:)/i);
  }
  const latest = new Map<number, Kvert>();
  for (const text of texts) {
    // Some Telegram messages have multiple bulletins; split on (1).
    for (const notice of text.split(/(?=\(1\)\s*KVERT\s+VOLCANIC\s+ACTIVITY\s+NOTICE)/i)) {
      const numberMatch = /(?:CAVW\s*#|VOLCANO\s*:\s*[^\n]*?\b)(\d{6})\b/i.exec(notice);
      let nameMatch = /\(3\)\s*Volcano\s*:\s*([^\n(]+)/i.exec(notice);
      if (!nameMatch) nameMatch = /\bVOLCANO\s*:\s*([A-Za-z][A-Za-z\- ]+?)\s+\d{6}\b/i.exec(notice);
      const codeMatch = /(?:\(4\)\s*)?Current\s+(?:aviation\s+)?colou?r\s+code\s*:\s*(GREEN|YELLOW|ORANGE|RED)/i.exec(notice);
      const timeMatch = /(?:\(2\)\s*Issued|\bDTG)\s*:\s*(\d{8})\s*\/\s*(\d{4})Z/i.exec(notice);
      if (!(codeMatch && timeMatch && (numberMatch || nameMatch))) continue;
      const name = nameMatch ? nameMatch[1].trim() : "";
      const n = index.resolve({ volcano_number: numberMatch ? numberMatch[1] : null, name });
      if (!n) continue;
      const d = timeMatch[1];
      const t = timeMatch[2];
      const dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4)));
      if (Number.isNaN(dt.getTime()) || dt.getUTCDate() !== +d.slice(6, 8)) continue;
      const code = codeMatch[1].toUpperCase();
      const item: Kvert = {
        volcano_number: n,
        alert_type: "aviation_code",
        level: code,
        label: "KVERT " + code,
        issued_at: isoSeconds(dt),
        source_url: sourceUrl,
        raw: { name, code },
      };
      const prev = latest.get(n);
      if (!prev || item.issued_at > prev.issued_at) latest.set(n, item);
    }
  }
  return [...latest.values()];
}

/**
 * Official site first; archive, then the Telegram mirrors, only when the site yields nothing. A valid official Daily
 * Report is sufficient; avoid overwriting it with a delayed Telegram mirror or stale archive notice.
 */
export async function collectKvert(index: VolcanoIndex): Promise<AlertInput[]> {
  const errors: string[] = [];
  const merged = new Map<number, Kvert>();
  for (const url of [KVERT_URL, KVERT_ARCHIVE_URL, KVERT_MIRROR, KVERT_MIRROR_ALT]) {
    try {
      // The official page is ~2 MB from a server in Russia whose TCP connects often time out (10 s): more time and a
      // second try for it; the mirrors get the normal single try.
      const official = url === KVERT_URL;
      const rows = parseKvertVans(
        await fetchOfficial(url, official ? { timeoutMs: 20_000, tries: 2 } : {}),
        index,
        url,
      );
      if (rows.length) {
        for (const item of rows) {
          const key = Number(item.volcano_number);
          const prev = merged.get(key);
          if (!prev || item.issued_at > prev.issued_at) merged.set(key, item);
        }
        if (url === KVERT_URL) return [...merged.values()];
      } else {
        errors.push(url + ": no recognized notices");
      }
    } catch (err) {
      errors.push(url + ": " + (err instanceof Error ? err.message : String(err)).slice(0, 180));
    }
  }
  if (merged.size) return [...merged.values()];
  throw new Error(errors.join(" | "));
}
