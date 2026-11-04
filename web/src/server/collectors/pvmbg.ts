// PVMBG (Indonesia) activity levels from MAGMA Indonesia. Port of parse_pvmbg / collect_pvmbg.
//
// No fabricated levels: an unknown HTML format raises, and the caller keeps its previous snapshot.
import * as cheerio from "cheerio";
import type { VolcanoIndex } from "@/lib/volcanoes";
import { getText } from "../html";
import { fetchOfficial } from "../http";
import type { AlertInput } from "./types";

export const PVMBG_URL = "https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas";

// Explicit MAGMA name -> Smithsonian GVP number crosswalk. Do not fuzzy-match.
// Entries are restricted to identifiers present in the supplied volcano master.
export const PVMBG_NAME_ALIASES: Record<string, number> = {
  "anak krakatau": 262000, "anak ranakah": 264071,
  bromo: 263310, "bur ni telong": 261050,
  "ili lewotolok": 264230, "lewotobi laki-laki": 264180,
  "lewotobi perempuan": 264180, lokon: 266100,
  tangkoko: 266130, batutara: 264260,
  dieng: 263200, gede: 263060,
  "ile werung": 264250, lereboleng: 264200,
  "peut sague": 261030, rokatenda: 264150,
  tandikat: 261150,
};

const LEVEL_NAMES = ["", "I (Normal)", "II (Waspada)", "III (Siaga)", "IV (Awas)"];
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };

interface Component {
  name: string;
  level: number;
}

/**
 * Read the MAGMA activity table, including its row-spanned level sections.
 *
 * Only volcano rows containing an official report link are considered. The reported count for each section is
 * checked against the parsed rows; an incomplete or changed page raises rather than replacing a good snapshot.
 */
export function parsePvmbg(html: string, index: VolcanoIndex): AlertInput[] {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();
  let table = tables.find((t) =>
    getText($(t).parent().get(0), " ", true).slice(0, 250).includes("Daftar Tingkat Aktivitas Gunung Api"),
  );
  if (!table) {
    // Restrict fallback to a table explicitly containing activity levels.
    table = tables.find((t) => {
      const text = getText(t, " ", true);
      return text.includes("Level III (Siaga)") && text.includes("Level II (Waspada)");
    });
  }
  if (!table) throw new Error("PVMBG official activity-level table not found");

  let currentLevel: number | null = null;
  const declared: Record<number, number> = {};
  const observed: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const result = new Map<number, AlertInput>();

  $(table)
    .find("tr")
    .each((_i, tr) => {
      const cells = $(tr).children("td").toArray();
      if (!cells.length) return;
      const first = getText(cells[0], " ", true);
      const m = /\bLevel\s*(IV|III|II|I)\s*\((Awas|Siaga|Waspada|Normal)\)/i.exec(first);
      if (m) {
        currentLevel = ROMAN[m[1].toUpperCase()];
        if (cells.length >= 2) {
          const count = getText(cells[1], " ", true);
          if (!/^\d+$/.test(count)) throw new Error("PVMBG level count is not numeric");
          declared[currentLevel] = parseInt(count, 10);
        }
      }
      if (currentLevel === null) return;
      const level = currentLevel;
      for (const td of cells) {
        const hasReportLink = $(td)
          .find("a[href]")
          .toArray()
          .some((a) => /\/gunung-api\/laporan\//.test($(a).attr("href") ?? ""));
        if (!hasReportLink) continue;
        // The volcano's plain text precedes the report link.
        const label = getText(td, " ", true);
        const name = label.split(" - ")[0].trim();
        if (!name || name.toLowerCase().startsWith("lihat laporan")) continue;
        observed[level]++;
        const key = name.replace(/\s+/g, " ").toLowerCase();
        let number = index.resolve({ name, country: "Indonesia" });
        if (number === null && key === "sumbing") {
          // The master contains two Indonesian Sumbing volcanoes.
          number = label.includes("Jawa Tengah") ? 263220 : null;
        }
        if (number === null) {
          const candidate = PVMBG_NAME_ALIASES[key];
          if (candidate !== undefined) number = index.resolve({ volcano_number: candidate });
        }
        if (number === null) continue;
        const entry: AlertInput = {
          volcano_number: number,
          alert_type: "volcano_level",
          level: String(level),
          label: "PVMBG Level " + LEVEL_NAMES[level],
          source_url: PVMBG_URL,
          raw: { name, row: label, level },
        };
        const previous = result.get(number);
        if (!previous) {
          result.set(number, entry);
        } else if (previous.level !== entry.level) {
          // E.g. Lewotobi Laki-laki and Perempuan share one GVP number. A single marker cannot represent both:
          // use the higher level conservatively, while retaining the component-level evidence.
          const prevRaw = previous.raw as { name: string; components?: Component[] };
          const components = (prevRaw.components ??= [{ name: prevRaw.name, level: Number(previous.level) }]);
          components.push({ name, level });
          if (level > Number(previous.level)) {
            (entry.raw as { components?: Component[] }).components = components;
            result.set(number, entry);
          }
        } else {
          const prevRaw = previous.raw as { name: string; components?: Component[] };
          (prevRaw.components ??= [{ name: prevRaw.name, level: Number(previous.level) }]).push({ name, level });
        }
      }
    });

  const complete =
    [1, 2, 3, 4].every((l) => l in declared) && [1, 2, 3, 4].every((l) => observed[l] === declared[l]);
  if (!complete) {
    throw new Error(
      "PVMBG table incomplete: declared=" + JSON.stringify(declared) + ", parsed=" + JSON.stringify(observed),
    );
  }
  if (result.size === 0) throw new Error("PVMBG table parsed but no volcanoes matched the master");
  return [...result.values()];
}

export async function collectPvmbg(index: VolcanoIndex): Promise<AlertInput[]> {
  const rows = parsePvmbg(await fetchOfficial(PVMBG_URL), index);
  if (!rows.length) throw new Error("PVMBG layout unrecognized or no matched rows; keeping prior snapshot");
  return rows;
}
