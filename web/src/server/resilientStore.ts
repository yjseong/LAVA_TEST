// Keeps the service up when Redis is not: every call goes to the primary store (Upstash); when it fails or hangs, that
// call is answered by an in-memory store instead, and the primary is left alone for a short cool-down.
//
// Without this a Redis outage (or the free plan's monthly command limit) made /api/alerts and /api/events answer 500
// and a freshly opened page showed an empty map. With it the page keeps working on what each server instance can
// fetch itself - the same behaviour as a deployment without Redis: no shared history, a slower first request per
// instance (it has to collect the sources itself), but every alert is still shown.
//
// What is NOT done: data written to the fallback while Redis was down is not copied back when it recovers (it is
// small, per instance, and the next refresh rebuilds the current state anyway).
import type { AlertEvent } from "@/lib/types";
import type { EventQuery, LockRelease, Store } from "./store";

export interface ResilientOptions {
  /** how long the primary is skipped after a failure (ms) */
  cooldownMs?: number;
  /** a primary call slower than this counts as failed (ms): the REST client has no timeout of its own */
  timeoutMs?: number;
  now?: () => number;
}

export class ResilientStore implements Store {
  private downUntil = 0;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly primary: Store,
    private readonly fallback: Store,
    opts: ResilientOptions = {},
  ) {
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.now = opts.now ?? Date.now;
  }

  /** The store that answers right now ("memory" while the primary is being skipped). */
  get kind(): Store["kind"] {
    return this.degraded ? this.fallback.kind : this.primary.kind;
  }

  /** true while Redis is being skipped */
  get degraded(): boolean {
    return this.now() < this.downUntil;
  }

  private async run<T>(op: (store: Store) => Promise<T>): Promise<T> {
    if (!this.degraded) {
      try {
        return await withTimeout(op(this.primary), this.timeoutMs);
      } catch (err) {
        this.downUntil = this.now() + this.cooldownMs;
        console.error(
          `[store] ${this.primary.kind} unavailable, using the in-memory fallback for ${Math.round(this.cooldownMs / 1000)} s:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return op(this.fallback);
  }

  getJson<T>(key: string): Promise<T | null> {
    return this.run((s) => s.getJson<T>(key));
  }

  getManyJson<T>(keys: string[]): Promise<(T | null)[]> {
    return this.run((s) => s.getManyJson<T>(keys));
  }

  setJson(key: string, value: unknown, opts?: { ttlSec?: number }): Promise<void> {
    return this.run((s) => s.setJson(key, value, opts));
  }

  async acquireLock(key: string, ttlSec: number): Promise<LockRelease | null> {
    const release = await this.run((s) => s.acquireLock(key, ttlSec));
    if (!release) return null;
    // releasing a lock must never throw: Redis may have gone away since the lock was taken (it expires by itself)
    return async () => {
      try {
        await release();
      } catch {
        /* the lock expires on its own */
      }
    };
  }

  addEvents(events: AlertEvent[]): Promise<number> {
    return this.run((s) => s.addEvents(events));
  }

  getEvents(sinceIso: string, query?: EventQuery): Promise<AlertEvent[]> {
    return this.run((s) => s.getEvents(sinceIso, query));
  }

  pruneEvents(beforeIso: string): Promise<number> {
    return this.run((s) => s.pruneEvents(beforeIso));
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
