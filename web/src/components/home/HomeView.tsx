"use client";
// The Home screen: full-screen map with the clock, legend, minimap and side panel on top.
// This is what pages/home.py's layout + callbacks did in Dash. The Dash dcc.Stores became React state:
//   alert-store -> data, selected-volcano-store -> selected, side-panel-state -> sideOpen, legend-open -> legendCode,
//   area-store -> areaUnderView, (the map's `bounds` output) -> bounds.
import type { LatLngBounds, Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayerGroup, LayersControl, MapContainer, TileLayer } from "react-leaflet";
import { computeMarkerStates, groupActiveAlerts, prepareAlerts } from "@/lib/alertLogic";
import { startBubbleDeclutter } from "@/lib/bubbles";
import { usePersistentState } from "@/lib/usePersistentState";
import type { AlertEvent, AlertPayload, EventsResponse, Volcano } from "@/lib/types";
import { vaacAreaFor } from "@/lib/vaacAreas";
import { MAPPABLE_VOLCANOES, VOLCANOES, displayName, volcanoByNumber } from "@/lib/volcanoes";
import ClockBar from "./ClockBar";
import Legend from "./Legend";
import { MapWatcher, SelectedCallout, VaacRegionShapes } from "./MapLayers";
import MiniMap from "./MiniMap";
import SidePanel, { WINDOW_ALL_DAYS, WINDOW_SELECTED_DAYS } from "./SidePanel";
import VolcanoMarkers from "./VolcanoMarkers";
import { INITIAL_BOUNDS, POPUP_ROOM_PX, type Selected } from "./types";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

async function fetchEvents(days: number, number?: number): Promise<AlertEvent[]> {
  try {
    const q = new URLSearchParams({ days: String(days) });
    if (number !== undefined) q.set("number", String(number));
    const res = await fetch(`/api/events?${q}`);
    if (!res.ok) return [];
    return ((await res.json()) as EventsResponse).events ?? [];
  } catch {
    return [];
  }
}

export default function HomeView() {
  const [data, setData] = useState<AlertPayload | null>(null);
  const [lastCheck, setLastCheck] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = usePersistentState("lava.autoRefresh", true);
  const [minutes, setMinutes] = usePersistentState("lava.refreshMinutes", "5");
  const [selected, setSelected] = useState<Selected | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const [legendCode, setLegendCode] = useState<string | null>(null);
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [bounds, setBounds] = useState<LatLngBounds | null>(null);
  const [areaUnderView, setAreaUnderView] = useState<string | null>(null);
  const [events7, setEvents7] = useState<AlertEvent[]>([]);
  const [selectedEvents, setSelectedEvents] = useState<AlertEvent[]>([]);
  const [minuteTick, setMinuteTick] = useState(() => Math.floor(Date.now() / 60_000));
  const sigRef = useRef<string | null>(null);
  const inFlight = useRef(false);
  const pickRef = useRef(0);

  // ── Alert data ───────────────────────────────────────────
  // Only changed data is applied: the server sends a digest (`sig`) and an unchanged payload is dropped, so a
  // refresh that found nothing new redraws nothing ("checked ... · no changes").
  const load = useCallback(async (force: boolean) => {
    // A timer tick (or a StrictMode double mount) while a request is still running adds nothing.
    if (inFlight.current && !force) return;
    inFlight.current = true;
    if (force) setRefreshing(true);
    try {
      let res = force ? await fetch("/api/refresh", { method: "POST" }) : await fetch("/api/alerts", { cache: "no-store" });
      if (force && !res.ok) res = await fetch("/api/alerts", { cache: "no-store" }); // e.g. rate limited: show what the server has
      if (!res.ok) throw new Error(String(res.status));
      const payload = (await res.json()) as AlertPayload;
      const checked = new Date().toISOString().slice(11, 19) + " UTC";
      if (sigRef.current === payload.sig) {
        setLastCheck(`checked ${checked} · no changes`);
      } else {
        const first = sigRef.current === null;
        sigRef.current = payload.sig;
        setData(payload);
        setLastCheck(`checked ${checked} · ${first ? "loaded" : "updated"}`);
      }
    } catch {
      setLastCheck("check failed");
    } finally {
      inFlight.current = false;
      if (force) setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => void load(false), Number(minutes) * 60_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, minutes, load]);

  // The 24 h VAAC window moves with the clock even if no new data arrives: re-evaluate it every minute.
  useEffect(() => {
    const id = window.setInterval(() => setMinuteTick(Math.floor(Date.now() / 60_000)), 15_000);
    return () => window.clearInterval(id);
  }, []);

  // ── Alert history (side panel) ───────────────────────────
  useEffect(() => {
    let stale = false;
    void fetchEvents(WINDOW_ALL_DAYS).then((e) => { if (!stale) setEvents7(e); });
    return () => { stale = true; };
  }, [data?.sig]);

  const selectedNumber = selected?.number ?? null;
  useEffect(() => {
    if (selectedNumber === null) { setSelectedEvents([]); return; }
    let stale = false;
    void fetchEvents(WINDOW_SELECTED_DAYS, selectedNumber).then((e) => { if (!stale) setSelectedEvents(e); });
    return () => { stale = true; };
  }, [selectedNumber, data?.sig]);

  // ── Derived values ───────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prepared = useMemo(() => prepareAlerts(data, Date.now()), [data, minuteTick]);
  const markerStates = useMemo(() => computeMarkerStates(prepared, MAPPABLE_VOLCANOES), [prepared]);
  const names = useMemo(() => new Map(VOLCANOES.map((v) => [v.n, displayName(v.name)])), []);
  const active = useMemo(() => groupActiveAlerts(events7, names), [events7, names]);

  // The VAAC area to paint red: the selected volcano's, or (nothing selected) the one under the middle of the view.
  const highlight = useMemo(() => {
    if (selected && selected.number !== null) {
      const v = volcanoByNumber(selected.number);
      return v && v.lat !== null && v.lon !== null ? vaacAreaFor(v.lat, v.lon) : null;
    }
    return selected ? null : areaUnderView;
  }, [selected, areaUnderView]);

  // ── Map ──────────────────────────────────────────────────
  const onView = useCallback((m: LeafletMap) => {
    const b = m.getBounds();
    setBounds(b);
    const c = m.getCenter();
    const lon = ((((c.lng + 180) % 360) + 360) % 360) - 180; // the map can be scrolled around the globe
    setAreaUnderView(vaacAreaFor(c.lat, lon));
    // The area names keep a size proportional to the zoom (capped at 15 px) and are hidden when too small to read,
    // so a name never runs over its area's border. Written to CSS variables used by .vaac-label.
    const lonSpan = Math.abs(b.getEast() - b.getWest()) || 1;
    const size = Math.min(15, (m.getContainer().clientWidth / lonSpan) * 1.7);
    const root = document.documentElement.style;
    root.setProperty("--vaac-label-size", size.toFixed(1) + "px");
    root.setProperty("--vaac-label-vis", size < 6.5 ? "hidden" : "visible");
  }, []);

  // A click on the bare map drops the selection, folds the side panel and the legend details away.
  const onBareClick = useCallback(() => {
    setSelected(null);
    setSideOpen(false);
    setLegendCode(null);
  }, []);

  const pickFromMarker = useCallback((v: Volcano) => {
    setSelected({ name: displayName(v.name), number: v.n, via: "marker-popup", pick: ++pickRef.current });
  }, []);
  const pickFromCard = useCallback((number: number, name: string) => {
    setSelected({ name, number, via: "card", pick: ++pickRef.current });
    setSideOpen(true); // a selection made from the panel's cards keeps the panel open
  }, []);
  const openPanel = useCallback(() => setSideOpen(true), []);

  // Selecting a volcano never changes the zoom: the map only slides so that the volcano sits a little below the
  // centre (room for its big bubble above it).
  useEffect(() => {
    if (!map || !selected || selected.number === null) return;
    const v = volcanoByNumber(selected.number);
    if (!v || v.lat === null || v.lon === null) return;
    const size = map.getSize();
    const zoom = map.getZoom();
    // Land the volcano BELOW the centre, so that its big bubble (which opens upwards, ~370 px high) fits above it:
    // 15 % of the map height below the centre on a tall map, more on a low one (at most 38 %).
    const below = Math.max(0.15, Math.min(0.38, POPUP_ROOM_PX / size.y - 0.5));
    const centre = map.project([v.lat, v.lon], zoom).subtract([0, below * size.y]);
    map.panTo(map.unproject(centre, zoom), { animate: true, duration: 0.8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selected?.pick]);

  const resetView = useCallback(() => {
    map?.flyToBounds(INITIAL_BOUNDS, { duration: 1.2 });
    setSelected(null);
  }, [map]);

  // The screen is built up in two steps: the base map fades in once the view is set, the volcano markers and
  // bubbles fade in after the base map's tiles have arrived (CSS fallbacks show both after 2.5 s / 3.5 s anyway).
  useEffect(() => {
    if (!map) return;
    const el = map.getContainer();
    const timers: number[] = [];
    timers.push(window.setTimeout(() => {
      el.classList.add("map-ready");
      const t0 = Date.now();
      const wait = () => {
        const total = el.querySelectorAll(".leaflet-tile").length;
        const loaded = el.querySelectorAll(".leaflet-tile-loaded").length;
        if ((total > 0 && loaded >= total) || Date.now() - t0 > 1500) {
          timers.push(window.setTimeout(() => el.classList.add("markers-ready"), 150));
        } else timers.push(window.setTimeout(wait, 60));
      };
      wait();
    }, 150));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [map]);

  useEffect(() => startBubbleDeclutter(), []);

  // ── Render ───────────────────────────────────────────────
  const latestSelectedVaa = selectedEvents.find((e) => e.kind === "vaa") ?? null;
  return (
    <div id="home-root" className={"home-root" + (sideOpen ? " side-open" : "")}>
      <MapContainer
        id="volcano-map"
        className="home-map"
        // The view is fitted to INITIAL_BOUNDS as the map is created (no jump, unlike dash-leaflet which needed a fit
        // right after creation). zoomSnap lets that fit use a fractional zoom instead of rounding down.
        bounds={INITIAL_BOUNDS}
        boundsOptions={{ animate: false, padding: [0, 0] }}
        zoomSnap={0.25}
        ref={setMap}
        style={{ height: "100%", width: "100%" }}
      >
        <LayersControl>
          <LayersControl.BaseLayer name="Map">
            <TileLayer url={`${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`} attribution="Esri" />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Satellite" checked>
            <TileLayer url={`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`} attribution="Esri World Imagery" />
          </LayersControl.BaseLayer>
          <LayersControl.Overlay name="VAAC regions" checked>
            <LayerGroup><VaacRegionShapes highlight={highlight} /></LayerGroup>
          </LayersControl.Overlay>
        </LayersControl>
        <VolcanoMarkers states={markerStates} prepared={prepared} onPick={pickFromMarker} onMore={openPanel} />
        {selected ? <SelectedCallout selected={selected} prepared={prepared} latestVaa={latestSelectedVaa} onMore={openPanel} /> : null}
        <MapWatcher onView={onView} onBareClick={onBareClick} />
      </MapContainer>

      {/* Back to the first screen in one click (zoom out + recentre) */}
      <button className="home-reset-btn" title="Back to the initial view" onClick={resetView}>⌂</button>

      <ClockBar
        autoRefresh={autoRefresh} onAutoRefresh={setAutoRefresh} minutes={minutes} onMinutes={setMinutes}
        onRefreshNow={() => void load(true)} refreshing={refreshing} lastCheck={lastCheck}
      />

      <Legend
        open={legendOpen} onToggle={() => setLegendOpen((o) => !o)} detailCode={legendCode}
        onChip={(code) => setLegendCode((cur) => (cur === code ? null : code))} // the same chip again closes it
      />

      {/* Which volcano / VAAC area is selected (visible at any zoom level; empty when nothing is selected) */}
      <div className="home-selected-chip">
        {selected?.name ? (
          <>
            <span className="chip-label">Selected</span>
            <span className="chip-name">{selected.name}</span>
            <span className="chip-area">{highlight ? `${highlight} VAAC area` : "outside the VAAC areas"}</span>
          </>
        ) : highlight ? (
          <>
            <span className="chip-label">You are in</span>
            <span className="chip-area">{`${highlight} VAAC area`}</span>
          </>
        ) : null}
      </div>

      <MiniMap bounds={bounds} highlight={highlight} />

      {/* Right-edge tab button (single merged panel) */}
      <div className="home-side-tabs">
        <button className={"home-tab" + (sideOpen ? " active" : "")} onClick={() => setSideOpen((o) => !o)}>
          Volcano &amp; Alerts <span className="home-badge">{active.count}</span>
        </button>
      </div>

      <SidePanel
        open={sideOpen} data={data} prepared={prepared} selected={selected} selectedEvents={selectedEvents}
        cards={active.cards} onClose={() => setSideOpen(false)} onClear={() => setSelected(null)} onPickCard={pickFromCard}
      />
    </div>
  );
}
