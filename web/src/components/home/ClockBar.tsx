"use client";
// UTC / KST clock + auto-refresh controls (the box at the top left of the map).
// The Dash app drew the clock in plain DOM (assets/home_clock.js) because a callback every second made the tab
// title flicker. Here the clock is its own tiny component, so its one-second state change re-renders nothing else.
import { useEffect, useState } from "react";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(kind: "date" | "time", zone: string): Intl.DateTimeFormat {
  const key = kind + zone;
  let f = fmtCache.get(key);
  if (!f) {
    f = kind === "date"
      ? new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "2-digit", year: "numeric" })
      : new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    fmtCache.set(key, f);
  }
  return f;
}

function ClockBlock({ label, zone, now }: { label: string; zone: string; now: Date }) {
  return (
    <div style={{ flex: "1 1 0", minWidth: 0, whiteSpace: "nowrap" }}>
      <div style={{ fontSize: 14, color: "#667085", fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{fmt("date", zone).format(now)}</div>
      <div style={{ fontSize: 19, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmt("time", zone).format(now)}</div>
    </div>
  );
}

function Clocks() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div style={{ minHeight: 70 }}>
      {now ? (
        <div style={{ display: "flex", flexDirection: "row", flexWrap: "nowrap", alignItems: "center", gap: 12, width: "100%" }}>
          <ClockBlock label="UTC" zone="UTC" now={now} />
          <ClockBlock label="KST" zone="Asia/Seoul" now={now} />
        </div>
      ) : null}
    </div>
  );
}

export default function ClockBar({
  autoRefresh, onAutoRefresh, minutes, onMinutes, onRefreshNow, refreshing, lastCheck,
}: {
  autoRefresh: boolean; onAutoRefresh: (v: boolean) => void;
  minutes: string; onMinutes: (v: string) => void;
  onRefreshNow: () => void; refreshing: boolean; lastCheck: string;
}) {
  return (
    <div className="home-clockbar">
      <Clocks />
      <div className="home-refresh-row">
        <label className="lava-switch">
          <input type="checkbox" role="switch" checked={autoRefresh} onChange={(e) => onAutoRefresh(e.target.checked)} />
          Auto refresh
        </label>
        <select className="lava-select" value={minutes} onChange={(e) => onMinutes(e.target.value)} aria-label="Refresh interval">
          <option value="1">1 min</option>
          <option value="5">5 min</option>
          <option value="10">10 min</option>
          <option value="30">30 min</option>
        </select>
        <button className="home-refresh-btn" title="Refresh alert data now" onClick={onRefreshNow} disabled={refreshing}>↻ Refresh</button>
        <span style={{ fontSize: 11, color: "#667085" }}>{autoRefresh ? `every ${minutes} min` : "paused"}</span>
        <span style={{ fontSize: 11, color: "#667085" }}>{lastCheck}</span>
      </div>
    </div>
  );
}
