// Volcano master list + the name/number index the alert collectors resolve against.
// Port of load_volcano_master() (volcano_data.py) and VolcanoIndex (volcano_alert_registry.py).
import raw from "@/data/volcanoes.json";
import type { Volcano } from "./types";

export const VOLCANOES: Volcano[] = raw as Volcano[];

/** Master rows that can be drawn on the map. */
export const MAPPABLE_VOLCANOES: Volcano[] = VOLCANOES.filter((v) => v.lat !== null && v.lon !== null);

/** The master calls Sakurajima "Aira"; the UI always says Sakurajima. */
export const displayName = (name: string): string => (name === "Aira" ? "Sakurajima" : name);

const byNumberMap = new Map<number, Volcano>(VOLCANOES.map((v) => [v.n, v]));
export const volcanoByNumber = (n: number): Volcano | undefined => byNumberMap.get(n);

// ── VolcanoIndex ───────────────────────────────────────────

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** lower-case, letters and digits only ("Sakurajima (Aira Caldera)" -> "sakurajimairacaldera") */
export const nameKey = (name: unknown): string =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export class VolcanoIndex {
  private readonly byNumber = new Map<number, { n: number; name: string; country: string }>();
  private readonly byName = new Map<string, Set<number>>();
  // Explicit aliases, only accepted if the target number exists in the master.
  private readonly aliases: Record<string, number> = {
    sakurajima: 282080,
    sakurajimaairacaldera: 282080, // "Sakurajima (Aira Caldera)" -> "sakurajima" + "airacaldera"
    aira: 282080,
    shiveluch: 300270,
    sheveluch: 300270,
  };

  constructor(volcanoes: Volcano[] = VOLCANOES) {
    for (const v of volcanoes) {
      const n = toNumber(v.n);
      if (n === null) continue;
      this.byNumber.set(n, { n, name: v.name, country: v.country });
      const key = nameKey(v.name);
      if (!this.byName.has(key)) this.byName.set(key, new Set());
      this.byName.get(key)!.add(n);
    }
  }

  has(n: number): boolean {
    return this.byNumber.has(n);
  }

  country(n: number): string {
    return this.byNumber.get(n)?.country ?? "";
  }

  /** Volcano number for a number and/or name (country narrows an ambiguous name); null when not unique. */
  resolve(args: { volcano_number?: unknown; name?: unknown; country?: string | null }): number | null {
    const n = toNumber(args.volcano_number);
    if (n !== null) return this.byNumber.has(n) ? n : null;
    const key = nameKey(args.name);
    const alias = this.aliases[key];
    if (alias !== undefined && this.byNumber.has(alias)) return alias;
    let matches = [...(this.byName.get(key) ?? [])];
    if (args.country) {
      const want = args.country.toLowerCase();
      matches = matches.filter((i) => this.byNumber.get(i)!.country.toLowerCase() === want);
    }
    return matches.length === 1 ? matches[0] : null;
  }
}
