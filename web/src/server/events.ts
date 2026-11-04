// Alert history for the side panel (port of _events_since / _selected_events in pages/home.py).
import type { AlertEvent } from "@/lib/types";
import { dedupeEvents, readEvents } from "./registry";
import { getStore, type Store } from "./store";
import { isoSeconds } from "./time";
import { getVaaHistory, vaaDbConfigured } from "./vaaDb";

const VAA_DB_CACHE_SEC = 300; // the advisory DB is queried at most every 5 min per volcano

/**
 * History of the last `days` days, newest first. For ONE volcano the month-long VAA history of the advisory
 * database (when configured) is merged in: a DB row is added only when no VAA event of this app falls in the same minute.
 */
export async function getEventsWindow(
  days: number,
  opts: { number?: number; limit?: number; store?: Store } = {},
): Promise<AlertEvent[]> {
  const store = opts.store ?? getStore();
  const since = isoSeconds(new Date(Date.now() - days * 86_400_000));
  const events = dedupeEvents(await readEvents(store, since, opts.number, opts.limit));
  if (opts.number === undefined || !vaaDbConfigured()) return events;

  const cacheKey = `vaahist:${opts.number}:${days}`;
  let dbRows = await store.getJson<{ event_time: string; detail: string }[]>(cacheKey);
  if (!dbRows) {
    dbRows = await getVaaHistory(opts.number, days);
    if (dbRows.length) await store.setJson(cacheKey, dbRows, { ttlSec: VAA_DB_CACHE_SEC });
  }
  const have = new Set(events.filter((e) => e.kind === "vaa").map((e) => String(e.event_time).slice(0, 16)));
  for (const r of dbRows) {
    if (have.has(String(r.event_time).slice(0, 16))) continue;
    events.push({
      volcano_number: opts.number,
      source: "VAA DB",
      kind: "vaa",
      label: "VAA (database)",
      level: null,
      event_time: r.event_time,
      detail: r.detail,
      url: null,
      first_seen: r.event_time,
    });
  }
  events.sort((a, b) => (a.event_time < b.event_time ? 1 : a.event_time > b.event_time ? -1 : 0));
  return events;
}
