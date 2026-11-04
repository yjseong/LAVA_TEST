"use client";
// Map Legend. Port of _legend_body, _legend_item and LEGEND_DETAILS in pages/home.py.
import { VAAC_BLUE, VAAC_RED } from "@/lib/vaacAreas";

const VAAC_URL = "https://www.data.jma.go.jp/vaac/data/index.html";
const MIROVA_URL = "https://www.mirovaweb.it/NRT/index.php";

// Official alert scales per agency. PHIVOLCS levels 0-5 follow phivolcs.dost.gov.ph/volcano-alert-levels (that
// scheme defines no colours, so the fills are display-only). Level 0 is "no alert" -> nothing is drawn.
const PHIVOLCS_LEGEND: [string, string, string][] = [
  ["L1", "#FFD400", "1 · Low-level unrest"],
  ["L2", "#FF8C00", "2 · Increasing unrest"],
  ["L3", "#E02020", "3 · Intensified / magmatic unrest"],
  ["L4", "#B000B0", "4 · Eruption imminent"],
  ["L5", "#5b0a7a", "5 · Hazardous eruption in progress"],
];

// Agency -> scope shown next to the agency name.
const LEGEND_AGENCIES: Record<string, string> = {
  JMA: "Japan", PVMBG: "Indonesia", PHIVOLCS: "Philippines", KVERT: "Kamchatka", MIROVA: "thermal", VAAC: "aviation",
};

// MIROVA volcanic radiative power classes: (short label, border colour, range)
const MIROVA_LEGEND: [string, string, string][] = [
  ["Low", "#2ecc71", "< 10 MW"],
  ["Moderate", "#f1c40f", "10 – 100 MW"],
  ["High", "#e67e22", "100 – 1,000 MW"],
  ["Very high", "#e74c3c", "1,000 – 10,000 MW"],
  ["Extreme", "#8e44ad", "> 10,000 MW"],
];

type DetailRow = [colour: string | null, mode: "fill" | "stroke" | "blink" | null, label: string, meaning: string];
interface Detail { title: string; intro: string; rows: DetailRow[]; link: [string, string] }

// Explanations shown beside the legend when an agency name is clicked.
const LEGEND_DETAILS: Record<string, Detail> = {
  JMA: {
    title: "JMA · Volcanic Alert Level (Japan)",
    intro: "Five-level scheme for the area people should keep out of. Level 1 is not drawn.",
    rows: [["#FFD400", "fill", "Level 2", "Do not approach the crater"],
           ["#FF8C00", "fill", "Level 3", "Do not approach the volcano"],
           ["#E02020", "fill", "Level 4", "Prepare to evacuate"],
           ["#B000B0", "fill", "Level 5", "Evacuate"]],
    link: ["jma.go.jp", "https://www.jma.go.jp/jma/en/Activities/volcano.html"],
  },
  PVMBG: {
    title: "PVMBG · Activity level (Indonesia)",
    intro: "Four levels. Level I (Normal) is not drawn.",
    rows: [["#FFD400", "fill", "II · Waspada", "Alert: activity above normal"],
           ["#FF8C00", "fill", "III · Siaga", "Standby: eruption may be approaching"],
           ["#B000B0", "fill", "IV · Awas", "Danger: eruption imminent or under way"]],
    link: ["magma.esdm.go.id", "https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas"],
  },
  PHIVOLCS: {
    title: "PHIVOLCS · Volcano Alert Level (Philippines)",
    intro: "Levels 0-5. Level 0 (No alert / Normal) is not drawn. PHIVOLCS defines no colours; these are display colours only.",
    rows: PHIVOLCS_LEGEND.map(([, c, t]): DetailRow => [c, "fill", "Level " + t.split(" · ")[0].replace("L", ""), t.split(" · ")[1]]),
    link: ["phivolcs.dost.gov.ph", "https://www.phivolcs.dost.gov.ph/volcano-alert-levels"],
  },
  KVERT: {
    title: "KVERT · Aviation Colour Code (Kamchatka)",
    intro: "ICAO colour code for the aviation hazard. Shown as the triangle fill.",
    rows: [["#2ecc71", "fill", "Green", "Normal background activity"],
           ["#FFD400", "fill", "Yellow", "Elevated unrest above background"],
           ["#FF8C00", "fill", "Orange", "Heightened unrest, eruption possible, or eruption with little ash"],
           ["#E02020", "fill", "Red", "Eruption imminent or in progress with significant ash"]],
    link: ["kvert.febras.net", "http://kvert.febras.net/van/"],
  },
  MIROVA: {
    title: "MIROVA · thermal anomaly (VRP)",
    intro: "Volcanic Radiative Power: heat radiated by a volcano, measured from satellite (MODIS/VIIRS) infrared data. Shown as the triangle border colour.",
    rows: MIROVA_LEGEND.map(([l, c, r]): DetailRow => [c, "stroke", l, r]),
    link: ["mirovaweb.it", MIROVA_URL],
  },
  VAAC: {
    title: "VAAC · Volcanic Ash Advisory Centres",
    intro: "Nine ICAO centres, each responsible for one region. Advisories come from Tokyo and Darwin.",
    rows: [[null, "blink", "Advisory", "Blinking triangle: an ash advisory is current"],
           [null, null, "Area (blue)", "Area of responsibility of each VAAC"],
           [VAAC_RED, null, "Selected (red)", "The VAAC area that holds the selected volcano"]],
    link: ["data.jma.go.jp/vaac", VAAC_URL],
  },
};

function LegendItem({ label, fill = "transparent", stroke = "#98a2b3", blink = false, size = 22, title }: {
  label?: string | null; fill?: string; stroke?: string; blink?: boolean; size?: number; title?: string;
}) {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 24 24'>` +
    `<polygon points='12,2 22,22 2,22' fill='${fill}' stroke='${stroke}' stroke-width='3'/></svg>`;
  return (
    <div title={title || undefined} style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="" src={"data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)}
           className={blink ? "marker-blink" : ""} style={{ width: size, height: size }} />
      {label ? <span style={{ fontSize: 12 }}>{label}</span> : <span />}
    </div>
  );
}

function Agency({ code, onChip, children }: { code: string; onChip: (code: string) => void; children: React.ReactNode }) {
  return (
    <div className="legend-agency">
      <div className="legend-head">
        <button className="legend-chip legend-chip-btn" title="Click for level descriptions" onClick={() => onChip(code)}>
          {code} ⓘ
        </button>
        <span className="legend-scope">{LEGEND_AGENCIES[code]}</span>
      </div>
      <div className="legend-items">{children}</div>
    </div>
  );
}

function LegendBody({ onChip }: { onChip: (code: string) => void }) {
  const tri = (text: string | null, fill: string, tip?: string) => <LegendItem key={(text ?? "") + fill} label={text} fill={fill} size={18} title={tip} />;
  return (
    <div>
      <Agency code="JMA" onChip={onChip}>
        {([[2, "#FFD400"], [3, "#FF8C00"], [4, "#E02020"], [5, "#B000B0"]] as const).map(([l, c]) => tri(`L${l}`, c))}
      </Agency>
      <Agency code="PVMBG" onChip={onChip}>
        {([["II", "#FFD400", "II Waspada"], ["III", "#FF8C00", "III Siaga"], ["IV", "#B000B0", "IV Awas"]] as const)
          .map(([l, c, t]) => tri(l, c, t))}
      </Agency>
      <Agency code="PHIVOLCS" onChip={onChip}>{PHIVOLCS_LEGEND.map(([l, c, t]) => tri(l, c, t))}</Agency>
      {/* KVERT is a pure colour code: triangles only, no text. */}
      <Agency code="KVERT" onChip={onChip}>
        {([["GREEN", "#2ecc71"], ["YELLOW", "#FFD400"], ["ORANGE", "#FF8C00"], ["RED", "#E02020"]] as const).map(([n, c]) => tri(null, c, n))}
      </Agency>
      <Agency code="MIROVA" onChip={onChip}>
        {MIROVA_LEGEND.map(([l, c, r]) => <LegendItem key={l} label={l} stroke={c} size={18} title={`${l}: ${r}`} />)}
      </Agency>
      <Agency code="VAAC" onChip={onChip}>
        <LegendItem label="Advisory" blink size={18} />
        <LegendItem label="None" size={18} />
        <span className="legend-text"><span style={{ color: VAAC_BLUE, fontWeight: 700 }}>▭</span> Area</span>
        <span className="legend-text"><span style={{ color: VAAC_RED, fontWeight: 700 }}>▭</span> Selected</span>
      </Agency>
      <div className="legend-foot">Fill = agency level · Border = MIROVA · click a name for details</div>
    </div>
  );
}

/** Panel body for one agency: what each legend level means. */
function LegendDetail({ code }: { code: string }) {
  const d = LEGEND_DETAILS[code];
  return (
    <>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{d.title}</div>
      {d.rows.map(([colour, mode, label, meaning]) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "2px 0" }}>
          {mode === "fill" || mode === "stroke" ? (
            <LegendItem fill={mode === "fill" ? colour ?? undefined : "transparent"} stroke={mode === "stroke" ? colour ?? undefined : "#98a2b3"} size={16} />
          ) : mode === "blink" ? (
            <LegendItem blink size={16} />
          ) : (
            <span style={{ color: colour || VAAC_BLUE, fontWeight: 700, width: 16 }}>▭</span>
          )}
          <span style={{ fontWeight: 600, minWidth: 84 }}>{label}</span>
          <span style={{ color: "#475467" }}>{meaning}</span>
        </div>
      ))}
      <a href={d.link[1]} target="_blank" rel="noreferrer" style={{ fontSize: 11, marginTop: 6 }}>{d.link[0]}</a>
    </>
  );
}

export default function Legend({ open, onToggle, detailCode, onChip }: {
  open: boolean; onToggle: () => void; detailCode: string | null; onChip: (code: string) => void;
}) {
  // The details belong to the legend: they go away while it is minimised and return when it is expanded.
  const showDetail = !!detailCode && detailCode in LEGEND_DETAILS && open;
  return (
    <div className="home-legend">
      <div className="home-legend-header">
        <span style={{ fontWeight: 700, fontSize: 14 }}>Map Legend</span>
        <button className="home-legend-toggle" title="Collapse / expand legend" onClick={onToggle}>{open ? "▾" : "▸"}</button>
      </div>
      {open ? <LegendBody onChip={onChip} /> : null}
      <div className="home-legend-detail" style={{ display: showDetail ? "flex" : "none" }}>
        {showDetail ? <LegendDetail code={detailCode!} /> : null}
      </div>
    </div>
  );
}
