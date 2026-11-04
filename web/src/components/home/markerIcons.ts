import L from "leaflet";

// Triangle icons as SVG data URLs. Only a handful of distinct (size, fill, stroke, width) combinations exist, so
// the Icon objects are cached and shared by all markers of the same look (the Python app cached the URLs).
const svgUrl = (size: number, fill: string, stroke: string, width: number) => {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 24 24'>` +
    `<polygon points='12,2 22,22 2,22' fill='${fill}' stroke='${stroke}' stroke-width='${width}' stroke-linejoin='round'/></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
};

export type TriangleKind = "plain" | "blink" | "ended";

const cache = new Map<string, L.Icon>();

export function triangleIcon(size: number, fill: string, stroke: string, width: number, kind: TriangleKind): L.Icon {
  const key = `${size}|${fill}|${stroke}|${width}|${kind}`;
  let icon = cache.get(key);
  if (!icon) {
    icon = L.icon({
      iconUrl: svgUrl(size, fill, stroke, width),
      iconSize: [size, size],
      iconAnchor: [size / 2, size],
      // the bubble's arrow and the big bubble's tip sit just above the triangle
      tooltipAnchor: kind === "plain" ? [0, 0] : [0, -(size + 2)],
      popupAnchor: [0, -(size + 6)],
      className: kind === "blink" ? "marker-blink" : kind === "ended" ? "marker-ended" : "",
    });
    cache.set(key, icon);
  }
  return icon;
}

let ring: L.Icon | null = null;
/** Red ring around the selected volcano. Centred ~10 px above the point (the triangle sits on its coordinate). */
export function ringIcon(): L.Icon {
  return (ring ??= L.icon({
    iconUrl:
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'>" +
          "<circle cx='20' cy='20' r='16' fill='none' stroke='#ff3b30' stroke-width='3'/></svg>",
      ),
    iconSize: [40, 40],
    iconAnchor: [20, 30],
    tooltipAnchor: [0, -32],
    className: "selected-ring",
  }));
}

let blank: L.Icon | null = null;
/** 1x1 transparent icon: carries the permanent VAAC area name tooltips. */
export function blankIcon(): L.Icon {
  return (blank ??= L.icon({
    iconUrl: "data:image/svg+xml;charset=utf-8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>"),
    iconSize: [1, 1],
    iconAnchor: [0, 0],
  }));
}
