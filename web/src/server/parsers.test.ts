// Parser tests on small inline fixtures shaped like the real pages (never multi-MB captures).
import { describe, expect, it } from "vitest";
import { VolcanoIndex } from "@/lib/volcanoes";
import { bulletinText, parseDarwinBulletins, parseDarwinVaa } from "./collectors/bom";
import { jmaLevelOfKind, parseJmaWarnings } from "./collectors/jma";
import { parseKvertDailyReport, parseKvertVans } from "./collectors/kvert";
import { parseMirova } from "./collectors/mirova";
import { parsePhivolcs } from "./collectors/phivolcs";
import { parsePvmbg } from "./collectors/pvmbg";
import { parseTokyoRecentList } from "./collectors/tokyo";
import { eventTimeIso } from "./time";

const index = new VolcanoIndex();

describe("BoM bulletin feed", () => {
  const bulletin = (over: Record<string, string> = {}) =>
    [
      "VA ADVISORY",
      `DTG: ${over.dtg ?? "20261104/0540Z"}`,
      `VAAC: ${over.vaac ?? "DARWIN"}`,
      `VOLCANO: ${over.volcano ?? "DUKONO 268010"}`,
      "PSN: N0149 E12753",
      `ADVISORY NR: ${over.nr ?? "2026/961"}`,
      `ERUPTION DETAILS: ${over.details ?? "VA TO FL080 OBS AT 04/0520Z MOV NW"}`,
      `NXT ADVISORY: ${over.next ?? "WILL BE ISSUED BY 20261104/1140Z="}`,
    ].join("\n");

  it("splits the feed per bulletin and names the issuing VAAC", () => {
    const html = `<html><head><script>var x = "VA ADVISORY";</script></head><body><pre>${bulletin()}\n\n\n${bulletin({
      vaac: "BUENOS AIRES",
      volcano: "NEVADOS DE CHILLAN 357070",
      nr: "2026/044",
      next: "NO FURTHER ADVISORIES=",
    })}</pre></body></html>`;
    const rows = parseDarwinBulletins(bulletinText(html), "U");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      volcano: "DUKONO", // the 6-digit volcano number is stripped
      advisory: "2026/961",
      datetime: "20261104/0540Z",
      source: "Darwin VAAC",
      is_terminal: false,
      eruption: "VA TO FL080 OBS AT 04/0520Z MOV NW",
      detail_url: "U",
    });
    expect(rows[1]).toMatchObject({ source: "Buenos Aires VAAC", issuer: "BUENOS AIRES", is_terminal: true });
  });

  it("ignores blocks without a volcano, an advisory number or a time", () => {
    expect(parseDarwinVaa("VAAC: DARWIN\nADVISORY NR: 1")).toBeNull();
    expect(parseDarwinBulletins("VA ADVISORY\nVOLCANO: X 123456\nDTG: 20261104/0000Z", null)).toEqual([]);
  });
});

describe("Tokyo VAAC list", () => {
  it("reads the hidden UTC column and the advisory link", () => {
    const html = `<table><tbody id="tbd1">
      <tr><td>2026/11/04 00:33:00</td><td>x</td><td>SHEVELUCH</td><td>RUSSIA</td><td>2026/366</td><td><a href="TextData/a.html">T</a></td></tr>
      <tr><td>garbage</td><td>x</td><td>BAD</td><td>X</td><td>1</td><td></td></tr>
      <tr><td>2026/11/03 11:50:00</td><td></td><td>MAYON</td><td>PHILIPPINES</td><td>2026/821</td></tr>
    </tbody></table>`;
    const rows = parseTokyoRecentList(html);
    expect(rows).toHaveLength(1); // the short row and the unparsable time are skipped
    expect(rows[0]).toMatchObject({
      volcano: "SHEVELUCH",
      area: "RUSSIA",
      advisory: "2026/366",
      datetime: "2026-11-04T00:33:00+00:00",
      source: "Tokyo VAAC",
      detail_url: "https://www.data.jma.go.jp/vaac/data/TextData/a.html",
    });
  });
});

describe("MIROVA", () => {
  it("skips each table's header row and rows without a numeric id", () => {
    const html = `<table>
      <tr><th>Time</th><th>ID</th><th>Name</th><th>VRP</th><th>x</th><th>Sensor</th></tr>
      <tr><td>29-Oct-2026 23:24:02</td><td>282080</td><td>Sakurajima</td><td>1,234.5</td><td>-</td><td>VIIRS</td></tr>
      <tr><td>29-Oct-2026 23:24:02</td><td>n/a</td><td>Bad</td><td>1</td><td>-</td><td>MODIS</td></tr>
      <tr><td>29-Oct-2026 20:00:00</td><td>211040</td><td>Stromboli</td><td>13.15</td><td>-</td></tr>
    </table>`;
    const rows = parseMirova(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ volcano: "Sakurajima", our_name: "Sakurajima", is_target: true, volcano_id: 282080, vrp_mw: "1,234.5", sensor: "VIIRS" });
    expect(rows[1]).toMatchObject({ volcano: "Stromboli", our_name: null, is_target: false, sensor: "" });
  });
});

describe("PVMBG", () => {
  const page = (counts: [number, number, number, number]) => `<div><h3>Daftar Tingkat Aktivitas Gunung Api</h3><table>
    <tr><td>Level IV (Awas)</td><td>${counts[3]}</td></tr>
    <tr><td>Level III (Siaga)</td><td>${counts[2]}</td><td><a href="/v1/gunung-api/laporan/1">Anak Krakatau - Lampung <small>Lihat laporan</small></a></td></tr>
    <tr><td>Level II (Waspada)</td><td>${counts[1]}</td><td><a href="/v1/gunung-api/laporan/2">Bromo - Jawa Timur</a></td></tr>
    <tr><td>Level I (Normal)</td><td>${counts[0]}</td><td><a href="/v1/gunung-api/laporan/3">Nowhere-ville - Jawa</a></td></tr>
  </table></div>`;

  it("reads level sections, resolves names (alias crosswalk) and ignores unknown volcanoes", () => {
    const rows = parsePvmbg(page([1, 1, 1, 0]), index);
    expect(rows.map((r) => [r.volcano_number, r.level, r.label])).toEqual([
      [262000, "3", "PVMBG Level III (Siaga)"],
      [263310, "2", "PVMBG Level II (Waspada)"],
    ]);
  });

  it("raises when the reported count does not match what was parsed (a changed page must not replace a good snapshot)", () => {
    expect(() => parsePvmbg(page([1, 5, 1, 0]), index)).toThrow(/incomplete/);
    expect(() => parsePvmbg("<table><tr><td>nothing</td></tr></table>", index)).toThrow(/not found/);
  });
});

describe("PHIVOLCS", () => {
  it("accepts levels 0-5 of Philippine volcanoes only", () => {
    const html = `<div id="scroll-text">
      <span class="scroll-item">Kanlaon - 2</span><span class="scroll-item">Pinatubo - 0</span>
      <span class="scroll-item">Kanlaon - 9</span><span class="scroll-item">Fuji - 1</span><span class="scroll-item">garbage</span></div>`;
    const rows = parsePhivolcs(html, index);
    expect(rows.map((r) => [(r.raw as { name: string }).name, r.level])).toEqual([
      ["Kanlaon", "2"],
      ["Pinatubo", "0"],
    ]);
    expect(rows[0].label).toBe("PHIVOLCS Alert Level 2 · Increasing unrest");
  });
});

describe("KVERT", () => {
  it("reads a Daily Report: only codes inside the volcano heading, never the legend", () => {
    const html = `<div><b>KVERT DAILY REPORT</b> November 4, 2026, all time is UTC
      <b>Sheveluch VOLCANO (CAVW #300270), Aviation Colour Code is ORANGE</b> text
      <b>Klyuchevskoy VOLCANO (CAVW #300260), Aviation Colour Code is YELLOW</b></div>
      <div><b>Legend</b> Aviation Colour Code is GREEN</div>`;
    const rows = parseKvertDailyReport(html, index);
    expect(rows.map((r) => [r.volcano_number, r.level, r.issued_at])).toEqual([
      [300270, "ORANGE", "2026-11-04T00:00:00+00:00"],
      [300260, "YELLOW", "2026-11-04T00:00:00+00:00"],
    ]);
  });

  it("reads a numbered VAN when there is no Daily Report (same row as the Python parser on the real page)", () => {
    const html = `<table><tr><td><b>(1) KVERT VOLCANIC ACTIVITY NOTICE (VAN)</b></td></tr>
      <tr><td>(2) Issued:</td><td>20261104/0157Z</td></tr>
      <tr><td>(3) Volcano:</td><td>Sheveluch (CAVW #300270)</td></tr>
      <tr><td>(4) Current aviation colour code:</td><td><b><font color='RED'>RED</font></b></td></tr></table>`;
    const rows = parseKvertVans(html, index);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ volcano_number: 300270, level: "RED", issued_at: "2026-11-04T01:57:00+00:00", label: "KVERT RED" });
  });

  it("reads VONA text from the Telegram mirror and keeps the latest issue per volcano", () => {
    const html = `<div class="tgme_widget_message_text">VONA DTG: 20261103/2300Z VOLCANO: SHEVELUCH 300270
        Current aviation color code: ORANGE</div>
      <div class="tgme_widget_message_text">VONA DTG: 20261104/0300Z VOLCANO: SHEVELUCH 300270
        Current aviation color code: RED</div>`;
    const rows = parseKvertVans(html, index);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: "RED", issued_at: "2026-11-04T03:00:00+00:00" });
  });
});

describe("JMA (JSON instead of Selenium)", () => {
  const report = (eventId: string, kind: string, areaCode: string, jpName: string, at: string) => ({
    reportDatetime: at,
    eventId,
    volcanoInfos: [
      { type: "噴火警報・予報（対象火山）", items: [{ name: "x", code: kind, areas: [{ name: jpName, code: areaCode }] }] },
      { type: "噴火警報・予報（対象市町村等）", items: [{ name: "y", code: "02", areas: [{ name: "city", code: "1" }] }] },
    ],
  });
  const names = new Map([
    ["329", "Ioto"],
    ["506", "Sakurajima"],
    ["323", "Beyonesu(Bayonnaise) Rocks"],
    ["505", "Kaimondake"],
  ]);

  it("maps kind codes to levels like the map's q() and keeps level 1", () => {
    expect(["15", "25", "14", "13", "23", "36", "12", "22", "11", "21", "35", "05", "01"].map(jmaLevelOfKind)).toEqual([5, 5, 4, 3, 3, 3, 2, 2, 1, 1, 1, 0, 0]);
    const out = parseJmaWarnings(
      [
        report("329", "22", "329", "硫黄島", "2007-12-01T10:01:00+09:00"),
        report("506", "13", "506", "桜島", "2022-07-27T20:00:00+09:00"),
        report("323", "35", "323", "ベヨネース列岩", "2026-10-08T11:00:00+09:00"),
        report("505", "05", "505", "開聞岳", "2026-01-01T00:00:00+09:00"), // forecast only: level 0, not listed
        report("901", "13", "900", "全国", "2026-01-01T00:00:00+09:00"), // not a volcano
      ],
      names,
    );
    expect(out.raw).toEqual({ Ioto: 2, Sakurajima: 3, "Beyonesu(Bayonnaise) Rocks": 1 });
    expect(out.issued).toEqual({
      Ioto: "2007-12-01 01:01 UTC", // JST in, UTC out
      Sakurajima: "2022-07-27 11:00 UTC",
      "Beyonesu(Bayonnaise) Rocks": "2026-10-08 02:00 UTC",
    });
  });

  it("falls back to the Japanese name when the code is unknown", () => {
    expect(parseJmaWarnings([report("999", "12", "999", "未知山", "2026-01-01T00:00:00+09:00")], new Map()).raw).toEqual({ 未知山: 2 });
  });
});

describe("eventTimeIso", () => {
  it.each([
    ["20261030/0050Z", "2026-10-30T00:50:00+00:00"],
    ["2026-10-12 06:04 UTC", "2026-10-12T06:04:00+00:00"],
    ["2026-10-12T06:04:00+00:00", "2026-10-12T06:04:00+00:00"],
    ["2026-10-12T15:04:00+09:00", "2026-10-12T06:04:00+00:00"],
    ["29-Oct-2026 23:24:02", "2026-10-29T23:24:02+00:00"],
    ["Oct 21, 2026 06:03", "2026-10-21T06:03:00+00:00"],
  ])("%s -> %s", (input, expected) => {
    expect(eventTimeIso(input)).toBe(expected);
  });
  it("returns the fallback for nothing / garbage / impossible dates", () => {
    expect(eventTimeIso(null, "F")).toBe("F");
    expect(eventTimeIso("", "F")).toBe("F");
    expect(eventTimeIso("soon", "F")).toBe("F");
    expect(eventTimeIso("20261340/0000Z", "F")).toBe("F");
  });
});
