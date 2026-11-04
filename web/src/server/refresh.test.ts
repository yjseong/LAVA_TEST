// refreshSources / getAlertPayload / manualRefresh / routes with stubbed collectors (no network).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload, EventsResponse, MirovaRow, VaacRow } from "@/lib/types";
import type { AlertInput } from "./collectors/types";
import { getAlertPayload, manualRefresh, buildPayload } from "./payload";
import { _setTestDeps, refreshSources, SNAPSHOT_KEY, type RefreshDeps, type Snapshot } from "./refresh";
import { readEvents } from "./registry";
import { MemoryStore, setStore } from "./store";

const vaac = (over: Partial<VaacRow> = {}): VaacRow => ({
  volcano: "SAKURAJIMA (AIRA CALDERA)", advisory: "2026/1", eruption: "VA TO FL080", datetime: "20261104/0540Z", detail_url: "u",
  source: "Tokyo VAAC", issuer: "TOKYO", eruption_details: "VA TO FL080", next_advisory: "", is_terminal: false, ...over,
});
const mirova = (): MirovaRow => ({ volcano: "Sakurajima", our_name: "Sakurajima", is_target: true, volcano_id: 282080, time: "04-Nov-2026 03:30:00", vrp_mw: "13.15", sensor: "VIIRS" });
const pvmbg = (level: string): AlertInput[] => [{ volcano_number: 262000, alert_type: "volcano_level", level, label: `PVMBG Level ${level}`, source_url: "u" }];

function stubs() {
  const calls = { bom: 0, tokyo: 0, jma: 0, mirova: 0, PVMBG: 0, KVERT: 0, PHIVOLCS: 0 };
  const state: { bom: () => Promise<VaacRow[]>; jma: () => Promise<{ raw: Record<string, number>; issued: Record<string, string> }>; pvmbg: () => Promise<AlertInput[]> } = {
    bom: async () => [vaac()],
    jma: async () => ({ raw: { Sakurajima: 3, Ioto: 2 }, issued: { Sakurajima: new Date().toISOString().slice(0, 10) + " 02:00 UTC", Ioto: "2007-12-01 01:01 UTC" } }),
    pvmbg: async () => pvmbg("3"),
  };
  const deps: RefreshDeps = {
    getDarwinVaacTable: async () => (calls.bom++, state.bom()),
    getVaacRecentList: async () => (calls.tokyo++, [vaac({ advisory: "2026/366", datetime: "2026-11-04T00:33:00+00:00", area: "JAPAN" })]),
    getJmaAlerts: async () => (calls.jma++, state.jma()),
    getMirovaAlerts: async () => (calls.mirova++, [mirova()]),
    official: {
      PVMBG: async () => (calls.PVMBG++, state.pvmbg()),
      KVERT: async () => (calls.KVERT++, [{ volcano_number: 300270, alert_type: "aviation_code", level: "RED", label: "KVERT RED", issued_at: "2026-11-04T01:57:00+00:00" }]),
      PHIVOLCS: async () => (calls.PHIVOLCS++, [{ volcano_number: 273030, alert_type: "volcano_level", level: "2", label: "PHIVOLCS Alert Level 2" }]),
    },
  };
  return { calls, state, deps };
}

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setStore(store);
});
afterEach(() => {
  _setTestDeps(undefined);
  setStore(undefined);
  vi.restoreAllMocks();
});

describe("refreshSources", () => {
  it("fetches everything, fills the registry and history, and publishes a snapshot", async () => {
    const { deps, calls } = stubs();
    const result = await refreshSources({ store, deps });
    expect(result).toMatchObject({ status: "refreshed", errors: {} });
    expect(calls).toMatchObject({ bom: 1, tokyo: 1, jma: 1, mirova: 1, PVMBG: 1, KVERT: 1, PHIVOLCS: 1 });

    const snap = await store.getJson<Snapshot>(SNAPSHOT_KEY);
    expect(snap).toMatchObject({ jma_raw: { Sakurajima: 3 } });
    expect(snap!.vaac_rows).toHaveLength(1);

    const payload = await buildPayload(store);
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(Object.keys(payload.registry.sources).sort()).toEqual(["JMA", "KVERT", "PHIVOLCS", "PVMBG", "VAAC"]);
    expect(payload.registry.by_number["282080"].map((a) => a.source).sort()).toEqual(["JMA", "VAAC"]);
    expect(payload.registry.by_number["262000"][0]).toMatchObject({ source: "PVMBG", level: "3", stale: false });

    const history = await readEvents(store, "2000-01-01T00:00:00+00:00");
    const kinds = history.map((e) => `${e.source}/${e.kind}`).sort();
    expect(kinds).toEqual(["JMA/volcano_level", "KVERT/aviation_code", "MIROVA/thermal", "PHIVOLCS/volcano_level", "PVMBG/volcano_level", "Tokyo VAAC/vaa", "VAAC/vaa"]);
    // Ioto's alert dates from 2007: it is a CURRENT alert (registry) but far outside the history retention, so it
    // is not written into the history at all
    expect(payload.registry.by_number["329"]).toBeUndefined(); // (329 is JMA's own code, not a GVP number)
    expect(Object.values(payload.registry.by_number).flat().some((a) => a.source === "JMA" && a.issued_at === "2007-12-01 01:01 UTC")).toBe(true);
    expect(history.filter((e) => e.source === "JMA")).toHaveLength(1);
  });

  it("second refresh right away: VAAC and MIROVA again, but JMA (10 min), PVMBG/KVERT/PHIVOLCS (30 min) are throttled", async () => {
    const { deps, calls } = stubs();
    await refreshSources({ store, deps });
    await refreshSources({ store, deps });
    expect(calls).toMatchObject({ bom: 2, tokyo: 2, mirova: 2, jma: 1, PVMBG: 1, KVERT: 1, PHIVOLCS: 1 });
    // a manual refresh shortens only the JMA window (60 s): still cached right after a fetch
    await refreshSources({ store, deps, force: true });
    expect(calls.jma).toBe(1);
  });

  it("a failed official source is retried after 5 min, keeps its last alerts, and records the error", async () => {
    const { deps, state, calls } = stubs();
    await refreshSources({ store, deps });
    // age PVMBG's last attempt by 31 min -> due again
    const old = new Date(Date.now() - 31 * 60_000).toISOString().replace(/\.\d+Z$/, "+00:00");
    const reg = (await store.getJson<{ sources: Record<string, { last_attempt: string }> }>("registry"))!;
    reg.sources.PVMBG.last_attempt = old;
    await store.setJson("registry", reg);
    state.pvmbg = async () => {
      throw new Error("PVMBG layout changed");
    };
    const r = await refreshSources({ store, deps });
    expect(calls.PVMBG).toBe(2);
    expect(r.errors.PVMBG).toMatch(/layout changed/);
    const p = await buildPayload(store);
    expect(p.registry.sources.PVMBG).toMatchObject({ status: "error", error: "PVMBG layout changed" });
    expect(p.registry.by_number["262000"][0]).toMatchObject({ level: "3", stale: false }); // previous value kept, not stale yet
    // ... and an immediate retry is NOT made (5 min wait after a failure)
    await refreshSources({ store, deps });
    expect(calls.PVMBG).toBe(2);
  });

  it("a failing core source keeps its previous values; an EMPTY JMA answer is not believed", async () => {
    const { deps, state } = stubs();
    await refreshSources({ store, deps });
    state.bom = async () => {
      throw new Error("BoM down");
    };
    state.jma = async () => ({ raw: {}, issued: {} });
    // make JMA due again (cache window passed)
    const snap = (await store.getJson<Snapshot>(SNAPSHOT_KEY))!;
    snap.jma_fetched_ms = Date.now() - 11 * 60_000;
    await store.setJson(SNAPSHOT_KEY, snap);
    const r = await refreshSources({ store, deps });
    expect(r.status).toBe("refreshed");
    expect(r.errors.BoM).toMatch(/BoM down/);
    expect(r.errors.JMA).toMatch(/empty/);
    const p = await buildPayload(store);
    expect(p.vaac_rows).toHaveLength(1);
    expect(Object.keys(p.jma_raw).sort()).toEqual(["Ioto", "Sakurajima"]);
  });

  it("one refresh at a time: a concurrent caller is told to skip", async () => {
    const { deps } = stubs();
    const slow: RefreshDeps = { ...deps, getMirovaAlerts: () => new Promise((r) => setTimeout(() => r([mirova()]), 80)) };
    const [a, b] = await Promise.all([refreshSources({ store, deps: slow }), refreshSources({ store, deps: slow })]);
    expect([a.status, b.status].sort()).toEqual(["refreshed", "skipped"]);
    // lock released afterwards
    expect((await refreshSources({ store, deps })).status).toBe("refreshed");
  });

  it("nothing reachable and nothing stored: no empty snapshot is published", async () => {
    const down = async () => {
      throw new Error("offline");
    };
    const r = await refreshSources({
      store,
      deps: { getDarwinVaacTable: down, getJmaAlerts: down, getMirovaAlerts: down, getVaacRecentList: down, official: {} },
    });
    expect(r.status).toBe("failed");
    expect(await store.getJson(SNAPSHOT_KEY)).toBeNull();
  });
});

describe("getAlertPayload (refresh policy)", () => {
  it("cold start waits for the first refresh and returns its data", async () => {
    const { deps, calls } = stubs();
    _setTestDeps(deps);
    const p = await getAlertPayload(store);
    expect(calls.bom).toBe(1);
    expect(p.vaac_rows).toHaveLength(1);
    expect(p.timestamp).not.toBeNull();
  });

  it("fresh snapshot: served as is, no refresh", async () => {
    const { deps, calls } = stubs();
    _setTestDeps(deps);
    await getAlertPayload(store);
    await getAlertPayload(store);
    expect(calls.bom).toBe(1);
  });

  it("stale snapshot: served immediately, and refreshed behind the response", async () => {
    const { deps, calls, state } = stubs();
    _setTestDeps(deps);
    await getAlertPayload(store);
    const snap = (await store.getJson<Snapshot>(SNAPSHOT_KEY))!;
    snap.fetched_ms = Date.now() - 5 * 60_000;
    await store.setJson(SNAPSHOT_KEY, snap);
    state.bom = async () => [vaac(), vaac({ advisory: "2026/2" })];
    const served = await getAlertPayload(store);
    expect(served.vaac_rows).toHaveLength(1); // the OLD data, no waiting
    await vi.waitFor(() => expect(calls.bom).toBe(2)); // outside a request scope after() falls back to fire-and-forget
    await vi.waitFor(async () => expect((await buildPayload(store)).vaac_rows).toHaveLength(2));
  });

  it("an unchanged refresh keeps the same sig; a changed alert changes it", async () => {
    const { deps, state } = stubs();
    await refreshSources({ store, deps });
    const a = await buildPayload(store);
    await refreshSources({ store, deps });
    const b = await buildPayload(store);
    expect(b.sig).toBe(a.sig);
    expect(b.timestamp).toBeDefined();
    state.bom = async () => [vaac({ advisory: "2026/9" })];
    await refreshSources({ store, deps });
    expect((await buildPayload(store)).sig).not.toBe(a.sig);
  });

  it("manual refresh: waits for the result, and a second press within 15 s is rate limited", async () => {
    const { deps, calls } = stubs();
    _setTestDeps(deps);
    const first = await manualRefresh(store, 5000);
    expect(first.refreshed).toBe(true);
    expect(first.payload.vaac_rows).toHaveLength(1);
    const second = await manualRefresh(store, 5000);
    expect(second.refreshed).toBe(false);
    expect(calls.bom).toBe(1);
  });
});

describe("API routes", () => {
  it("GET /api/alerts -> AlertPayload with edge cache headers", async () => {
    _setTestDeps(stubs().deps);
    const { GET } = await import("@/app/api/alerts/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=20, stale-while-revalidate=60");
    const body = (await res.json()) as AlertPayload;
    expect(Object.keys(body).sort()).toEqual(["jma_issued", "jma_raw", "mirova_rows", "registry", "sig", "timestamp", "vaac_rows"]);
    expect(body.registry.by_number["282080"]).toBeDefined();
  });

  it("GET /api/events: windows, per-volcano view, parameter validation", async () => {
    await refreshSources({ store, deps: stubs().deps });
    const { GET } = await import("@/app/api/events/route");
    const all = (await (await GET(new Request("http://x/api/events?days=7"))).json()) as EventsResponse;
    expect(all.events.length).toBeGreaterThan(3);
    const one = (await (await GET(new Request("http://x/api/events?days=30&number=282080"))).json()) as EventsResponse;
    expect(one.events.length).toBeGreaterThan(0);
    expect(one.events.every((e) => e.volcano_number === 282080)).toBe(true);
    for (const bad of ["days=0", "days=abc", "days=7&number=-1", "days=7&limit=0"]) {
      expect((await GET(new Request("http://x/api/events?" + bad))).status).toBe(400);
    }
  });

  it("POST /api/refresh answers with the payload; the repeat is marked throttled", async () => {
    _setTestDeps(stubs().deps);
    const { POST } = await import("@/app/api/refresh/route");
    const a = await POST();
    expect(a.headers.get("x-refresh")).toBe("started");
    expect(((await a.json()) as AlertPayload).vaac_rows).toHaveLength(1);
    expect((await POST()).headers.get("x-refresh")).toBe("throttled");
  });

  it("GET /api/cron/refresh insists on CRON_SECRET when it is set", async () => {
    _setTestDeps(stubs().deps);
    const { GET } = await import("@/app/api/cron/refresh/route");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await GET(new Request("http://x/api/cron/refresh"))).status).toBe(401);
    expect((await GET(new Request("http://x/api/cron/refresh", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    const ok = await GET(new Request("http://x/api/cron/refresh", { headers: { authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("refreshed");
    vi.unstubAllEnvs();
  });
});
