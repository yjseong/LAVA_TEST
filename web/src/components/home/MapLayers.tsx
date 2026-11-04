"use client";
// Leaflet layers of the Home map that are not the volcano markers themselves.
import type { Map as LeafletMap } from "leaflet";
import { useEffect, type ReactNode } from "react";
import { Marker, Polygon, Popup, Tooltip, useMapEvents } from "react-leaflet";
import type { PreparedAlerts } from "@/lib/alertLogic";
import { vaaStatus } from "@/lib/alertLogic";
import { MINI_LABEL_POS, VAAC_AREAS, VAAC_BLUE, VAAC_LABEL_POS, VAAC_RED } from "@/lib/vaacAreas";
import type { AlertEvent } from "@/lib/types";
import { volcanoByNumber } from "@/lib/volcanoes";
import { blankIcon, ringIcon } from "./markerIcons";
import { PopupButtons } from "./VolcanoMarkers";
import { VolcanoStatusPanel } from "./StatusPanel";
import type { Selected } from "./types";

/**
 * All VAAC areas blue; the `highlight` area (the one holding the selected volcano) red. mini=true gives the thin
 * version used on the minimap. On the main map the area names are separate label markers (VAAC_LABEL_POS); the
 * outlines carry no tooltip and are not interactive, so a click on an area is a click on the map.
 */
export function VaacRegionShapes({ highlight, mini = false }: { highlight: string | null; mini?: boolean }) {
  const items: ReactNode[] = [];
  if (!mini) {
    for (const [name, pos] of Object.entries(VAAC_LABEL_POS)) {
      const on = name === highlight;
      // The key carries the highlight state so Leaflet re-creates the label (a tooltip's class is fixed at creation).
      items.push(
        <Marker key={`vaac-label-${name}-${on ? "on" : "off"}`} position={pos} icon={blankIcon()} interactive={false} keyboard={false}>
          <Tooltip permanent direction="center" className={on ? "vaac-label vaac-label-on" : "vaac-label"}>{`${name} VAAC`}</Tooltip>
        </Marker>,
      );
    }
  }
  // Highlighted area last so its red outline sits on top of the shared borders.
  const areas = Object.entries(VAAC_AREAS).sort((a, b) => Number(a[0] === highlight) - Number(b[0] === highlight));
  for (const [name, pts] of areas) {
    const on = name === highlight;
    const color = on ? VAAC_RED : VAAC_BLUE;
    for (const shift of [-360, 0, 360]) {
      items.push(
        <Polygon
          // The key carries the highlight state so Leaflet re-creates the shape (restyling in place does not repaint the path).
          key={`${mini ? "mini-" : ""}vaac-${name}-${shift}-${on ? "on" : "off"}`}
          positions={pts.map(([lat, lon]) => [lat, lon + shift] as [number, number])}
          pathOptions={{ color, weight: mini ? (on ? 2 : 1) : on ? 4 : 3, fillColor: color, fillOpacity: mini ? 0 : on ? 0.12 : 0.04 }}
          interactive={false}
        >
          {mini && shift === 0 && !(name in MINI_LABEL_POS) ? (
            <Tooltip permanent direction="center" className="vaac-label vaac-label-mini">{name}</Tooltip>
          ) : null}
        </Polygon>,
      );
    }
    if (mini && name in MINI_LABEL_POS) {
      // a hand-placed name: a label marker at that position
      items.push(
        <Marker key={`mini-vaac-label-${name}-${on ? "on" : "off"}`} icon={blankIcon()} interactive={false} keyboard={false} position={MINI_LABEL_POS[name]}>
          <Tooltip permanent direction="center" className="vaac-label vaac-label-mini">{name}</Tooltip>
        </Marker>,
      );
    }
  }
  return <>{items}</>;
}

/** Ring + name bubble above the selected volcano's triangle. A volcano without a small VAAC bubble that was picked on the map also gets its big bubble here (the same one a VAAC volcano has on its marker). */
export function SelectedCallout({
  selected, prepared, latestVaa, onMore,
}: { selected: Selected; prepared: PreparedAlerts; latestVaa: AlertEvent | null; onMore: () => void }) {
  const volcano = selected.number !== null ? volcanoByNumber(selected.number) : undefined;
  if (!volcano || volcano.lat === null || volcano.lon === null) return null;
  const pos: [number, number] = [volcano.lat, volcano.lon];
  // A volcano with a VAAC advisory in the last 24 h already has its small bubble (name + advisory time) above the
  // triangle: it gets only the red ring, no second name bubble. Any other volcano gets its name on top of the ring.
  const st = vaaStatus(prepared, volcano.name);
  const hasSmallBubble = st.current.length > 0 || st.ended !== null;
  return (
    <>
      {!hasSmallBubble && selected.via === "marker-popup" ? (
        // new key on every pick: a popup the user closed opens again when the same volcano is clicked again
        <Popup key={`callout-popup-${volcano.n}-${selected.pick}`} position={pos} offset={[0, -30]} className="vaa-popup"
               maxWidth={340} minWidth={300} autoPan={false}>
          <VolcanoStatusPanel volcano={volcano} name={selected.name} prepared={prepared} maxVaa={1} latestVaa={latestVaa} />
          <PopupButtons onMore={onMore} />
        </Popup>
      ) : null}
      <Marker key={`callout-${volcano.n}`} position={pos} icon={ringIcon()} interactive={false} keyboard={false} zIndexOffset={2_000_000}>
        {hasSmallBubble ? null : (
          <Tooltip permanent direction="top" className="selected-bubble" offset={[0, 6]}>{selected.name}</Tooltip>
        )}
      </Marker>
    </>
  );
}

/** Reports the view after every pan / zoom and a click on the bare map. */
export function MapWatcher({ onView, onBareClick }: { onView: (map: LeafletMap) => void; onBareClick: () => void }) {
  const map = useMapEvents({
    moveend: () => onView(map),
    zoomend: () => onView(map),
    click: () => onBareClick(),
  });
  useEffect(() => onView(map), [map, onView]);
  return null;
}
