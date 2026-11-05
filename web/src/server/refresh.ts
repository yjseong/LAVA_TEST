// Source refresh. Port of _refresh_sources() in pages/home.py.
//
// Python ran this in a daemon thread every 60 s. A serverless function has no resident thread, so it is triggered
// instead (see payload.ts: a request that finds the snapshot older than REFRESH_AFTER_MS (5 min) schedules it with after(); a Vercel Cron
// may call /api/cron/refresh too). The in-process _REFRESH_LOCK became a Store lock, and the in-process memory of
// "what did we save last" (_LAST_REGISTRY_KEY, _LAST_RECENT_KEY, the JMA cache) lives in the snapshot.
import type { MirovaRow, VaacRow } from "@/lib/types";
import { VolcanoIndex } from "@/lib/volcanoes";
import { collectKvert } from "./collectors/kvert";
import { collectPhivolcs } from "./collectors/phivolcs";
import { collectPvmbg } from "./collectors/pvmbg";
import { getDarwinVaacTable } from "./collectors/bom";
import { getJmaAlerts, type JmaAlerts } from "./collectors/jma";
import { getMirovaAlerts, MIROVA_URL } from "./collectors/mirova";
import { getVaacRecentList } from "./collectors/tokyo";
import type { AlertInput } from "./collectors/types";
import { digest } from "./digest";
import { normalizeJma, normalizeVaac, RegistryTx } from "./registry";
import { getStore, type Store } from "./store";
import { isoSeconds, utcStamp } from "./time";

/** What the Python app kept in cache/latest_sources.json (plus the bookkeeping that used to live in process memory). */
export interface Snapshot {
  vaac_rows: VaacRow[];
  jma_raw: Record<string, number>;
  jma_issued: Record<string, string>;
  mirova_rows: MirovaRow[];
  /** "YYYY-MM-DD HH:MM:SS UTC" */
  fetched_at: string;
  fetched_ms: number;
  jma_fetched_ms?: number;
  /** digest of what was last written to the registry (JMA / VAAC / MIROVA): skip the DB writes when unchanged */
  reg_key?: string;
  /** digest of the Tokyo advisory list that was last recorded as history */
  recent_key?: string;
  pruned_ms?: number;
}

export const SNAPSHOT_KEY = "latest";
export const FAILURE_KEY = "refresh-failure";
const LOCK_KEY = "refresh";
const LOCK_TTL_SEC = 120;
/** JMA's data is cheap now, but the spec keeps its 10-minute cache (60 s after a manual refresh). */
const JMA_TTL_SEC = 600;
const JMA_FORCED_TTL_SEC = 60;
/** PVMBG / KVERT / PHIVOLCS are polled every 30 min; after a failed attempt they are retried after 5 min. */
const OFFICIAL_INTERVAL_MIN = 30;
const OFFICIAL_RETRY_MIN = 5;
const OFFICIAL_COLD_START_MS = 15_000;
/** History older than this is dropped (the UI shows 7 and 30 days). */
const RETENTION_DAYS = Number(process.env.LAVA_EVENT_RETENTION_DAYS) > 0 ? Number(process.env.LAVA_EVENT_RETENTION_DAYS) : 45;
const PRUNE_EVERY_MS = 6 * 3600 * 1000;

export interface RefreshDeps {
  getDarwinVaacTable: () => Promise<VaacRow[]>;
  getVaacRecentList: () => Promise<VaacRow[]>;
  getJmaAlerts: () => Promise<JmaAlerts>;
  getMirovaAlerts: () => Promise<MirovaRow[]>;
  official: Record<string, (index: VolcanoIndex) => Promise<AlertInput[]>>;
}

const defaultDeps: RefreshDeps = {
  getDarwinVaacTable,
  getVaacRecentList,
  getJmaAlerts,
  getMirovaAlerts,
  official: { PVMBG: collectPvmbg, KVERT: collectKvert, PHIVOLCS: collectPhivolcs },
};

/** tests: replace some collectors for every refreshSources() call (pass undefined to restore the real ones) */
let testDeps: Partial<RefreshDeps> | undefined;
export function _setTestDeps(deps: Partial<RefreshDeps> | undefined): void {
  testDeps = deps;
}

export interface RefreshResult {
  status: "refreshed" | "skipped" | "failed";
  reason?: string;
  durationMs: number;
  /** source -> error text, for the sources that failed this time (their previous values were kept) */
  errors: Record<string, string>;
  fetched_at?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface RefreshOptions {
  /** manual refresh: JMA cache window shortens to 60 s */
  force?: boolean;
  store?: Store;
  index?: VolcanoIndex;
  deps?: Partial<RefreshDeps>;
}

let sharedIndex: VolcanoIndex | null = null;

/**
 * Fetch every source in parallel, update the registry and publish the snapshot. One refresh at a time (store lock):
 * a second caller gets status "skipped" and simply reads the snapshot the first one is writing.
 */
export async function refreshSources(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const store = opts.store ?? getStore();
  const deps: RefreshDeps = { ...defaultDeps, ...testDeps, ...opts.deps };
  const index = opts.index ?? (sharedIndex ??= new VolcanoIndex());
  const started = Date.now();

  const release = await store.acquireLock(LOCK_KEY, LOCK_TTL_SEC);
  if (!release) return { status: "skipped", reason: "another refresh is running", durationMs: 0, errors: {} };

  const errors: Record<string, string> = {};
  try {
    const nowDate = new Date();
    const now = isoSeconds(nowDate);
    const [tx, prev] = await Promise.all([RegistryTx.open(store), store.getJson<Snapshot>(SNAPSHOT_KEY)]);

    // PVMBG / KVERT / PHIVOLCS keep their 30-minute throttle; after a failed attempt try again soon (5 min) instead
    // of waiting the full interval.
    const dueOfficial: string[] = [];
    for (const source of Object.keys(deps.official)) {
      const status = tx.sources[source];
      let due = true;
      if (status?.last_attempt) {
        const waitMin = status.status === "ok" ? OFFICIAL_INTERVAL_MIN : OFFICIAL_RETRY_MIN;
        const since = nowDate.getTime() - Date.parse(status.last_attempt);
        if (!Number.isNaN(since)) due = since >= waitMin * 60_000;
      }
      if (due) dueOfficial.push(source);
    }

    // JMA: reuse the previous values for 10 min (60 s on a manual refresh)
    const jmaTtlMs = (opts.force ? JMA_FORCED_TTL_SEC : JMA_TTL_SEC) * 1000;
    const jmaFresh = !!prev && !!prev.jma_fetched_ms && nowDate.getTime() - prev.jma_fetched_ms < jmaTtlMs && !!Object.keys(prev.jma_raw ?? {}).length;

    // All remote sources are independent network calls, so fetch them concurrently (total wait = the slowest source,
    // not the sum). Each is bounded so one hung source cannot eat the function's time limit.
    const [[darwin, recent, jma, mirova], official] = await Promise.all([
      Promise.allSettled([
        withTimeout(deps.getDarwinVaacTable(), 45_000, "BoM VAAC"), // BoM 24-hour feed: ALL VAACs, the Home source
        withTimeout(deps.getVaacRecentList(), 45_000, "Tokyo VAAC list"),
        jmaFresh ? Promise.resolve(null) : withTimeout(deps.getJmaAlerts(), 45_000, "JMA"),
        withTimeout(deps.getMirovaAlerts(), 45_000, "MIROVA"),
      ]),
      // Cold start (nothing stored yet): a visitor is waiting for this refresh, so a slow official source (KVERT's
      // host often needs >10 s to connect) is cut off early - it is retried after 5 min like any failed source.
      Promise.allSettled(dueOfficial.map((s) => withTimeout(deps.official[s](index), prev ? 45_000 : OFFICIAL_COLD_START_MS, s))),
    ]);

    // A failed source keeps its previous values (the Python cache fell back to its last good copy the same way).
    let vaac_rows = prev?.vaac_rows ?? [];
    if (darwin.status === "fulfilled") vaac_rows = darwin.value;
    else errors.BoM = message(darwin.reason);

    let jma_raw = prev?.jma_raw ?? {};
    let jma_issued = prev?.jma_issued ?? {};
    let jma_fetched_ms = prev?.jma_fetched_ms;
    if (jma.status === "fulfilled" && jma.value) {
      // an EMPTY answer is not believed (JMA always lists some volcanoes): keep the previous values, retry next time
      if (Object.keys(jma.value.raw).length) {
        jma_raw = jma.value.raw;
        jma_issued = jma.value.issued;
        jma_fetched_ms = nowDate.getTime();
      } else errors.JMA = "empty answer, keeping previous values";
    } else if (jma.status === "rejected") errors.JMA = message(jma.reason);

    let mirova_rows = prev?.mirova_rows ?? [];
    if (mirova.status === "fulfilled") mirova_rows = mirova.value;
    else errors.MIROVA = message(mirova.reason);

    const coreFailed = darwin.status === "rejected" && mirova.status === "rejected" && jma.status === "rejected";
    if (coreFailed && !prev) {
      // nothing to show and nothing fetched: do not publish an empty snapshot that looks fresh
      await store.setJson(FAILURE_KEY, { at: now, errors }, { ttlSec: 20 });
      return { status: "failed", reason: "no source reachable", durationMs: Date.now() - started, errors };
    }

    // Persist normalized records only when JMA/VAAC/MIROVA content changed.
    let reg_key = prev?.reg_key;
    const newRegKey = digest([jma_raw, jma_issued, vaac_rows, mirova_rows]);
    if (newRegKey !== reg_key) {
      try {
        const { alerts: jmaAlerts, unresolved: jmaUnmatched } = normalizeJma(index, jma_raw, jma_issued);
        const { alerts: vaacAlerts, unresolved: vaacUnmatched } = normalizeVaac(index, vaac_rows);
        tx.upsertAlerts("JMA", jmaAlerts, { now });
        tx.upsertAlerts("VAAC", vaacAlerts, { now });
        tx.recordEvents(
          mirova_rows.flatMap((r) => {
            const num = index.resolve({ name: r.our_name || r.volcano });
            if (num === null) return [];
            const vrp = String(r.vrp_mw ?? "").replace(/,/g, "");
            return [{
              volcano_number: num, source: "MIROVA", kind: "thermal", label: `MIROVA ${vrp} MW`, level: vrp,
              event_time: r.time, detail: r.sensor || null, url: MIROVA_URL,
            }];
          }),
          now,
        );
        reg_key = newRegKey;
        if (jmaUnmatched.length || vaacUnmatched.length) {
          console.log("[registry] unmatched JMA:", jmaUnmatched.slice(0, 30), "VAAC:", vaacUnmatched.slice(0, 30));
        }
      } catch (err) {
        errors.registry = message(err);
        console.error("[registry] update failed:", err);
      }
    }

    // Tokyo's issued-advisory list -> alert history (the front page only lists advisories active right now, so past
    // ones would otherwise never be stored).
    let recent_key = prev?.recent_key;
    if (recent.status === "fulfilled") {
      const newRecentKey = digest(recent.value);
      if (recent.value.length && newRecentKey !== recent_key) {
        try {
          const { alerts } = normalizeVaac(index, recent.value);
          tx.recordEvents(
            alerts.map((a) => {
              const row = a.raw as unknown as VaacRow;
              const source = row.source || "Tokyo VAAC";
              return {
                volcano_number: a.volcano_number, source, kind: "vaa", label: `${source} VAA ${row.advisory || ""}`.trim(),
                level: "ACTIVE", event_time: a.issued_at, detail: row.area || null, url: a.source_url,
              };
            }),
            now,
          );
          recent_key = newRecentKey;
        } catch (err) {
          errors.tokyo = message(err);
        }
      }
    } else errors.Tokyo = message(recent.reason);

    // A failed source never clears its last successful snapshot (upsertAlerts only marks it as an error).
    dueOfficial.forEach((source, i) => {
      const result = official[i];
      try {
        if (result.status === "fulfilled") {
          tx.upsertAlerts(source, result.value, { now });
          console.log(`[registry] ${source}: ${result.value.length} matched alerts`);
        } else {
          tx.upsertAlerts(source, [], { success: false, error: message(result.reason).slice(0, 350), now });
          errors[source] = message(result.reason);
        }
      } catch (err) {
        errors[source] = message(err);
      }
    });

    // History retention (the only part of the state that grows)
    const retentionStart = isoSeconds(new Date(nowDate.getTime() - RETENTION_DAYS * 86_400_000));
    await tx.commit({ eventsSince: retentionStart });
    let pruned_ms = prev?.pruned_ms;
    if (!pruned_ms || nowDate.getTime() - pruned_ms > PRUNE_EVERY_MS) {
      try {
        await store.pruneEvents(retentionStart);
        pruned_ms = nowDate.getTime();
      } catch (err) {
        console.error("[store] prune failed:", err);
      }
    }

    const snapshot: Snapshot = {
      vaac_rows, jma_raw, jma_issued, mirova_rows,
      fetched_at: utcStamp(nowDate), fetched_ms: nowDate.getTime(),
      jma_fetched_ms, reg_key, recent_key, pruned_ms,
    };
    await store.setJson(SNAPSHOT_KEY, snapshot);
    console.log(`[sources] refreshed in ${((Date.now() - started) / 1000).toFixed(1)}s (${opts.force ? "manual" : "background"})`);
    return { status: "refreshed", durationMs: Date.now() - started, errors, fetched_at: snapshot.fetched_at };
  } finally {
    await release().catch(() => {});
  }
}
