// Alert registry: current alerts per source + append-only history. Port of volcano_alert_registry.py (and
// _dedupe_events of pages/home.py).
//
// Python wrote through SQLite transactions. Here a RegistryTx loads the (small) registry blobs once, applies any
// number of upsert/record calls in memory, and writes everything back in commit() - a handful of Redis round trips
// per refresh instead of one per call. Only one refresh runs at a time (store lock), so read-modify-write is safe.
import { JMA_NAME_MAP } from "@/lib/jmaNames";
import type { AlertEvent, RegistryAlert, SourceStatus } from "@/lib/types";
import type { VolcanoIndex } from "@/lib/volcanoes";
import type { VaacRow } from "@/lib/types";
import type { AlertInput } from "./collectors/types";
import type { Store } from "./store";
import { eventTimeIso, isoSeconds } from "./time";

type StoredAlert = Omit<RegistryAlert, "stale">;
export interface RegistryBlob {
  alerts: Record<string, StoredAlert[]>; // source -> its current alerts
  sources: Record<string, SourceStatus>; // source -> refresh status (source_refresh table)
}
/** per (volcano, source, kind): the label of the newest history row - for the "label changed?" rule */
type LastLabels = Record<string, { label: string; event_time: string }>;

export const REGISTRY_KEY = "registry";
const LAST_LABELS_KEY = "events:last";

/**
 * A failed refresh does not make the records stale at once: official levels change over days, and a source that
 * times out for one attempt (PVMBG does now and then) would otherwise lose every triangle colour for a while.
 * Records count as stale only when the last SUCCESSFUL refresh is older than this.
 */
export const STALE_AFTER_MS = 6 * 3600 * 1000;

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function isStale(status: Partial<SourceStatus> | undefined, nowMs = Date.now()): boolean {
  if (status?.status === "ok") return false;
  const last = status?.last_success ? Date.parse(status.last_success) : NaN;
  if (Number.isNaN(last)) return true; // never succeeded (or unknown source)
  return nowMs - last > STALE_AFTER_MS;
}

export interface EventInput {
  volcano_number: unknown;
  source?: string | null;
  kind?: string | null;
  label?: string | null;
  level?: string | number | null;
  event_time?: unknown;
  detail?: string | null;
  url?: string | null;
}

export class RegistryTx {
  private pending: AlertEvent[] = [];
  private registryDirty = false;
  private lastDirty = false;

  private constructor(
    private readonly store: Store,
    private readonly blob: RegistryBlob,
    private readonly last: LastLabels,
  ) {}

  static async open(store: Store): Promise<RegistryTx> {
    const [blob, last] = await store.getManyJson<RegistryBlob | LastLabels>([REGISTRY_KEY, LAST_LABELS_KEY]);
    const reg = (blob as RegistryBlob | null) ?? { alerts: {}, sources: {} };
    return new RegistryTx(store, { alerts: reg.alerts ?? {}, sources: reg.sources ?? {} }, (last as LastLabels | null) ?? {});
  }

  get sources(): Readonly<Record<string, SourceStatus>> {
    return this.blob.sources;
  }

  /** Queue history rows (INSERT OR IGNORE; written by commit). */
  recordEvents(events: EventInput[], now: string = isoSeconds()): void {
    for (const e of events) {
      const n = toNumber(e.volcano_number);
      const when = eventTimeIso(e.event_time, now) as string;
      if (n === null) continue;
      const source = String(e.source ?? "");
      const kind = String(e.kind ?? "");
      const label = String(e.label ?? "");
      const lastKey = `${n}|${source}|${kind}`;
      if (eventTimeIso(e.event_time) === null) {
        // No issue time from the source (e.g. PVMBG): the time above is just "first seen". Don't add a new row on
        // every refresh - only when this volcano's label for the source actually changed.
        const last = this.last[lastKey];
        if (last && last.label === label) continue;
      }
      this.pending.push({
        volcano_number: n,
        source,
        kind,
        label,
        level: e.level === null || e.level === undefined ? null : String(e.level),
        event_time: when,
        detail: e.detail ?? null,
        url: e.url ?? null,
        first_seen: now,
      });
      const known = this.last[lastKey];
      if (!known || known.event_time <= when) {
        this.last[lastKey] = { label, event_time: when };
        this.lastDirty = true;
      }
    }
  }

  /**
   * Atomic source refresh; an empty SUCCESSFUL refresh clears the source's old alerts.
   * An unsuccessful refresh NEVER clears prior alerts. Old alerts are marked stale in readAlerts() based on the
   * source status, not silently considered normal.
   */
  upsertAlerts(
    source: string,
    alerts: AlertInput[],
    opts: { success?: boolean; error?: string | null; now?: string } = {},
  ): void {
    const success = opts.success ?? true;
    const now = opts.now ?? isoSeconds();
    if (success) {
      // A source may publish multiple advisories for one volcano. The snapshot stores one row per
      // (number, source, alert_type), so retain the latest advisory. Prefer the most recent issued timestamp; keep
      // the last item for equal/missing timestamps (e.g. repeated JMA table rows).
      const unique = new Map<string, { n: number; a: AlertInput }>();
      for (const a of alerts) {
        const n = toNumber(a.volcano_number);
        if (n === null) throw new Error("Unresolved volcano_number in alert: " + JSON.stringify(a));
        const key = `${n}|${a.alert_type}`;
        const previous = unique.get(key);
        if (!previous || String(a.issued_at ?? "") >= String(previous.a.issued_at ?? "")) unique.set(key, { n, a });
      }
      this.recordEvents(
        [...unique.values()].map(({ n, a }) => ({
          volcano_number: n,
          source,
          kind: a.alert_type,
          label: a.label || a.level,
          level: a.level,
          event_time: a.issued_at || a.observed_at,
          detail: typeof a.raw?.eruption === "string" ? a.raw.eruption : null,
          url: a.source_url ?? null,
        })),
        now,
      );
      this.blob.alerts[source] = [...unique.values()].map(({ n, a }) => ({
        volcano_number: n,
        source,
        alert_type: String(a.alert_type),
        level: String(a.level),
        label: String(a.label || a.level),
        issued_at: a.issued_at ?? null,
        observed_at: a.observed_at ?? null,
        fetched_at: now,
        source_url: a.source_url ?? null,
      }));
    }
    const previousStatus = this.blob.sources[source];
    this.blob.sources[source] = {
      source,
      last_success: success ? now : (previousStatus?.last_success ?? null),
      last_attempt: now,
      status: success ? "ok" : "error",
      error: success ? null : String(opts.error ?? ""),
    };
    this.registryDirty = true;
  }

  /**
   * Write everything queued. `eventsSince` (ISO) drops history rows older than the retention window instead of
   * inserting them just to prune them (an alert issued years ago, like JMA's Ioto from 2007, is re-listed every time).
   */
  async commit(opts: { eventsSince?: string } = {}): Promise<{ events: number }> {
    if (this.registryDirty) await this.store.setJson(REGISTRY_KEY, this.blob);
    if (this.lastDirty) await this.store.setJson(LAST_LABELS_KEY, this.last);
    const since = opts.eventsSince;
    const rows = since ? this.pending.filter((e) => e.event_time >= since) : this.pending;
    const events = rows.length ? await this.store.addEvents(rows) : 0;
    this.pending = [];
    this.registryDirty = this.lastDirty = false;
    return { events };
  }
}

/** Current alerts of every volcano, each marked stale when its source has not refreshed successfully for 6 h. */
export async function readAlerts(store: Store, nowMs = Date.now()) {
  return alertsFromBlob(await store.getJson<RegistryBlob>(REGISTRY_KEY), nowMs);
}

/** Same as readAlerts() for a registry blob that was already read (so a request can fetch it together with the snapshot). */
export function alertsFromBlob(blob: RegistryBlob | null, nowMs = Date.now()) {
  const sources = blob?.sources ?? {};
  const by_number: Record<string, RegistryAlert[]> = {};
  for (const rows of Object.values(blob?.alerts ?? {})) {
    for (const row of rows) {
      (by_number[String(row.volcano_number)] ??= []).push({ ...row, stale: isStale(sources[row.source], nowMs) });
    }
  }
  return { by_number, sources };
}

/** History with event_time >= sinceIso, newest first. */
export function readEvents(store: Store, sinceIso: string, volcanoNumber?: number, limit = 2000): Promise<AlertEvent[]> {
  return store.getEvents(sinceIso, { volcanoNumber, limit });
}

/**
 * One row per (volcano, source, kind, minute): the live table and the issued list both report the same VAA; keep the
 * more specific label (with advisory number).
 */
export function dedupeEvents(events: AlertEvent[]): AlertEvent[] {
  const best = new Map<string, AlertEvent>();
  for (const e of events) {
    const key = `${e.volcano_number}|${e.source}|${e.kind}|${String(e.event_time).slice(0, 16)}`;
    const current = best.get(key);
    if (!current || String(e.label).length > String(current.label).length) best.set(key, e);
  }
  return [...best.values()].sort((a, b) => {
    const x = String(a.event_time);
    const y = String(b.event_time);
    return x < y ? 1 : x > y ? -1 : 0;
  });
}

// ── normalizers ────────────────────────────────────────────

/** Only published levels are stored; no match does NOT mean level 1. */
export function normalizeJma(
  index: VolcanoIndex,
  rawLevels: Record<string, number> | null | undefined,
  issued: Record<string, string> | null | undefined,
): { alerts: AlertInput[]; unresolved: string[] } {
  const alerts: AlertInput[] = [];
  const unresolved: string[] = [];
  for (const [name, level] of Object.entries(rawLevels ?? {})) {
    const number = index.resolve({ name: JMA_NAME_MAP[name] ?? name, country: "Japan" });
    if (number === null) {
      unresolved.push(name);
      continue;
    }
    const levelInt = Math.trunc(Number(level));
    if (!Number.isFinite(levelInt)) continue;
    alerts.push({
      volcano_number: number,
      alert_type: "volcano_level",
      level: String(levelInt),
      label: "JMA Level " + levelInt,
      issued_at: issued?.[name] ?? null,
      source_url: "https://www.jma.go.jp/bosai/map.html#contents=volcano",
      raw: { source_name: name },
    });
  }
  return { alerts, unresolved };
}

export function normalizeVaac(
  index: VolcanoIndex,
  rows: VaacRow[] | null | undefined,
): { alerts: AlertInput[]; unresolved: string[] } {
  const alerts: AlertInput[] = [];
  const unresolved: string[] = [];
  for (const row of rows ?? []) {
    if (row.is_terminal) continue;
    const name = String(row.volcano ?? "");
    let number: unknown = (row as { volcano_number?: unknown }).volcano_number;
    if (!number) number = /(?<!\d)(\d{6})(?!\d)/.exec(name)?.[1] ?? null;
    const cleanName = name.replace(/\b\d{6}\b/g, "").trim();
    const n = index.resolve({ volcano_number: number, name: cleanName });
    if (n === null) {
      unresolved.push(name);
      continue;
    }
    alerts.push({
      volcano_number: n,
      alert_type: "vaa",
      level: "ACTIVE",
      label: String(row.source || "VAAC") + " VAA",
      issued_at: row.datetime,
      source_url: row.detail_url,
      raw: row as unknown as Record<string, unknown>,
    });
  }
  return { alerts, unresolved };
}
