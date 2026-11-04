// One contract, three implementations. UpstashStore runs against a small fake that follows the Redis semantics the
// store relies on (HSETNX, ZADD NX, ZRANGE BYSCORE [REV] LIMIT, HMGET) - the real service is not reachable from tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AlertEvent } from "@/lib/types";
import { FileStore, MemoryStore, UpstashStore, type RedisLike, type RedisPipelineLike, type Store } from "./store";

/** Minimal Redis fake. hmgetAs "array" mimics the SDK with automaticDeserialization off. */
class FakeRedis implements RedisLike {
  strings = new Map<string, { v: string; exp: number | null }>();
  hashes = new Map<string, Map<string, string>>();
  zsets = new Map<string, Map<string, number>>();
  commands = 0;
  constructor(private readonly hmgetAs: "object" | "array" = "object") {}

  private live(key: string) {
    const e = this.strings.get(key);
    if (e && e.exp !== null && e.exp < Date.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return e;
  }
  async get(key: string) {
    this.commands++;
    const e = this.live(key);
    if (!e) return null;
    try {
      return JSON.parse(e.v); // the SDK parses JSON-looking replies
    } catch {
      return e.v;
    }
  }
  async mget(...keys: string[]) {
    this.commands++;
    return keys.map((k) => {
      const e = this.live(k);
      if (!e) return null;
      try {
        return JSON.parse(e.v);
      } catch {
        return e.v;
      }
    });
  }
  async set(key: string, value: string, opts: { nx?: boolean; ex?: number } = {}) {
    this.commands++;
    if (opts.nx && this.live(key)) return null;
    this.strings.set(key, { v: value, exp: opts.ex ? Date.now() + opts.ex * 1000 : null });
    return "OK";
  }
  async del(...keys: string[]) {
    this.commands++;
    keys.forEach((k) => this.strings.delete(k));
    return keys.length;
  }
  async hmget(key: string, ...fields: string[]) {
    this.commands++;
    const h = this.hashes.get(key);
    const vals = fields.map((f) => h?.get(f) ?? null);
    if (this.hmgetAs === "array") return vals;
    if (vals.every((v) => v === null)) return null;
    return Object.fromEntries(fields.map((f, i) => [f, vals[i] === null ? null : JSON.parse(vals[i]!)]));
  }
  async zrange(key: string, a: string | number, b: string | number, opts: { byScore?: boolean; rev?: boolean; offset?: number; count?: number } = {}) {
    this.commands++;
    const [lo, hi] = opts.rev ? [b, a] : [a, b];
    const bound = (x: string | number, isLow: boolean) => {
      if (x === "+inf") return { v: Infinity, open: false };
      if (x === "-inf") return { v: -Infinity, open: false };
      if (typeof x === "string" && x.startsWith("(")) return { v: Number(x.slice(1)), open: true };
      return { v: Number(x), open: false, isLow };
    };
    const L = bound(lo, true);
    const H = bound(hi, false);
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
        this.commands++; // one HTTP request, however many commands
        return ops.map((op) => op());
      },
    };
    return p;
  }
}

const ev = (n: number, time: string, over: Partial<AlertEvent> = {}): AlertEvent => ({
  volcano_number: n, source: "JMA", kind: "volcano_level", label: "JMA Level 2", level: "2",
  event_time: time, detail: null, url: null, first_seen: "2026-11-04T00:00:00+00:00", ...over,
});

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const implementations: [string, () => Store][] = [
  ["MemoryStore", () => new MemoryStore()],
  [
    "FileStore",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lava-store-"));
      tmpDirs.push(dir);
      return new FileStore(path.join(dir, "store.json"));
    },
  ],
  ["UpstashStore (fake, HMGET as object)", () => new UpstashStore(new FakeRedis("object"))],
  ["UpstashStore (fake, HMGET as array)", () => new UpstashStore(new FakeRedis("array"))],
];

describe.each(implementations)("%s", (_name, make) => {
  it("stores JSON blobs (and nothing for a missing key)", async () => {
    const s = make();
    expect(await s.getJson("nope")).toBeNull();
    await s.setJson("a", { x: [1, 2, { y: "z" }] });
    await s.setJson("b", [1, 2]);
    expect(await s.getJson("a")).toEqual({ x: [1, 2, { y: "z" }] });
    expect(await s.getManyJson(["a", "missing", "b"])).toEqual([{ x: [1, 2, { y: "z" }] }, null, [1, 2]]);
  });

  it("lock: exclusive until released, then free again", async () => {
    const s = make();
    const first = await s.acquireLock("refresh", 60);
    expect(first).not.toBeNull();
    expect(await s.acquireLock("refresh", 60)).toBeNull();
    await first!();
    const again = await s.acquireLock("refresh", 60);
    expect(again).not.toBeNull();
    await again!();
  });

  it("history: dedupes by identity, windows by time, newest first, per volcano, limit", async () => {
    const s = make();
    const rows = [
      ev(1, "2026-11-01T00:00:00+00:00"),
      ev(1, "2026-11-03T00:00:00+00:00", { label: "JMA Level 3" }),
      ev(2, "2026-11-02T00:00:00+00:00", { source: "MIROVA", kind: "thermal", label: "MIROVA 5 MW" }),
      ev(1, "2026-10-01T00:00:00+00:00"), // outside the window below
    ];
    expect(await s.addEvents(rows)).toBe(4);
    expect(await s.addEvents([...rows, ev(3, "2026-11-04T00:00:00+00:00")])).toBe(1); // only the new row counts

    const all = await s.getEvents("2026-10-15T00:00:00+00:00");
    expect(all.map((e) => e.event_time)).toEqual([
      "2026-11-04T00:00:00+00:00", "2026-11-03T00:00:00+00:00", "2026-11-02T00:00:00+00:00", "2026-11-01T00:00:00+00:00",
    ]);
    expect((await s.getEvents("2026-10-15T00:00:00+00:00", { volcanoNumber: 1 })).map((e) => e.label)).toEqual(["JMA Level 3", "JMA Level 2"]);
    expect(await s.getEvents("2026-10-15T00:00:00+00:00", { limit: 2 })).toHaveLength(2);
    expect((await s.getEvents("2026-10-15T00:00:00+00:00", { limit: 2 }))[0].event_time).toBe("2026-11-04T00:00:00+00:00"); // the NEWEST two
    expect(await s.getEvents("2027-01-01T00:00:00+00:00")).toEqual([]);
  });

  it("prune drops old history everywhere (all-volcano and per-volcano views)", async () => {
    const s = make();
    await s.addEvents([ev(1, "2026-09-01T00:00:00+00:00"), ev(1, "2026-11-01T00:00:00+00:00"), ev(2, "2026-09-02T00:00:00+00:00")]);
    expect(await s.pruneEvents("2026-10-01T00:00:00+00:00")).toBe(2);
    expect((await s.getEvents("2000-01-01T00:00:00+00:00")).map((e) => e.event_time)).toEqual(["2026-11-01T00:00:00+00:00"]);
    expect(await s.getEvents("2000-01-01T00:00:00+00:00", { volcanoNumber: 2 })).toEqual([]);
  });
});

describe("FileStore persistence", () => {
  it("a second instance on the same file sees what the first wrote (dev server workers)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lava-store-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "nested", "store.json");
    const a = new FileStore(file);
    await a.setJson("k", { v: 1 });
    await a.addEvents([ev(7, "2026-11-01T00:00:00+00:00")]);
    const b = new FileStore(file);
    expect(await b.getJson("k")).toEqual({ v: 1 });
    expect(await b.getEvents("2026-01-01T00:00:00+00:00")).toHaveLength(1);
    await b.setJson("k", { v: 2 });
    expect(await a.getJson("k")).toEqual({ v: 2 }); // a notices b's write through the file's mtime
  });
});

describe("UpstashStore round trips", () => {
  it("indexes only NEW history rows and batches commands into pipelines", async () => {
    const redis = new FakeRedis();
    const s = new UpstashStore(redis);
    const rows = Array.from({ length: 50 }, (_x, i) => ev(i + 1, `2026-11-0${(i % 4) + 1}T00:00:00+00:00`));
    await s.addEvents(rows);
    expect(redis.commands).toBe(2); // 50 HSETNX in one pipeline, 100 ZADD in another
    const before = redis.commands;
    expect(await s.addEvents(rows)).toBe(0); // nothing new: a single pipeline, no ZADD pass
    expect(redis.commands - before).toBe(1);
  });
});
