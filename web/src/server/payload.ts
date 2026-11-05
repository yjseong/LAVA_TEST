// AlertPayload for the page (port of load_alert_data) and the refresh policy that replaces the 60-second thread.
import { after } from "next/server";
import type { AlertPayload } from "@/lib/types";
import { digest } from "./digest";
import { alertsFromBlob, REGISTRY_KEY, type RegistryBlob } from "./registry";
import { FAILURE_KEY, refreshSources, SNAPSHOT_KEY, type Snapshot } from "./refresh";
import { getStore, type Store } from "./store";

/**
 * A snapshot older than this is still served, and a refresh is started behind the response.
 * The Python app refreshed every 60 s. Here 5 minutes: the free Upstash plan allows 500K commands a month, and every
 * refresh costs a handful (VAAs are issued every few hours per volcano, so a 5-minute lag is invisible).
 * The "Refresh" button still refreshes at once.
 */
export const REFRESH_AFTER_MS = 5 * 60_000;
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

/** Snapshot + registry in ONE command (MGET): Upstash bills per command, and every visitor request starts here. */
async function readState(store: Store): Promise<{ snapshot: Snapshot | null; registry: RegistryBlob | null }> {
  const [snapshot, registry] = await store.getManyJson<Snapshot | RegistryBlob>([SNAPSHOT_KEY, REGISTRY_KEY]);
  return { snapshot: snapshot as Snapshot | null, registry: registry as RegistryBlob | null };
}

/** The payload as stored - no refresh is triggered. */
export async function buildPayload(store: Store = getStore()): Promise<AlertPayload> {
  return payloadFrom(await readState(store));
}

function payloadFrom({ snapshot, registry: registryBlob }: { snapshot: Snapshot | null; registry: RegistryBlob | null }): AlertPayload {
  const registry = alertsFromBlob(registryBlob);
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
 *  - snapshot fresher than REFRESH_AFTER_MS: return it (one Redis command in total);
 *  - older: return it AND refresh behind the response (the next request sees the new data);
 *  - nothing stored at all (cold start): wait for the first refresh (at most 45 s), then return what it produced.
 */
export async function getAlertPayload(store: Store = getStore()): Promise<AlertPayload> {
  const state = await readState(store);
  const { snapshot } = state;
  if (!snapshot) {
    const failed = await store.getJson(FAILURE_KEY); // a refresh just failed: do not make every request wait again
    if (!failed) await Promise.race([refreshSources({ store }).catch((err) => console.error("[refresh] failed:", err)), sleep(COLD_START_WAIT_MS)]);
    return buildPayload(store); // the refresh wrote new state
  }
  if (Date.now() - snapshot.fetched_ms > REFRESH_AFTER_MS) runInBackground(() => refreshSources({ store }));
  return payloadFrom(state);
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
