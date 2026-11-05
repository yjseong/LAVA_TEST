// Live check of every upstream source, compared with the Python app's snapshot (../original_python/cache/latest_sources.json).
//
//   npx tsx scripts/smoke-sources.ts
//
// On a network that re-signs HTTPS (the institute's), Node needs the OS certificate store:
//   $env:NODE_USE_SYSTEM_CA = "1"; npx tsx scripts/smoke-sources.ts
import fs from "node:fs";
import path from "node:path";
import { VolcanoIndex } from "@/lib/volcanoes";
import { getDarwinVaacTable } from "@/server/collectors/bom";
import { getJmaAlerts } from "@/server/collectors/jma";
import { collectKvert } from "@/server/collectors/kvert";
import { getMirovaAlerts } from "@/server/collectors/mirova";
import { collectPhivolcs } from "@/server/collectors/phivolcs";
import { collectPvmbg } from "@/server/collectors/pvmbg";
import { getVaacRecentList } from "@/server/collectors/tokyo";
import { normalizeJma, normalizeVaac } from "@/server/registry";

const index = new VolcanoIndex();
const python = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "original_python", "cache", "latest_sources.json"), "utf8"));
  } catch {
    return null;
  }
})();

async function step<T>(name: string, fn: () => Promise<T>, show: (v: T) => void): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const v = await fn();
    console.log(`\n== ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    show(v);
    return v;
  } catch (err) {
    console.log(`\n== ${name}  FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

const sample = (rows: unknown[], n = 2) => rows.slice(0, n).forEach((r) => console.log("  ", JSON.stringify(r).slice(0, 260)));
const countBy = <T>(rows: T[], key: (r: T) => string) => {
  const c: Record<string, number> = {};
  for (const r of rows) c[key(r)] = (c[key(r)] ?? 0) + 1;
  return c;
};

async function main() {
  console.log("Python snapshot:", python ? `fetched ${python.fetched_at}` : "(not found)");

  await step("JMA warning.json", getJmaAlerts, (v) => {
    const keys = Object.keys(v.raw);
    console.log("  volcanoes:", keys.length, JSON.stringify(v.raw));
    if (python) {
      const old = Object.keys(python.jma_raw);
      console.log(`  Python had ${old.length}; only-new: ${JSON.stringify(keys.filter((k) => !old.includes(k)))}; only-old: ${JSON.stringify(old.filter((k) => !keys.includes(k)))}`);
      const diffs = keys.filter((k) => k in python.jma_raw && python.jma_raw[k] !== v.raw[k]).map((k) => `${k}: ${python.jma_raw[k]} -> ${v.raw[k]}`);
      console.log("  level changes since the snapshot:", diffs);
    }
    const { alerts, unresolved } = normalizeJma(index, v.raw, v.issued);
    console.log(`  resolved to master: ${alerts.length}/${keys.length}; unresolved: ${JSON.stringify(unresolved)}`);
  });

  await step("BoM VAAC feed (all VAACs)", getDarwinVaacTable, (rows) => {
    console.log("  rows:", rows.length, "(Python snapshot:", python?.vaac_rows?.length, ")  by source:", JSON.stringify(countBy(rows, (r) => r.source)));
    sample(rows);
    const { alerts, unresolved } = normalizeVaac(index, rows);
    console.log(`  non-terminal resolved: ${alerts.length}; unresolved names: ${JSON.stringify([...new Set(unresolved)].slice(0, 8))}`);
  });

  await step("Tokyo VAAC recent list", getVaacRecentList, (rows) => {
    console.log("  advisories:", rows.length, "(Python recorded ~249 'Tokyo VAAC' history rows over weeks)");
    sample(rows);
  });

  await step("MIROVA", getMirovaAlerts, (rows) => {
    console.log("  rows:", rows.length, "(Python snapshot:", python?.mirova_rows?.length, ")  targets:", rows.filter((r) => r.is_target).length);
    sample(rows);
  });

  await step("PVMBG (Indonesia)", () => collectPvmbg(index), (rows) => {
    console.log("  matched volcanoes:", rows.length, "(Python DB: 66)  by level:", JSON.stringify(countBy(rows, (r) => r.level)));
    sample(rows);
  });

  await step("PHIVOLCS (Philippines)", () => collectPhivolcs(index), (rows) => {
    console.log("  matched volcanoes:", rows.length, "(Python DB: 5)  levels:", JSON.stringify(rows.map((r) => (r.raw as { name: string }).name + "=" + r.level)));
  });

  await step("KVERT (Kamchatka)", () => collectKvert(index), (rows) => {
    console.log("  matched volcanoes:", rows.length, "(Python DB: 5)  codes:", JSON.stringify(rows.map((r) => (r.raw as { name: string }).name + "=" + r.level)));
    sample(rows, 1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
