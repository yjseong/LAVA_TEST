// Guards the Redis command budget. Upstash's free plan allows 500K commands a month and bills EVERY command (also each
// one inside a pipeline), so the number of commands per operation is a property worth testing: this counts them with
// real-shaped data (the BoM / MIROVA rows of the Python snapshot) and a counting fake Redis.
//
// Measured before the optimisation (same data): refresh with nothing new 7, refresh with ONE new advisory 228
// (an HSETNX per already-known history row), visitor GET /api/alerts 3 (the snapshot was read twice).
import { describe, expect, it } from "vitest";
import ref from "@/lib/__fixtures__/python-reference.json";
import type { MirovaRow, VaacRow } from "@/lib/types";
import { getEventsWindow } from "./events";
import { getAlertPayload } from "./payload";
import { refreshSources, type RefreshDeps } from "./refresh";
import { UpstashStore, type RedisLike, type RedisPipelineLike } from "./store";

/** Counting Redis. `billed` = commands as Upstash counts them (MGET is one command, each pipelined command is one). */
class BilledRedis implements RedisLike {
  billed = 0;
  strings = new Map<string, { v: string; exp: number | null }>();
  hashes = new Map<string, Map<string, string>>();
  zsets = new Map<string, Map<string, number>>();
  private live(key: string) {
    const e = this.strings.get(key);
    if (e && e.exp !== null && e.exp < Date.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return e;
  }
  private parse(s: string) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  async get(key: string) {
    this.billed++;
    const e = this.live(key);
    return e ? this.parse(e.v) : null;
  }
  async mget(...keys: string[]) {
    this.billed++;
    return keys.map((k) => {
      const e = this.live(k);
      return e ? this.parse(e.v) : null;
    });
  }
  async set(key: string, value: string, opts: { nx?: boolean; ex?: number } = {}) {
    this.billed++;
    if (opts.nx && this.live(key)) return null;
    this.strings.set(key, { v: value, exp: opts.ex ? Date.now() + opts.ex * 1000 : null });
    return "OK";
  }
  async del(...keys: string[]) {
    this.billed++;
    keys.forEach((k) => this.strings.delete(k));
    return keys.length;
  }
  async hmget(key: string, ...fields: string[]) {
    this.billed++;
    const h = this.hashes.get(key);
    const vals = fields.map((f) => h?.get(f) ?? null);
    if (vals.every((v) => v === null)) return null;
    return Object.fromEntries(fields.map((f, i) => [f, vals[i] === null ? null : JSON.parse(vals[i]!)]));
  }
  async zrange(key: string, a: string | number, b: string | number, opts: { byScore?: boolean; rev?: boolean; offset?: number; count?: number } = {}) {
    this.billed++;
    const [lo, hi] = opts.rev ? [b, a] : [a, b];
    const bound = (x: string | number) =>
      x === "+inf" ? { v: Infinity, open: false } : x === "-inf" ? { v: -Infinity, open: false }
        : typeof x === "string" && x.startsWith("(") ? { v: Number(x.slice(1)), open: true } : { v: Number(x), open: false };
    const L = bound(lo);
    const H = bound(hi);
    let items = [...(this.zsets.get(key) ?? new Map<string, number>()).entries()]
      .filter(([, s]) => (L.open ? s > L.v : s >= L.v) && (H.open ? s < H.v : s <= H.v))
      .sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1));
    if (opts.rev) items.reverse();
    if (opts.count !== undefined) items = items.slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.count);
    return items.map(([m]) => m);
  }
  pipeline(): RedisPipelineLike {
    const ops: (() => unknown)[] = [];
    const p: RedisPipelineLike = {
      hsetnx: (key, field, value) => {
        ops.push(() => {
          const h = this.hashes.get(key) ?? this.hashes.set(key, new Map()).get(key)!;
          if (h.has(field)) return 0;
          h.set(field, value);
          return 1;
        });
        return p;
      },
      zadd: (key, _o, m) => {
        ops.push(() => {
          const z = this.zsets.get(key) ?? this.zsets.set(key, new Map()).get(key)!;
          if (z.has(m.member)) return 0;
          z.set(m.member, m.score);
          return 1;
        });
        return p;
      },
      hdel: (key, ...fields) => {
        ops.push(() => fields.filter((f) => this.hashes.get(key)?.delete(f)).length);
        return p;
      },
      zrem: (key, ...members) => {
        ops.push(() => members.filter((m) => this.zsets.get(key)?.delete(m)).length);
        return p;
      },
      exec: async () => {
        this.billed += ops.length;
        return ops.map((op) => op());
      },
    };
    return p;
  }
}

const bom = ref.payload.vaac_rows as unknown as VaacRow[];
const mirova = ref.payload.mirova_rows as unknown as MirovaRow[];
// Tokyo's "recent advisories" list writes ISO times; derive one from the same rows
const isoOf = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:00+00:00`;
const recent = bom.map((r) => ({ ...r, datetime: isoOf(r.datetime), area: "JAPAN" }));

const deps = (b: VaacRow[], r: VaacRow[]): Partial<RefreshDeps> => ({
  getDarwinVaacTable: async () => b,
  getVaacRecentList: async () => r,
  getJmaAlerts: async () => ({ raw: ref.payload.jma_raw as Record<string, number>, issued: ref.payload.jma_issued as Record<string, string> }),
  getMirovaAlerts: async () => mirova,
  official: {}, // PVMBG / KVERT / PHIVOLCS are throttled to every 30 min and are not part of an ordinary refresh
});

describe("Redis commands per operation", () => {
  it("stay within budget", async () => {
    const redis = new BilledRedis();
    const store = new UpstashStore(redis);
    const cost = async (fn: () => Promise<unknown>) => {
      const before = redis.billed;
      await fn();
      return redis.billed - before;
    };

    const first = await cost(() => refreshSources({ store, deps: deps(bom, recent) }));
    expect(first).toBeGreaterThan(100); // everything is new (once, when the service starts)

    // nothing changed: lock, snapshot + registry read, snapshot write, lock release
    expect(await cost(() => refreshSources({ store, deps: deps(bom, recent) }))).toBeLessThanOrEqual(10);

    // ONE new advisory: it used to cost 228, because every already-known history row was re-checked one by one
    const newBom = [{ ...bom[0], advisory: "2026/9999", datetime: "20261105/0000Z", is_terminal: false }, ...bom];
    const newRecent = [{ ...recent[0], advisory: "2026/9999", datetime: "2026-11-05T00:00:00+00:00" }, ...recent];
    expect(await cost(() => refreshSources({ store, deps: deps(newBom, newRecent) }))).toBeLessThanOrEqual(40);

    // a visitor: snapshot + registry in one MGET (it was 3 commands)
    expect(await cost(() => getAlertPayload(store))).toBe(1);

    // the history lists: ZRANGE + HMGET
    expect(await cost(() => getEventsWindow(7, { store }))).toBeLessThanOrEqual(2);
    expect(await cost(() => getEventsWindow(30, { store, number: 282080 }))).toBeLessThanOrEqual(2);
  });
});
