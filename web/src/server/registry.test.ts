import { describe, expect, it } from "vitest";
import type { AlertEvent, VaacRow } from "@/lib/types";
import { VolcanoIndex } from "@/lib/volcanoes";
import type { AlertInput } from "./collectors/types";
import { dedupeEvents, isStale, normalizeJma, normalizeVaac, readAlerts, readEvents, RegistryTx, STALE_AFTER_MS } from "./registry";
import { MemoryStore } from "./store";

const index = new VolcanoIndex();
const NOW = "2026-11-04T06:00:00+00:00";
const pvmbg = (n: number, level: string): AlertInput => ({
  volcano_number: n, alert_type: "volcano_level", level, label: `PVMBG Level ${level}`, source_url: "u",
});

async function tx(store: MemoryStore, fn: (t: RegistryTx) => void) {
  const t = await RegistryTx.open(store);
  fn(t);
  await t.commit();
}

describe("upsertAlerts", () => {
  it("replaces a source's alerts on success, even with an EMPTY list (empty success clears)", async () => {
    const s = new MemoryStore();
    await tx(s, (t) => t.upsertAlerts("PVMBG", [pvmbg(262000, "3"), pvmbg(263310, "2")], { now: NOW }));
    expect(Object.keys((await readAlerts(s)).by_number).sort()).toEqual(["262000", "263310"]);
    await tx(s, (t) => t.upsertAlerts("PVMBG", [pvmbg(262000, "4")], { now: NOW }));
    const after = await readAlerts(s);
    expect(Object.keys(after.by_number)).toEqual(["262000"]);
    expect(after.by_number["262000"][0]).toMatchObject({ level: "4", label: "PVMBG Level 4", fetched_at: NOW });
    await tx(s, (t) => t.upsertAlerts("PVMBG", [], { now: NOW }));
    expect((await readAlerts(s)).by_number).toEqual({});
  });

  it("a FAILED refresh never clears the previous alerts; they go stale only after 6 h without a success", async () => {
    const s = new MemoryStore();
    await tx(s, (t) => t.upsertAlerts("PVMBG", [pvmbg(262000, "3")], { now: NOW }));
    await tx(s, (t) => t.upsertAlerts("PVMBG", [], { success: false, error: "timeout", now: "2026-11-04T06:05:00+00:00" }));
    const justAfter = await readAlerts(s, Date.parse("2026-11-04T07:00:00+00:00"));
    expect(justAfter.by_number["262000"][0].stale).toBe(false); // a single failed attempt must not blank the colours
    expect(justAfter.sources.PVMBG).toMatchObject({ status: "error", error: "timeout", last_success: NOW, last_attempt: "2026-11-04T06:05:00+00:00" });
    const later = await readAlerts(s, Date.parse(NOW) + STALE_AFTER_MS + 60_000);
    expect(later.by_number["262000"][0].stale).toBe(true);
  });

  it("alerts of a source without any recorded status count as stale", () => {
    expect(isStale(undefined)).toBe(true);
    expect(isStale({ status: "ok" })).toBe(false);
    expect(isStale({ status: "error", last_success: null })).toBe(true);
  });

  it("keeps the most recent advisory when a source lists one volcano twice", async () => {
    const s = new MemoryStore();
    const row = (issued: string, level: string): AlertInput => ({ ...pvmbg(262000, level), alert_type: "aviation_code", issued_at: issued });
    await tx(s, (t) => t.upsertAlerts("KVERT", [row("2026-11-04T00:00:00+00:00", "ORANGE"), row("2026-11-03T00:00:00+00:00", "RED")], { now: NOW }));
    expect((await readAlerts(s)).by_number["262000"]).toHaveLength(1);
    expect((await readAlerts(s)).by_number["262000"][0].level).toBe("ORANGE");
  });

  it("an unresolved volcano number raises and changes nothing", async () => {
    const s = new MemoryStore();
    await tx(s, (t) => t.upsertAlerts("PVMBG", [pvmbg(262000, "3")], { now: NOW }));
    const t = await RegistryTx.open(s);
    expect(() => t.upsertAlerts("PVMBG", [{ ...pvmbg(262000, "4") }, { ...pvmbg(0, "2"), volcano_number: null }], { now: NOW })).toThrow(/Unresolved/);
    await t.commit();
    expect((await readAlerts(s)).by_number["262000"][0].level).toBe("3");
  });
});

describe("alert history", () => {
  it("writes one event per alert, with the source's issue time when it has one", async () => {
    const s = new MemoryStore();
    await tx(s, (t) =>
      t.upsertAlerts("JMA", [{ volcano_number: 282080, alert_type: "volcano_level", level: "3", label: "JMA Level 3", issued_at: "2022-07-27 11:00 UTC", source_url: "j" }], { now: NOW }),
    );
    const events = await readEvents(s, "2000-01-01T00:00:00+00:00");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ volcano_number: 282080, source: "JMA", kind: "volcano_level", label: "JMA Level 3", event_time: "2022-07-27T11:00:00+00:00", first_seen: NOW });
  });

  it("without an issue time (PVMBG) a refresh adds a row only when the label CHANGED", async () => {
    const s = new MemoryStore();
    await tx(s, (t) => t.upsertAlerts("PVMBG", [pvmbg(262000, "2")], { now: "2026-11-04T06:00:00+00:00" }));
    await tx(s, (t) => t.upsertAlerts("PVMBG", [pvmbg(262000, "2")], { now: "2026-11-04T06:30:00+00:00" })); // same: no new row
    await tx(s, (t) => t.upsertAlerts("PVMBG", [pvmbg(262000, "3")], { now: "2026-11-04T07:00:00+00:00" })); // changed
    await tx(s, (t) => t.upsertAlerts("PVMBG", [pvmbg(262000, "2")], { now: "2026-11-04T07:30:00+00:00" })); // changed back
    const events = await readEvents(s, "2000-01-01T00:00:00+00:00", 262000);
    expect(events.map((e) => [e.label, e.event_time])).toEqual([
      ["PVMBG Level 2", "2026-11-04T07:30:00+00:00"],
      ["PVMBG Level 3", "2026-11-04T07:00:00+00:00"],
      ["PVMBG Level 2", "2026-11-04T06:00:00+00:00"],
    ]);
  });

  it("the same event seen again (same identity) is ignored, within a batch and across refreshes", async () => {
    const s = new MemoryStore();
    const e = { volcano_number: 282080, source: "MIROVA", kind: "thermal", label: "MIROVA 5 MW", level: "5", event_time: "29-Oct-2026 23:24:02" };
    await tx(s, (t) => t.recordEvents([e, e], NOW));
    await tx(s, (t) => t.recordEvents([e], "2026-11-04T07:00:00+00:00"));
    const events = await readEvents(s, "2000-01-01T00:00:00+00:00");
    expect(events).toHaveLength(1);
    expect(events[0].event_time).toBe("2026-10-29T23:24:02+00:00");
    expect(events[0].first_seen).toBe(NOW);
  });

  it("dedupeEvents keeps the more specific label per minute and sorts newest first", () => {
    const base = { volcano_number: 1, source: "Tokyo VAAC", kind: "vaa", level: null, detail: null, url: null, first_seen: NOW };
    const events: AlertEvent[] = [
      { ...base, label: "Tokyo VAAC VAA", event_time: "2026-11-04T00:33:10+00:00" },
      { ...base, label: "Tokyo VAAC VAA 2026/366", event_time: "2026-11-04T00:33:50+00:00" },
      { ...base, label: "Tokyo VAAC VAA 2026/367", event_time: "2026-11-04T05:00:00+00:00" },
    ];
    expect(dedupeEvents(events).map((e) => e.label)).toEqual(["Tokyo VAAC VAA 2026/367", "Tokyo VAAC VAA 2026/366"]);
  });
});

describe("normalizers", () => {
  it("normalizeJma resolves through JMA_NAME_MAP inside Japan; unknown names are reported, never guessed", () => {
    const { alerts, unresolved } = normalizeJma(
      index,
      { Sakurajima: 3, "Kirishimayama(Shinmoedake)": 2, "Nowhere Rock": 2, Asosan: 1 },
      { Sakurajima: "2022-07-27 11:00 UTC" },
    );
    expect(alerts.map((a) => [a.volcano_number, a.level, a.label, a.issued_at ?? null])).toEqual([
      [282080, "3", "JMA Level 3", "2022-07-27 11:00 UTC"],
      [282090, "2", "JMA Level 2", null],
      [282110, "1", "JMA Level 1", null],
    ]);
    expect(unresolved).toEqual(["Nowhere Rock"]);
  });

  it("normalizeVaac skips terminal advisories and finds the volcano number inside the name", () => {
    const row = (over: Partial<VaacRow>): VaacRow => ({
      volcano: "DUKONO", advisory: "1", eruption: "", datetime: "20261104/0540Z", detail_url: "u", source: "Darwin VAAC",
      issuer: "DARWIN", eruption_details: "", next_advisory: "", is_terminal: false, ...over,
    });
    const { alerts, unresolved } = normalizeVaac(index, [
      row({}),
      row({ volcano: "SAKURAJIMA (AIRA CALDERA)" }),
      row({ volcano: "SOMETHING 282090" }),
      row({ volcano: "DUKONO", is_terminal: true }),
      row({ volcano: "UNKNOWNIUM" }),
    ]);
    expect(alerts.map((a) => a.volcano_number)).toEqual([expect.any(Number), 282080, 282090]);
    expect(alerts[0]).toMatchObject({ alert_type: "vaa", level: "ACTIVE", label: "Darwin VAAC VAA", issued_at: "20261104/0540Z" });
    expect(unresolved).toEqual(["UNKNOWNIUM"]);
  });
});
