// PHIVOLCS (Philippines) alert levels 0-5. Port of parse_phivolcs / collect_phivolcs.
import * as cheerio from "cheerio";
import type { VolcanoIndex } from "@/lib/volcanoes";
import { getText } from "../html";
import { fetchOfficial } from "../http";
import type { AlertInput } from "./types";

export const PHIVOLCS_URL = "https://wovodat.phivolcs.dost.gov.ph/bulletin/list-of-bulletin";

// Volcano Alert Levels 0-5 (names: phivolcs.dost.gov.ph/volcano-alert-levels)
export const PHIVOLCS_LEVEL_NAMES: Record<number, string> = {
  0: "No alert / Normal",
  1: "Low-level unrest",
  2: "Increasing unrest",
  3: "Intensified / magmatic unrest",
  4: "Eruption imminent",
  5: "Hazardous eruption in progress",
};

/**
 * Read the "Alert Level Status" ticker, e.g. <span class="scroll-item">Taal - 1</span>.
 *
 * Only entries whose name resolves to a Philippine volcano in the master and whose level is 0-5 are accepted;
 * anything else is ignored, never guessed.
 */
export function parsePhivolcs(html: string, index: VolcanoIndex): AlertInput[] {
  const $ = cheerio.load(html);
  const rows: AlertInput[] = [];
  $("#scroll-text .scroll-item").each((_i, span) => {
    const m = /^\s*([A-Za-z][A-Za-z\- ]+?)\s*-\s*(\d)\s*$/.exec(getText(span, " ", true));
    if (!m) return;
    const name = m[1].trim();
    const level = parseInt(m[2], 10);
    if (!(level in PHIVOLCS_LEVEL_NAMES)) return;
    const n = index.resolve({ name, country: "Philippines" });
    if (n === null) return;
    rows.push({
      volcano_number: n,
      alert_type: "volcano_level",
      level: String(level),
      label: `PHIVOLCS Alert Level ${level} · ${PHIVOLCS_LEVEL_NAMES[level]}`,
      issued_at: null,
      source_url: PHIVOLCS_URL,
      raw: { name, level },
    });
  });
  return rows;
}

export async function collectPhivolcs(index: VolcanoIndex): Promise<AlertInput[]> {
  const rows = parsePhivolcs(await fetchOfficial(PHIVOLCS_URL), index);
  if (!rows.length) throw new Error("PHIVOLCS layout unrecognized or no matched rows; keeping prior snapshot");
  return rows;
}
