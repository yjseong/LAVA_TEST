"use client";
// Minimap (bottom right): an overview of the main map - same centre, ~3x the main view, so zooming the main map
// out/in zooms the minimap out/in too. Port of sync_minimap() in pages/home.py.
import type { LatLngBounds } from "leaflet";
import { useEffect } from "react";
import { LayerGroup, MapContainer, Rectangle, TileLayer, useMap } from "react-leaflet";
import { VaacRegionShapes } from "./MapLayers";

/** Latitude to the vertical coordinate of the Web Mercator map (radians). */
const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unmerc = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

type Box = [[number, number], [number, number]];
const DEFAULT_BOX: Box = [[20, 120], [50, 150]];

/**
 * The view for the minimap. The vertical centre is taken on the Mercator scale the map is drawn in (and the view is
 * kept symmetric around it, within the +-85 degrees the map covers): with the plain middle latitude, and a view cut
 * off at 85 degrees on one side only, the red rectangle sat above the centre of the minimap.
 */
export function miniView(bounds: LatLngBounds): Box {
  const south = bounds.getSouth(), north = bounds.getNorth(), west = bounds.getWest(), east = bounds.getEast();
  const cLon = (west + east) / 2;
  const halfW = Math.max(east - west, 0.01) * 1.5;
  const mSouth = merc(Math.max(south, -84));
  const mNorth = merc(Math.min(north, 84));
  const mMid = (mSouth + mNorth) / 2;
  const mHalf = Math.min(Math.max(mNorth - mSouth, 0.01) * 1.5, merc(85) - Math.abs(mMid));
  return [[unmerc(mMid - mHalf), cLon - halfW], [unmerc(mMid + mHalf), cLon + halfW]];
}

function MiniSync({ bounds }: { bounds: LatLngBounds | null }) {
  const map = useMap();
  useEffect(() => {
    // fitBounds rather than a zoom number: a zoom of 0 would be falsy in some wrappers and stop the minimap from zooming out fully
    if (bounds) map.fitBounds(miniView(bounds), { animate: false });
  }, [bounds, map]);
  const box: Box = bounds
    ? [[bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getEast()]]
    : DEFAULT_BOX;
  // the red rectangle is the main map's current view
  return <Rectangle bounds={box} interactive={false} pathOptions={{ color: "red", fill: true, fillColor: "red", fillOpacity: 0.1, weight: 2 }} />;
}

export default function MiniMap({ bounds, highlight }: { bounds: LatLngBounds | null; highlight: string | null }) {
  return (
    <div className="home-minimap">
      <MapContainer
        center={[33, 132]} zoom={1} style={{ height: "100%", width: "100%" }}
        zoomControl={false} scrollWheelZoom={false} dragging={false} doubleClickZoom={false}
        touchZoom={false} boxZoom={false} keyboard={false}
        attributionControl={false} // no Leaflet logo on the minimap (the main map keeps its attribution)
      >
        <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}" attribution="" />
        <LayerGroup><VaacRegionShapes highlight={highlight} mini /></LayerGroup>
        <MiniSync bounds={bounds} />
      </MapContainer>
    </div>
  );
}
