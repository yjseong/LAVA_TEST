// VAAC areas of responsibility. Port of VAAC_AREAS & co. in pages/home.py.
// Hand-traced (lat, lon) outlines of the ICAO VAAC areas, read off the "Volcanic Ash Advisory Centers - Areas of
// Responsibility" chart. Display only - NOT official boundaries. Longitudes run -30..330 so that regions crossing
// the dateline stay one polygon; the map draws +/-360 copies so every world copy shows them.

export type LatLon = [number, number];

export const VAAC_RED = "#e02020";
export const VAAC_BLUE = "#1f4fd8";

// Object key order matters: vaacAreaFor() returns the first area that contains the point.
export const VAAC_AREAS: Record<string, LatLon[]> = {
  Tokyo: [[90, 90], [90, 150], [60, 150], [60, 180], [54, 170], [50, 160], [43.5, 165], [27, 165], [27, 155],
    [21, 155], [21, 130], [10, 130], [10, 100], [20, 100], [20, 90]],
  Anchorage: [[90, 150], [90, 220], [61, 220], [60, 226], [55, 231], [55, 228], [51, 230], [48.5, 235],
    [48.5, 211], [43, 211], [43.5, 165], [50, 160], [54, 170], [60, 180], [60, 150]],
  Montreal: [[90, 220], [61, 220], [60, 226], [55, 231], [55, 228], [51, 230], [48.5, 235], [48.5, 269],
    [44, 276], [43.5, 284], [45, 294], [45, 320], [45, 330], [90, 330]],
  Washington: [[43.5, 165], [43, 211], [48.5, 211], [48.5, 269], [44, 276], [43.5, 284], [45, 294], [45, 320],
    [20.5, 320], [16, 322], [8, 324], [4, 330], [-10, 330], [-10, 220], [0, 220], [0, 160.5],
    [10, 160.5], [10, 130], [21, 130], [21, 155], [27, 155], [27, 165]],
  London: [[90, -30], [90, 90], [71, 90], [71, 30], [67, 30], [60, 28], [55, 10], [49, -5], [48, -8], [45, -8], [45, -30]],
  Toulouse: [[45, -30], [45, -8], [48, -8], [49, -5], [55, 10], [60, 28], [71, 30], [71, 90], [20, 90], [20, 83],
    [10, 81], [5, 78.5], [-4, 78.5], [-7, 76], [-90, 75], [-90, -10], [-6, -10], [-6, -15], [3.5, -30]],
  Darwin: [[20, 90], [20, 100], [10, 100], [10, 160.5], [-14, 160.5], [-17, 163], [-90, 163], [-90, 75],
    [-7, 76], [-4, 78.5], [5, 78.5], [10, 81], [20, 83]],
  Wellington: [[0, 160.5], [0, 220], [-10, 220], [-10, 270], [-90, 270], [-90, 163], [-17, 163], [-14, 160.5]],
  "Buenos Aires": [[-10, -90], [-10, -10], [-90, -10], [-90, -90]],
};

// Where each area's name is written on the main map. Chosen to lie inside the first screen (INITIAL_BOUNDS)
// wherever the area reaches it - the polygon centre of the big areas (Tokyo and Darwin run to the pole) would
// fall off the screen. The five hand-placed spots were marked on a screenshot of the first screen.
export const VAAC_LABEL_POS: Record<string, LatLon> = {
  Tokyo: [31.3, 151.4], Darwin: [5.1, 148.8], Anchorage: [46.7, 172.8],
  Washington: [38.9, 174.1], Wellington: [-4.1, 170.5], Toulouse: [12.0, 70.0],
  London: [62.0, 45.0], Montreal: [60.0, 285.0], "Buenos Aires": [-30.0, -50.0],
};

// Minimap: these five names are placed by hand instead of at the centre of each area's bounding box.
export const MINI_LABEL_POS: Record<string, LatLon> = {
  Toulouse: [30.4, 53.0], Tokyo: [37.5, 124.1], Darwin: [-34.9, 119.8],
  Wellington: [-34.9, 210.0], Washington: [15.2, 196.0],
};

/** Ray casting; the same expression as _point_in_polygon. */
export function pointInPolygon(lat: number, lon: number, pts: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [latI, lonI] = pts[i];
    const [latJ, lonJ] = pts[j];
    if (latI > lat !== latJ > lat && lon < ((lonJ - lonI) * (lat - latI)) / (latJ - latI) + lonI) inside = !inside;
  }
  return inside;
}

/** Name of the VAAC area containing (lat, lon), or null. Areas run -30..330 E, so the longitude and its +/-360 twins are tried. */
export function vaacAreaFor(lat: number, lon: number): string | null {
  for (const [name, pts] of Object.entries(VAAC_AREAS)) {
    for (const shift of [0, 360, -360]) {
      if (pointInPolygon(lat, lon + shift, pts)) return name;
    }
  }
  return null;
}
