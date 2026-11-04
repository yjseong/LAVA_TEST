"use client";
// The volcano triangles. Port of build_map_markers() in pages/home.py.
//  - no VAAC bubble: a plain marker (about 1,200 of them; memoised so an alert update only touches the ones that changed);
//  - VAAC advisory in the last 24 h (or one that just ended): a marker with a small permanent bubble above it
//    (name + time of the latest advisory) and a big bubble (popup) with the same status as the side panel.
import { memo, useMemo } from "react";
import { Marker, Popup, Tooltip } from "react-leaflet";
import type { MarkerState, PreparedAlerts } from "@/lib/alertLogic";
import type { Volcano } from "@/lib/types";
import { triangleIcon } from "./markerIcons";
import { VolcanoStatusPanel } from "./StatusPanel";

type Pick = (v: Volcano) => void;

/** Buttons at the bottom of a big bubble. (The Python app also had "Open Seismic" here; that page is not part of this port.) */
export function PopupButtons({ onMore }: { onMore: () => void }) {
  return (
    <button className="home-popup-more" onClick={onMore}>More details in the side panel ▸</button>
  );
}

const sameLook = (a: MarkerState, b: MarkerState) =>
  a.volcano === b.volcano && a.size === b.size && a.fill === b.fill && a.stroke === b.stroke &&
  a.width === b.width && a.opacity === b.opacity;

const PlainMarker = memo(function PlainMarker({ s, onPick }: { s: MarkerState; onPick: Pick }) {
  const position = useMemo<[number, number]>(() => [s.volcano.lat!, s.volcano.lon!], [s.volcano]);
  const handlers = useMemo(() => ({ click: () => onPick(s.volcano) }), [onPick, s.volcano]);
  return (
    <Marker position={position} opacity={s.opacity} icon={triangleIcon(s.size, s.fill, s.stroke, s.width, "plain")} eventHandlers={handlers}>
      <Tooltip>{s.name}</Tooltip>
    </Marker>
  );
}, (a, b) => a.onPick === b.onPick && sameLook(a.s, b.s));

function BubbleMarker({ s, prepared, onPick, onMore }: {
  s: MarkerState; prepared: PreparedAlerts; onPick: Pick; onMore: () => void;
}) {
  const bubble = s.bubble!;
  const blink = bubble.kind === "blink";
  const position = useMemo<[number, number]>(() => [s.volcano.lat!, s.volcano.lon!], [s.volcano]);
  const handlers = useMemo(() => ({ click: () => onPick(s.volcano) }), [onPick, s.volcano]);
  return (
    <Marker
      position={position}
      icon={triangleIcon(s.size, s.fill, s.stroke, s.width, blink ? "blink" : "ended")}
      // Leaflet's z-index is the marker's pixel row + this offset; the pixel row reaches the tens of thousands when
      // zoomed in, so the offset has to be far larger than that.
      zIndexOffset={blink ? 1_000_000 : 500_000}
      eventHandlers={handlers}
    >
      {/* Neighbouring bubbles (Ibu / Dukono, Krakatau / Semeru) are kept apart from their real screen positions by
          src/lib/bubbles.ts, because who overlaps whom depends on the zoom level. A tooltip's class is fixed at
          creation, hence the key. */}
      <Tooltip key={bubble.kind} permanent interactive direction="top" className={"vaa-bubble" + (blink ? "" : " vaa-bubble-final")}>
        <div className="vaa-bubble-name">{s.name}</div>
        <div className="vaa-bubble-time">{bubble.timeLine}</div>
      </Tooltip>
      {/* The big bubble does not open the side panel by itself; its button does. Only the latest advisory is shown. */}
      <Popup className="vaa-popup" maxWidth={340} minWidth={300} autoPan={false}>
        <VolcanoStatusPanel volcano={s.volcano} name={s.name} prepared={prepared} maxVaa={1} />
        <PopupButtons onMore={onMore} />
      </Popup>
    </Marker>
  );
}

function VolcanoMarkersImpl({ states, prepared, onPick, onMore }: {
  states: MarkerState[]; prepared: PreparedAlerts; onPick: Pick; onMore: () => void;
}) {
  return (
    <>
      {states.map((s) =>
        s.bubble ? (
          <BubbleMarker key={s.volcano.n} s={s} prepared={prepared} onPick={onPick} onMore={onMore} />
        ) : (
          <PlainMarker key={s.volcano.n} s={s} onPick={onPick} />
        ),
      )}
    </>
  );
}

export default memo(VolcanoMarkersImpl);
