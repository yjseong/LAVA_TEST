"use client";
// Slide-in side panel: the selected volcano (30 days) or all active alerts (7 days).
import type { PreparedAlerts, AlertGroup } from "@/lib/alertLogic";
import { eventColor } from "@/lib/alertLogic";
import type { AlertEvent, AlertPayload } from "@/lib/types";
import { volcanoByNumber } from "@/lib/volcanoes";
import { EventRow, VolcanoStatusPanel } from "./StatusPanel";
import type { Selected } from "./types";

export const WINDOW_SELECTED_DAYS = 30;
export const WINDOW_ALL_DAYS = 7;

export default function SidePanel({
  open, data, prepared, selected, selectedEvents, cards, onClose, onClear, onPickCard,
}: {
  open: boolean;
  data: AlertPayload | null;
  prepared: PreparedAlerts;
  selected: Selected | null;
  selectedEvents: AlertEvent[];
  cards: AlertGroup[];
  onClose: () => void;
  onClear: () => void;
  onPickCard: (number: number, name: string) => void;
}) {
  const sources = data?.registry?.sources ?? {};
  const sourceNote = ["JMA", "PVMBG", "PHIVOLCS", "KVERT"].map((n) => `${n}: ${sources[n]?.status ?? "not collected"}`).join(" · ");
  const footer = (
    <div style={{ fontSize: 12, color: "#666", marginTop: 14 }}>
      {"Last refresh: " + (data?.timestamp ?? "N/A") + " | " + sourceNote}
      <div style={{ marginTop: 3 }}>History is recorded from the first run; levels issued before the window are not listed.</div>
    </div>
  );

  let title = `Active Alerts · last ${WINDOW_ALL_DAYS} days`;
  let body: React.ReactNode;
  if (selected?.name) {
    title = selected.name;
    const volcano = selected.number !== null ? volcanoByNumber(selected.number) : undefined;
    body = (
      <div>
        <div>
          <VolcanoStatusPanel
            volcano={volcano} name={selected.name} prepared={prepared}
            latestVaa={selectedEvents.find((e) => e.kind === "vaa") ?? null}
          />
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, margin: "16px 0 6px" }}>
              {`Recent alerts · last ${WINDOW_SELECTED_DAYS} days (${selectedEvents.length})`}
            </div>
            {selectedEvents.length > 0
              ? selectedEvents.slice(0, 60).map((e, i) => <EventRow key={i} e={e} />)
              : <div style={{ color: "#667085" }}>No alerts recorded in this period.</div>}
          </div>
        </div>
        {footer}
      </div>
    );
  } else {
    body = (
      <div>
        {cards.length > 0 ? cards.map((g) => (
          <div
            key={g.number} className="home-alert-card" title="Click to select this volcano" role="button" tabIndex={0}
            onClick={() => onPickCard(g.number, g.name)}
            onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") onPickCard(g.number, g.name); }}
            style={{ padding: "10px 8px", borderBottom: "1px solid #dce3e9", backgroundColor: "#f4f7f9", marginBottom: 6 }}
          >
            <div style={{ fontSize: 18, fontWeight: 800, color: eventColor(g.items[0]) }}>{g.name}</div>
            {g.items.slice(0, 3).map((e, i) => <EventRow key={i} e={e} />)}
            {g.items.length > 3 ? <div style={{ fontSize: 12, color: "#667085" }}>{`+${g.items.length - 3} more`}</div> : null}
          </div>
        )) : <div style={{ color: "#667085" }}>{`No alerts in the last ${WINDOW_ALL_DAYS} days.`}</div>}
        {footer}
      </div>
    );
  }

  return (
    <div id="side-panel" className={"home-side-panel" + (open ? " open" : "")}>
      <div className="home-side-header">
        <span style={{ fontWeight: 700, fontSize: 17 }}>{title}</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {selected ? (
            <button className="home-refresh-btn" title="Clear selection" onClick={onClear}>← All alerts</button>
          ) : null}
          <button className="home-legend-toggle" title="Close" onClick={onClose}>✕</button>
        </div>
      </div>
      <div style={{ padding: "12px 16px 20px", fontSize: 15 }}>{body}</div>
    </div>
  );
}
