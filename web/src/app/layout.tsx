import type { Metadata } from "next";
import "leaflet/dist/leaflet.css";
import "./globals.css";
import "./home.css";

export const metadata: Metadata = {
  title: "L.A.V.A. · Home",
  description: "Live Acoustic & Seismic Volcano Archive - world volcano alert map",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
