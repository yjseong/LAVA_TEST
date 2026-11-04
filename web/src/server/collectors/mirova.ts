// MIROVA latest thermal alerts (get_mirova_alerts): ALL volcanoes in the table, with VRP in MW.
import * as cheerio from "cheerio";
import type { MirovaRow } from "@/lib/types";
import { getText } from "../html";
import { fetchText } from "../http";

export const MIROVA_URL = "https://www.mirovaweb.it/NRT/index.php";

// MIROVA IDs for the Python app's "target" volcanoes
export const MIROVA_IDS: Record<number, string> = {
  282110: "Asosan",
  282090: "Kirishimayama",
  282080: "Sakurajima",
};

export function parseMirova(html: string): MirovaRow[] {
  const $ = cheerio.load(html);
  const rows: MirovaRow[] = [];
  // Like the Python code: every <table>, every row but the first (header). Nested tables are visited twice there too.
  $("table").each((_i, table) => {
    $(table)
      .find("tr")
      .slice(1)
      .each((_j, tr) => {
        const cols = $(tr)
          .find("td")
          .toArray()
          .map((td) => getText(td, "", true));
        if (cols.length < 5) return;
        if (!/^[+-]?\d+$/.test(cols[1])) return; // int() raised ValueError -> row skipped
        const volcanoId = parseInt(cols[1], 10);
        const ourName = MIROVA_IDS[volcanoId] ?? null;
        rows.push({
          volcano: cols[2], // original MIROVA name
          our_name: ourName,
          is_target: ourName !== null,
          volcano_id: volcanoId,
          time: cols[0],
          vrp_mw: cols[3],
          sensor: cols.length > 5 ? cols[5] : "",
        });
      });
  });
  return rows;
}

export async function getMirovaAlerts(): Promise<MirovaRow[]> {
  return parseMirova(await fetchText(MIROVA_URL, { timeoutMs: 15_000 }));
}
