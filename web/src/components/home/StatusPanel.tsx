// Status message of one volcano: used by the big bubble (popup) and the side panel.
// Port of _volcano_status_panel, _event_row and friends in pages/home.py.
import type { CSSProperties, ReactNode } from "react";
import {
  alertForVolcano, eventColor, mirovaFor, mirovaStyle, officialAlert, officialColor,
  officialLine, vaaSortKey, vaaStatus, type PreparedAlerts,
} from "@/lib/alertLogic";
import { timeLabel } from "@/lib/format";
import type { AlertEvent, VaacRow, Volcano } from "@/lib/types";

// (The Python panel also builds a "JMA" line but never shows it: the "Official" line already covers JMA.)

const GREY = "#667085";

function StatusLine({ title, main, sub, color = "#1a3a5c" }: { title: string; main: ReactNode; sub: ReactNode; color?: string }) {
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid #e6e9ed" }}>
      <div style={{ fontSize: 17 }}>
        <span style={{ fontWeight: 700, minWidth: 82, display: "inline-block" }}>{title}</span>
        <span style={{ color, fontWeight: 700 }}>{main}</span>
      </div>
      <div style={{ fontSize: 14, color: GREY, paddingLeft: 82, marginTop: 3, overflowWrap: "anywhere" }}>{sub}</div>
    </div>
  );
}

const advisoryBox: CSSProperties = { padding: "7px 0", borderBottom: "1px solid #e6e9ed" };

function Advisory({ row, ended }: { row: VaacRow; ended: boolean }) {
  return (
    <div style={advisoryBox}>
      <div style={{ fontWeight: 700, color: ended ? GREY : "#b42318", fontSize: 16 }}>
        {(row.source || "VAAC") + " · " + (row.advisory || "Advisory")}
      </div>
      <div style={{ fontSize: 14, color: GREY }}>
        {"Issued: " + timeLabel(row.datetime) + (ended ? " · final (no further advisories)" : "")}
      </div>
      <div style={{ fontSize: 14, overflowWrap: "anywhere" }}>{row.eruption || row.eruption_details || ""}</div>
      {row.detail_url ? (
        <a href={row.detail_url} target="_blank" rel="noreferrer" style={{ fontSize: 14 }}>View advisory</a>
      ) : null}
    </div>
  );
}

export function VolcanoStatusPanel({
  volcano, name, prepared, latestVaa = null, maxVaa = 4,
}: {
  volcano: Volcano | undefined;
  name: string;
  prepared: PreparedAlerts;
  /** newest VAA from the alert history, shown when no advisory is active now */
  latestVaa?: AlertEvent | null;
  maxVaa?: number;
}) {
  // the master calls Sakurajima "Aira"; the sources use either name
  const masterName = name === "Sakurajima" ? "Aira" : name;
  const status = vaaStatus(prepared, masterName);
  const { vaa, vrp } = alertForVolcano(prepared, masterName, status);
  const official = officialAlert(prepared.data, masterName, volcano?.n);
  const mirova = mirovaFor(prepared, masterName);
  const vaaRows = [...vaa].sort((a, b) => vaaSortKey(b) - vaaSortKey(a)).slice(0, maxVaa);

  const lat = volcano?.lat ?? "N/A";
  const lon = volcano?.lon ?? "N/A";
  const elev = volcano?.elev ?? "N/A";

  return (
    <div>
      <div className="status-title" style={{ fontSize: 26, fontWeight: 800, color: "#1a3a5c", marginBottom: 5 }}>{name}</div>
      <div style={{ fontSize: 15, color: GREY, marginBottom: 16 }}>{`${lat}° N  ·  ${lon}° E  ·  ${elev} m`}</div>
      <div style={{ paddingLeft: 12, borderLeft: "3px solid #d6e0ea" }}>
        <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>Alert Status</div>
        <StatusLine
          title="Official"
          main={officialLine(official)}
          sub={official ? "Issued: " + timeLabel(official.issued_at) : "Source not available"}
          color={official ? officialColor(official) : GREY}
        />
        {mirova && vrp !== null ? (
          <StatusLine
            title="MIROVA"
            main={`${vrp} MW`}
            sub={"Observed: " + (mirova.time || "Time unavailable") + (mirova.sensor ? " · " + mirova.sensor : "")}
            color={mirovaStyle(vrp) ?? GREY}
          />
        ) : (
          <StatusLine title="MIROVA" main="No recent thermal alert" sub="" color={GREY} />
        )}
        <div style={{ padding: "9px 0" }}>
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>VAA</div>
          {vaaRows.length > 0 ? (
            vaaRows.map((r, i) => <Advisory key={i} row={r} ended={false} />)
          ) : status.ended ? (
            <Advisory row={status.ended} ended />
          ) : (
            <div style={{ color: GREY, fontSize: 15 }}>
              No advisory active now
              {latestVaa ? (
                <div style={{ fontSize: 14, color: "#b42318", marginTop: 3 }}>
                  {`Latest: ${latestVaa.label} · ${timeLabel(latestVaa.event_time)}`}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function EventRow({ e }: { e: AlertEvent }) {
  const color = eventColor(e);
  const detail = String(e.detail ?? "").trim();
  const url = String(e.url ?? "");
  return (
    <div style={{ padding: "6px 8px 6px 10px", borderLeft: `4px solid ${color}`, marginBottom: 5, backgroundColor: "#fff" }}>
      <div>
        <span style={{ fontWeight: 700, color }}>{e.label || e.source}</span>
        <span style={{ color: GREY, fontSize: 13 }}>{" · " + timeLabel(e.event_time)}</span>
      </div>
      {detail ? (
        <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>{detail.slice(0, 180) + (detail.length > 180 ? "…" : "")}</div>
      ) : null}
      {url.startsWith("http") ? (
        <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>View</a>
      ) : null}
    </div>
  );
}
