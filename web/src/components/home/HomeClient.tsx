"use client";
import dynamic from "next/dynamic";

// Leaflet touches `window` as soon as it is imported, so the map is never rendered on the server.
const HomeView = dynamic(() => import("./HomeView"), {
  ssr: false,
  loading: () => <div className="home-loading">Loading map…</div>,
});

export default function HomeClient() {
  return <HomeView />;
}
