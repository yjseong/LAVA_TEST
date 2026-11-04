// AlertPayload for the page (port of load_alert_data) and the refresh policy that replaces the 60-second thread.
import { after } from "next/server";
import type { AlertPayload } from "@/lib/types";
import { digest } from "./digest";
import { readAlerts } from "./registry";
import { FAILURE_KEY, refreshSources, SNAPSHOT_KEY, type Snapshot } from "./refresh";
import { getStore, type Store } from "./store";

/** A snapshot older than this is still served, and a refresh is started behind the response. */
export const REFRESH_AFTER_MS = 60_000;
/** Cold start (nothing stored yet): wait this long for the first refresh (the Python app waited 45 s as well). */
export const COLD_START_WAIT_MS = 45_000;

const sleep = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

/** Run work after the response is sent. Outside a request scope (scripts, tests) after() throws: fire and forget. */
export function runInBackground(task: () => Promise<unknown>): void {
  const safe = async () => {
    try {
      await task();
    } catch (err) {
      console.error("[refresh] background task failed:", err);
    }
  };
  try {
    after(safe);
  } catch {
    void safe();
  }
}

/** The payload as stored - no refresh is triggered. */
export async function buildPayload(store: Store = getStore()): Promise<AlertPayload> {
  const [snapshot, registry] = await Promise.all([store.getJson<Snapshot>(SNAPSHOT_KEY), readAlerts(store)]);
  const vaac_rows = snapshot?.vaac_rows ?? [];
  const jma_raw = snapshot?.jma_raw ?? {};
  const jma_issued = snapshot?.jma_issued ?? {};
  const mirova_rows = snapshot?.mirova_rows ?? [];
  // Everything that changes what is DRAWN. Volatile bookkeeping (fetch timestamps, attempt times, error texts) is
  // left out, so an unchanged source does not look like news to the page.
  const sig = digest({
    vaac_rows,
    jma_raw,
    jma_issued,
    mirova_rows,
    by_number: Object.fromEntries(
      Object.entries(registry.by_number).map(([n, rows]) => [n, rows.map(({ fetched_at: _f, ...rest }) => rest)]),
    ),
    source_status: Object.fromEntries(Object.entries(registry.sources).map(([k, v]) => [k, v?.status])),
  });
  return {
    registry,
    vaac_rows,
    jma_raw,
    jma_issued,
    mirova_rows,
    timestamp: snapshot ? snapshot.fetched_at.slice(0, 16) + " UTC" : null,
    sig,
  };
}

/**
 * The page's data, with the refresh policy:
 *  - snapshot fresher than 60 s: return it;
 *  - older: return it AND refresh behind the response (the next request sees the new data);
 *  - nothing stored at all (cold start): wait for the first refresh (at most 45 s), then return what it produced.
 */
export async function getAlertPayload(store: Store = getStore()): Promise<AlertPayload> {
  const snapshot = await store.getJson<Snapshot>(SNAPSHOT_KEY);
  if (!snapshot) {
    const failed = await store.getJson(FAILURE_KEY); // a refresh just failed: do not make every request wait again
    if (!failed) await Promise.race([refreshSources({ store }).catch((err) => console.error("[refresh] failed:", err)), sleep(COLD_START_WAIT_MS)]);
  } else if (Date.now() - snapshot.fetched_ms > REFRESH_AFTER_MS) {
    runInBackground(() => refreshSources({ store }));
  }
  return buildPayload(store);
}

/**
 * Manual "Refresh" button: refresh now (JMA cache 60 s), wait up to `waitMs` for it, then answer with what is there.
 * Rate-limited through the store so the button cannot be hammered: within 15 s of the last forced run the current
 * payload is returned without starting another one. The refresh keeps running after the response if it is slow.
 */
export async function manualRefresh(
  store: Store = getStore(),
  waitMs = 10_000,
): Promise<{ payload: AlertPayload; refreshed: boolean }> {
  const gate = await store.acquireLock("manual-refresh", 15); // never released: it simply expires
  if (!gate) return { payload: await buildPayload(store), refreshed: false };
  const work = refreshSources({ store, force: true }).catch((err) => console.error("[refresh] failed:", err));
  runInBackground(() => work);
  await Promise.race([work, sleep(waitMs)]);
  return { payload: await buildPayload(store), refreshed: true };
}
