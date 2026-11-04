// Tokyo VAAC "Recent Advisories" list (get_vaac_recent_list): about 6 weeks of issued VAAs.
//
// The front page only shows advisories that are active right now (often none), so this list is the source for the
// alert history of the last 7/30 days. The hidden first column holds the issue time in UTC (YYYY/MM/DD HH:MM:SS).
import * as cheerio from "cheerio";
import type { VaacRow } from "@/lib/types";
import { getText } from "../html";
import { fetchText } from "../http";
import { isoSeconds } from "../time";

export const VAAC_URL = "https://www.data.jma.go.jp/vaac/data/index.html";
export const VAAC_LIST_URL = "https://www.data.jma.go.jp/vaac/data/vaac_list.html";

export function parseTokyoRecentList(html: string): VaacRow[] {
  const $ = cheerio.load(html);
  const rows: VaacRow[] = [];
  $("tbody#tbd1 tr").each((_i, tr) => {
    const td = $(tr).children("td").toArray();
    if (td.length < 6) return;
    const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(getText(td[0], "", true));
    if (!m) return;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const href = $(td[5]).find("a[href]").first().attr("href");
    rows.push({
      volcano: getText(td[2], " ", true),
      area: getText(td[3], " ", true),
      advisory: getText(td[4], "", true),
      eruption: "",
      datetime: isoSeconds(new Date(ms)),
      detail_url: href ? new URL(href, VAAC_LIST_URL).toString() : null,
      source: "Tokyo VAAC",
      issuer: "TOKYO",
      eruption_details: "",
      next_advisory: "",
      is_terminal: false,
    });
  });
  return rows;
}

export async function getVaacRecentList(): Promise<VaacRow[]> {
  const html = await fetchText(VAAC_LIST_URL, { timeoutMs: 20_000 });
  return parseTokyoRecentList(html);
}
