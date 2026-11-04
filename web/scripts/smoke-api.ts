// Calls the API route handlers directly (no dev server) against the LIVE sources, with a throwaway file store.
//
//   npx tsx scripts/smoke-api.ts
//   $env:NODE_USE_SYSTEM_CA = "1"; npx tsx scripts/smoke-api.ts     (networks that re-sign HTTPS)
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AlertPayload, EventsResponse } from "@/lib/types";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lava-smoke-"));
  process.env.LAVA_DATA_DIR = dir; // before the store is created
  console.log("store:", path.join(dir, "store.json"));

  const alerts = await import("@/app/api/alerts/route");
  const events = await import("@/app/api/events/route");
  const refresh = await import("@/app/api/refresh/route");
  const cron = await import("@/app/api/cron/refresh/route");

  let t0 = Date.now();
  let res = await alerts.GET(); // cold start: waits for the first refresh
  const first = (await res.json()) as AlertPayload;
  console.log(`\nGET /api/alerts (cold) ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s  cache-control: ${res.headers.get("cache-control")}`);
  console.log(`  timestamp ${first.timestamp}  sig ${first.sig.slice(0, 10)}`);
  console.log(`  vaac_rows ${first.vaac_rows.length}  jma_raw ${Object.keys(first.jma_raw).length}  mirova_rows ${first.mirova_rows.length}`);
  console.log(`  registry: ${Object.keys(first.registry.by_number).length} volcanoes with alerts; sources:`, JSON.stringify(Object.fromEntries(Object.entries(first.registry.sources).map(([k, v]) => [k, v.status]))));

  t0 = Date.now();
  res = await alerts.GET(); // warm: straight from the store
  const second = (await res.json()) as AlertPayload;
  console.log(`\nGET /api/alerts (warm) ${res.status} in ${Date.now() - t0} ms  sig stable: ${second.sig === first.sig}`);

  for (const q of ["days=7", "days=30&number=282080", "days=0"]) {
    t0 = Date.now();
    res = await events.GET(new Request("http://localhost/api/events?" + q));
    const body = (await res.json()) as EventsResponse & { error?: string };
    console.log(`\nGET /api/events?${q} -> ${res.status} in ${Date.now() - t0} ms`, body.error ?? `${body.events.length} events`);
    if (body.events?.[0]) console.log("  newest:", JSON.stringify(body.events[0]).slice(0, 240));
  }

  t0 = Date.now();
  res = await refresh.POST();
  console.log(`\nPOST /api/refresh -> ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s  X-Refresh: ${res.headers.get("x-refresh")}`);
  res = await refresh.POST();
  console.log(`POST /api/refresh again -> ${res.status}  X-Refresh: ${res.headers.get("x-refresh")} (rate limit)`);

  res = await cron.GET(new Request("http://localhost/api/cron/refresh"));
  console.log(`\nGET /api/cron/refresh -> ${res.status}`, JSON.stringify(await res.json()));
  process.env.CRON_SECRET = "s3cret";
  res = await cron.GET(new Request("http://localhost/api/cron/refresh"));
  console.log(`  with CRON_SECRET set, no header -> ${res.status}`);
  res = await cron.GET(new Request("http://localhost/api/cron/refresh", { headers: { authorization: "Bearer s3cret" } }));
  console.log(`  with the right header -> ${res.status}`);

  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
