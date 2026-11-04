// VAAC advisories from BoM's 24-hour text feed (get_darwin_vaac_table in volcano_data.py).
//
// BoM's feed carries the bulletins of ALL VAACs (Darwin, Washington, Wellington, Tokyo ...), so this one source is
// all Home needs for the VAAC part. The older darwin-va-advisory.shtml can show stale "Nil current" HTML; do not use
// it to suppress results from the live product feed.
import * as cheerio from "cheerio";
import type { VaacRow } from "@/lib/types";
import { getText } from "../html";
import { fetchText } from "../http";

export const DARWIN_LATEST_URL = "https://www.bom.gov.au/products/Volc_ash_latest.shtml";
export const DARWIN_WARNINGS_URL = "https://www.bom.gov.au/aviation/warnings/volcanic-ash/";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Python str.title() for the all-caps issuer names ("BUENOS AIRES" -> "Buenos Aires"). */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
}

/** Parse one ICAO VAA bulletin; only identified volcanoes are returned. */
export function parseDarwinVaa(text: string, detailUrl: string | null = null): VaacRow | null {
  const field = (key: string): string => {
    const m = new RegExp("^\\s*" + escapeRe(key) + "\\s*:\\s*(.*)$", "im").exec(text);
    return m ? m[1].trim() : "";
  };
  const volcanoField = field("VOLCANO");
  if (!volcanoField) return null;
  const volcano = volcanoField.replace(/\s+\d{6}\s*$/, "").trim();
  const advisory = field("ADVISORY NR");
  const dtg = field("DTG");
  const details = field("ERUPTION DETAILS");
  const nextAdv = field("NXT ADVISORY");
  // Each bulletin names its issuing centre in the "VAAC:" line: use it as the source, instead of calling everything
  // "Darwin VAAC".
  const issuer = field("VAAC");
  const source = issuer ? titleCase(issuer) + " VAAC" : "Darwin VAAC";
  return {
    volcano,
    advisory,
    eruption: details,
    datetime: dtg,
    detail_url: detailUrl,
    source,
    issuer,
    eruption_details: details,
    next_advisory: nextAdv,
    is_terminal: /NO FURTHER ADVISOR/i.test(nextAdv),
  };
}

/** Split a concatenated BoM bulletin feed at each "VA ADVISORY" header. */
export function parseDarwinBulletins(pageText: string, detailUrl: string | null): VaacRow[] {
  const blocks = pageText.split(/^\s*VA ADVISORY\s*$/im);
  const rows: VaacRow[] = [];
  for (const block of blocks.slice(1)) {
    // The next bulletin's "Received" header may occur before its VA ADVISORY.
    const row = parseDarwinVaa(block, detailUrl);
    if (row && row.datetime && row.advisory) rows.push(row);
  }
  return rows;
}

/** Page text the way BeautifulSoup(...).get_text("\n", strip=True) gives it, script/style removed. */
export function bulletinText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style").remove();
  return getText($.root().get(0), "\n", true);
}

/** Bulletins of the last 24 hours from every VAAC. Throws only when no feed could be read at all. */
export async function getDarwinVaacTable(): Promise<VaacRow[]> {
  const errors: string[] = [];
  let reachable = false;
  const unique = new Map<string, VaacRow>();
  for (const url of [DARWIN_LATEST_URL, DARWIN_WARNINGS_URL]) {
    try {
      const html = await fetchText(url, { timeoutMs: 20_000, headers: { "Cache-Control": "no-cache" } });
      reachable = true;
      const rows = parseDarwinBulletins(bulletinText(html), url);
      if (rows.length) {
        for (const row of rows) unique.set(`${row.volcano.toLowerCase()}|${row.advisory}|${row.datetime}`, row);
        break; // first working official feed wins
      }
      errors.push(`${url}: no parsable bulletins`);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!reachable) throw new Error("BoM VAAC feed unavailable: " + errors.join(" | "));
  return [...unique.values()];
}
