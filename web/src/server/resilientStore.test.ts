// The service must keep answering when Redis does not.
import { describe, expect, it } from "vitest";
import type { AlertEvent } from "@/lib/types";
import { ResilientStore } from "./resilientStore";
import { MemoryStore, type Store } from "./store";

/** A primary that can be switched between healthy, failing and hanging. */
class SwitchableStore extends MemoryStore {
  mode: "ok" | "fail" | "hang" = "ok";
  calls = 0;
  override readonly kind = "upstash" as unknown as "memory";
  private gate<T>(fn: () => Promise<T>): Promise<T> {
    this.calls++;
    if (this.mode === "fail") return Promise.reject(new Error("ERR max daily request limit exceeded"));
    if (this.mode === "hang") return new Promise<T>(() => {});
    return fn();
  }
  override getJson<T>(key: string) { return this.gate(() => super.getJson<T>(key)); }
  override getManyJson<T>(keys: string[]) { return this.gate(() => super.getManyJson<T>(keys)); }
  override setJson(key: string, value: unknown, opts?: { ttlSec?: number }) { return this.gate(() => super.setJson(key, value, opts)); }
  override async acquireLock(key: string, ttl: number) {
    const release = await this.gate(() => super.acquireLock(key, ttl));
    // like the real Redis lock, releasing talks to the server again (so it can fail later)
    return release ? () => this.gate(() => release()) : null;
  }
  override addEvents(events: AlertEvent[]) { return this.gate(() => super.addEvents(events)); }
}

const ev = (n: number, t: string): AlertEvent => ({
  volcano_number: n, source: "JMA", kind: "volcano_level", label: "JMA Level 2", level: "2",
  event_time: t, detail: null, url: null, first_seen: t,
});

function setup(opts: { timeoutMs?: number } = {}) {
  let clock = 1_000_000;
  const primary = new SwitchableStore();
  const fallback = new MemoryStore();
  const store: Store & { degraded: boolean } = new ResilientStore(primary, fallback, { cooldownMs: 30_000, now: () => clock, ...opts });
  return { primary, fallback, store, advance: (ms: number) => (clock += ms) };
}

describe("ResilientStore", () => {
  it("uses the primary while it is healthy", async () => {
    const { primary, store } = setup();
    await store.setJson("k", { a: 1 });
    expect(await primary.getJson("k")).toEqual({ a: 1 });
    expect(store.kind).toBe("upstash");
    expect(store.degraded).toBe(false);
  });

  it("answers from memory instead of throwing when the primary fails", async () => {
    const { primary, store } = setup();
    primary.mode = "fail";
    await expect(store.getJson("k")).resolves.toBeNull(); // no throw
    await store.setJson("k", { a: 2 }); // the fallback keeps what is written meanwhile
    expect(await store.getJson("k")).toEqual({ a: 2 });
    expect(await store.getManyJson(["k", "missing"])).toEqual([{ a: 2 }, null]);
    expect(store.kind).toBe("memory");
    expect(store.degraded).toBe(true);
  });

  it("leaves the primary alone during the cool-down, then tries it again and comes back", async () => {
    const { primary, store, advance } = setup();
    primary.mode = "fail";
    await store.getJson("k");
    const callsAfterFailure = primary.calls;
    await store.getJson("k");
    await store.setJson("k", 1);
    expect(primary.calls).toBe(callsAfterFailure); // not even tried: callers do not wait on a dead Redis

    primary.mode = "ok";
    advance(31_000); // cool-down over
    await store.setJson("k", { back: true });
    expect(primary.calls).toBeGreaterThan(callsAfterFailure);
    expect(await primary.getJson("k")).toEqual({ back: true }); // written to the primary again
    expect(store.kind).toBe("upstash");
  });

  it("goes back to the fallback for another cool-down when the primary is still down", async () => {
    const { primary, store, advance } = setup();
    primary.mode = "fail";
    await store.getJson("k");
    advance(31_000);
    const before = primary.calls;
    await store.getJson("k"); // retried, fails again
    expect(primary.calls).toBe(before + 1);
    await store.getJson("k"); // inside the new cool-down
    expect(primary.calls).toBe(before + 1);
    expect(store.degraded).toBe(true);
  });

  it("treats a primary that never answers as failed", async () => {
    const { primary, store } = setup({ timeoutMs: 40 });
    primary.mode = "hang";
    const started = Date.now();
    await expect(store.getJson("k")).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(store.degraded).toBe(true);
  });

  it("history and locks keep working on the fallback", async () => {
    const { primary, store } = setup();
    primary.mode = "fail";
    expect(await store.addEvents([ev(1, "2026-11-04T00:00:00+00:00"), ev(2, "2026-11-04T01:00:00+00:00")])).toBe(2);
    const rows = await store.getEvents("2026-11-03T00:00:00+00:00");
    expect(rows.map((r) => r.volcano_number)).toEqual([2, 1]);
    const release = await store.acquireLock("refresh", 60);
    expect(release).not.toBeNull();
    expect(await store.acquireLock("refresh", 60)).toBeNull(); // still a lock
    await release!(); // and releasing never throws
  });

  it("releasing a lock never throws even if the primary died after it was taken", async () => {
    const { primary, store } = setup();
    const release = await store.acquireLock("refresh", 60);
    primary.mode = "fail";
    // the release talks to the (now failing) primary; it must swallow that
    await expect(release!()).resolves.toBeUndefined();
  });
});
