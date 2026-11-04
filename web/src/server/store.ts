// Persistent state of the data layer.
//
// The Python app kept its state in a SQLite file (cache/volcano_alerts.sqlite3) and a JSON snapshot
// (cache/latest_sources.json). Vercel functions have no persistent disk, so the same state lives behind this small
// interface:
//
//   UpstashStore  Redis over HTTP - production (Vercel Marketplace: "Upstash for Redis")
//   FileStore     one JSON file under LAVA_DATA_DIR (default .data) - local development
//   MemoryStore   per process, lost on restart - what a Vercel deployment falls back to without Redis
//
// What is stored: a few small JSON blobs (latest snapshot, current alerts + per-source status) and the append-only
// alert history, which is the only part that grows (see addEvents / pruneEvents).
import fs from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";
import type { AlertEvent } from "@/lib/types";

/** Identity of a history row (the primary key of alert_events in the Python app). */
export const eventKey = (e: Pick<AlertEvent, "volcano_number" | "source" | "kind" | "label" | "event_time">): string =>
  `${e.volcano_number}|${e.source}|${e.kind}|${e.label}|${e.event_time}`;

const epochSeconds = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms / 1000;
};

export interface EventQuery {
  volcanoNumber?: number;
  limit?: number;
}

/** Held lock: call release() when done (a lock also expires by itself). */
export type LockRelease = () => Promise<void>;

export interface Store {
  readonly kind: "upstash" | "file" | "memory";
  getJson<T>(key: string): Promise<T | null>;
  /** One round trip for several keys (Upstash is HTTP: every command costs a request). */
  getManyJson<T>(keys: string[]): Promise<(T | null)[]>;
  setJson(key: string, value: unknown, opts?: { ttlSec?: number }): Promise<void>;
  /** SET NX EX. Returns a release function when the lock was taken, null when someone else holds it. */
  acquireLock(key: string, ttlSec: number): Promise<LockRelease | null>;
  /** Insert history rows; rows whose eventKey already exists are ignored. Returns how many were new. */
  addEvents(events: AlertEvent[]): Promise<number>;
  /** History with event_time >= sinceIso, newest first. */
  getEvents(sinceIso: string, query?: EventQuery): Promise<AlertEvent[]>;
  /** Drop history older than beforeIso. Returns how many rows were removed. */
  pruneEvents(beforeIso: string): Promise<number>;
}

// ── in-memory / file ───────────────────────────────────────

interface Data {
  blobs: Record<string, { v: unknown; exp: number | null }>;
  locks: Record<string, number>; // key -> expires at (ms)
  events: Record<string, AlertEvent>;
}

class JsonStore implements Store {
  readonly kind: "file" | "memory" = "memory";
  protected data: Data = { blobs: {}, locks: {}, events: {} };

  /** hooks for FileStore */
  protected async load(): Promise<void> {}
  protected async persist(): Promise<void> {}

  async getJson<T>(key: string): Promise<T | null> {
    await this.load();
    const entry = this.data.blobs[key];
    if (!entry) return null;
    if (entry.exp !== null && entry.exp < Date.now()) return null;
    return structuredClone(entry.v) as T;
  }

  async getManyJson<T>(keys: string[]): Promise<(T | null)[]> {
    return Promise.all(keys.map((k) => this.getJson<T>(k)));
  }

  async setJson(key: string, value: unknown, opts: { ttlSec?: number } = {}): Promise<void> {
    await this.load();
    this.data.blobs[key] = {
      v: structuredClone(value),
      exp: opts.ttlSec ? Date.now() + opts.ttlSec * 1000 : null,
    };
    await this.persist();
  }

  async acquireLock(key: string, ttlSec: number): Promise<LockRelease | null> {
    await this.load();
    const now = Date.now();
    if ((this.data.locks[key] ?? 0) > now) return null;
    const until = now + ttlSec * 1000;
    this.data.locks[key] = until;
    await this.persist();
    return async () => {
      await this.load();
      if (this.data.locks[key] === until) {
        delete this.data.locks[key];
        await this.persist();
      }
    };
  }

  async addEvents(events: AlertEvent[]): Promise<number> {
    await this.load();
    let added = 0;
    for (const e of events) {
      const key = eventKey(e);
      if (key in this.data.events) continue;
      this.data.events[key] = e;
      added++;
    }
    if (added) await this.persist();
    return added;
  }

  async getEvents(sinceIso: string, query: EventQuery = {}): Promise<AlertEvent[]> {
    await this.load();
    const since = epochSeconds(sinceIso);
    return Object.values(this.data.events)
      .filter((e) => epochSeconds(e.event_time) >= since)
      .filter((e) => query.volcanoNumber === undefined || e.volcano_number === query.volcanoNumber)
      .sort((a, b) => epochSeconds(b.event_time) - epochSeconds(a.event_time))
      .slice(0, query.limit ?? 2000)
      .map((e) => structuredClone(e));
  }

  async pruneEvents(beforeIso: string): Promise<number> {
    await this.load();
    const before = epochSeconds(beforeIso);
    let removed = 0;
    for (const [key, e] of Object.entries(this.data.events)) {
      if (epochSeconds(e.event_time) < before) {
        delete this.data.events[key];
        removed++;
      }
    }
    if (removed) await this.persist();
    return removed;
  }
}

export class MemoryStore extends JsonStore {}

export class FileStore extends JsonStore {
  override readonly kind = "file" as const;
  private mtimeMs = -1;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    super();
  }

  protected override async load(): Promise<void> {
    try {
      const stat = await fs.stat(this.file);
      if (stat.mtimeMs === this.mtimeMs) return; // unchanged since we last read/wrote it
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<Data>;
      this.data = { blobs: parsed.blobs ?? {}, locks: parsed.locks ?? {}, events: parsed.events ?? {} };
      this.mtimeMs = stat.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  protected override async persist(): Promise<void> {
    // one write at a time; temp file + rename so a crash never leaves half a file
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data), "utf8");
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tmp, this.file);
          break;
        } catch (err) {
          // Windows: the target may be open in another process for a moment
          const code = (err as NodeJS.ErrnoException).code;
          if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
          await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
        }
      }
      this.mtimeMs = (await fs.stat(this.file)).mtimeMs;
    });
    await this.writing;
  }
}

// ── Upstash Redis ──────────────────────────────────────────

/** The subset of the @upstash/redis client UpstashStore uses (lets tests pass a fake). */
export interface RedisPipelineLike {
  hsetnx(key: string, field: string, value: string): RedisPipelineLike;
  zadd(key: string, opts: { nx: true }, member: { score: number; member: string }): RedisPipelineLike;
  hdel(key: string, ...fields: string[]): RedisPipelineLike;
  zrem(key: string, ...members: string[]): RedisPipelineLike;
  exec(): Promise<unknown[]>;
}
export interface RedisLike {
  get(key: string): Promise<unknown>;
  mget(...keys: string[]): Promise<unknown[]>;
  set(key: string, value: string, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  hmget(key: string, ...fields: string[]): Promise<Record<string, unknown> | unknown[] | null>;
  zrange(
    key: string,
    min: string | number,
    max: string | number,
    opts?: { byScore?: boolean; rev?: boolean; offset?: number; count?: number },
  ): Promise<unknown[]>;
  pipeline(): RedisPipelineLike;
}

/** The SDK parses JSON-looking replies by itself; accept both a parsed value and a raw string. */
const decode = <T>(v: unknown): T | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
};

const CHUNK = 200;
const chunked = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export class UpstashStore implements Store {
  readonly kind = "upstash" as const;

  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = "lava:",
  ) {}

  private k(key: string) {
    return this.prefix + key;
  }
  // history: ev:h = hash eventKey -> row, ev:z = all rows by time, ev:v:<n> = one volcano's rows by time
  private readonly H = () => this.k("ev:h");
  private readonly Z = () => this.k("ev:z");
  private readonly V = (n: number) => this.k("ev:v:" + n);

  async getJson<T>(key: string): Promise<T | null> {
    return decode<T>(await this.redis.get(this.k(key)));
  }

  async getManyJson<T>(keys: string[]): Promise<(T | null)[]> {
    if (!keys.length) return [];
    const values = await this.redis.mget(...keys.map((k) => this.k(k)));
    return values.map((v) => decode<T>(v));
  }

  async setJson(key: string, value: unknown, opts: { ttlSec?: number } = {}): Promise<void> {
    await this.redis.set(this.k(key), JSON.stringify(value), opts.ttlSec ? { ex: opts.ttlSec } : undefined);
  }

  async acquireLock(key: string, ttlSec: number): Promise<LockRelease | null> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const k = this.k("lock:" + key);
    const ok = await this.redis.set(k, token, { nx: true, ex: ttlSec });
    if (ok !== "OK") return null;
    return async () => {
      // only delete our own lock (it may have expired and been taken by someone else meanwhile)
      if ((await this.redis.get(k)) === token) await this.redis.del(k);
    };
  }

  async addEvents(events: AlertEvent[]): Promise<number> {
    let added = 0;
    for (const batch of chunked(events, CHUNK)) {
      // 1) HSETNX tells which rows are new ...
      const p1 = this.redis.pipeline();
      for (const e of batch) p1.hsetnx(this.H(), eventKey(e), JSON.stringify(e));
      const created = await p1.exec();
      const fresh = batch.filter((_e, i) => Number(created[i]) === 1);
      if (!fresh.length) continue;
      // 2) ... and only those are indexed by time (all rows + per volcano)
      const p2 = this.redis.pipeline();
      for (const e of fresh) {
        const member = { score: epochSeconds(e.event_time), member: eventKey(e) };
        p2.zadd(this.Z(), { nx: true }, member);
        p2.zadd(this.V(e.volcano_number), { nx: true }, member);
      }
      await p2.exec();
      added += fresh.length;
    }
    return added;
  }

  async getEvents(sinceIso: string, query: EventQuery = {}): Promise<AlertEvent[]> {
    const zkey = query.volcanoNumber !== undefined ? this.V(query.volcanoNumber) : this.Z();
    // ZRANGE ... BYSCORE REV takes the HIGH end first
    const keys = (
      await this.redis.zrange(zkey, "+inf", epochSeconds(sinceIso), {
        byScore: true,
        rev: true,
        offset: 0,
        count: query.limit ?? 2000,
      })
    ).map(String);
    const out: AlertEvent[] = [];
    for (const batch of chunked(keys, 500)) {
      const res = await this.redis.hmget(this.H(), ...batch);
      const values = Array.isArray(res) ? res : res ? batch.map((f) => res[f]) : [];
      for (const v of values) {
        const e = decode<AlertEvent>(v);
        if (e) out.push(e);
      }
    }
    return out;
  }

  async pruneEvents(beforeIso: string): Promise<number> {
    const keys = (await this.redis.zrange(this.Z(), "-inf", `(${epochSeconds(beforeIso)}`, { byScore: true })).map(String);
    for (const batch of chunked(keys, CHUNK)) {
      const p = this.redis.pipeline();
      p.hdel(this.H(), ...batch);
      p.zrem(this.Z(), ...batch);
      for (const key of batch) p.zrem(this.V(Number(key.split("|", 1)[0])), key);
      await p.exec();
    }
    return keys.length;
  }
}

// ── selection ──────────────────────────────────────────────

function redisCredentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

export function createStore(): Store {
  const prefix = process.env.LAVA_KEY_PREFIX ?? "lava:";
  const creds = redisCredentials();
  if (creds) return new UpstashStore(new Redis({ url: creds.url, token: creds.token }) as unknown as RedisLike, prefix);
  if (process.env.VERCEL) {
    console.warn(
      "[store] no Redis configured (UPSTASH_REDIS_REST_URL / _TOKEN): state is kept in memory and is lost between " +
        "function instances. Add Upstash for Redis from the Vercel Marketplace.",
    );
    return new MemoryStore();
  }
  // Local development only (never reached on Vercel). The path is decided at run time, which would make Turbopack
  // trace - and ship with the function - the whole project, hence the ignore marker.
  const dir = path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.LAVA_DATA_DIR ?? ".data");
  return new FileStore(path.join(dir, "store.json"));
}

const g = globalThis as typeof globalThis & { __lavaStore?: Store };

/** One store per process (survives dev-server hot reloads). */
export function getStore(): Store {
  return (g.__lavaStore ??= createStore());
}

/** tests */
export function setStore(store: Store | undefined): void {
  g.__lavaStore = store;
}
