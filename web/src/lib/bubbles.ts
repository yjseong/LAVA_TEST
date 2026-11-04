// Home map bubbles. Port of assets/home_bubbles.js (kept almost line for line: it is plain DOM matching on the
// volcano name and needs no access to the Leaflet objects, so it works the same on top of react-leaflet).
//  - While a volcano's big bubble (popup) is open, its small VAAC bubble and its dark name bubble are hidden,
//    so they do not pile up under the big one.
//  - While a volcano is selected (dark name bubble), its small VAAC bubble shows the VAAC time only: the name is
//    already above it.
//  - Small VAAC bubbles that would overlap on screen (Krakatau / Semeru, Ibu / Dukono ...) or would sit under the
//    dark name bubble are moved up, each only as far as needed. Who overlaps whom depends on the zoom level, so
//    this is done here from the real screen positions, not on the server.
//  - When the spot below its triangle is taken too, a small bubble first steps SIDEWAYS (its arrow keeps pointing
//    at its triangle) before it is moved up.
//  - A small bubble never covers ANOTHER volcano's triangle (or the red ring of the selected one).

interface Rect { left: number; right: number; top: number; bottom: number }
interface Item extends Rect { el: HTMLElement; shift: number; dx: number; name: string | null }
interface IconRect extends Rect { cx: number }

const GAP = 2; // px kept between two bubbles
const BASE_MARGIN = -6; // Leaflet's own margin-top of a tooltip that opens upwards

const text = (el: Element | null): string | null => (el ? (el.textContent || "").trim() : null);
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const num = (v: string | undefined) => parseFloat(v || "0");

function sync() {
  const popup = document.querySelector(".leaflet-popup.vaa-popup");
  const popupName = popup ? text(popup.querySelector(".status-title")) : null;
  const sel = document.querySelector<HTMLElement>(".leaflet-tooltip.selected-bubble");
  const selName = text(sel);

  const bubbles = Array.from(document.querySelectorAll<HTMLElement>(".leaflet-tooltip.vaa-bubble"));
  bubbles.forEach((b) => {
    const name = text(b.querySelector(".vaa-bubble-name"));
    b.classList.toggle("vaa-bubble-hidden", !!popupName && name === popupName);
    b.classList.toggle("vaa-bubble-noname", !!selName && name === selName);
  });
  document.querySelectorAll<HTMLElement>(".leaflet-tooltip.selected-bubble").forEach((b) => {
    b.classList.toggle("selected-bubble-hidden", !!popupName && text(b) === popupName);
  });

  declutter(bubbles, sel && !sel.classList.contains("selected-bubble-hidden") ? sel : null, selName);
}

function declutter(bubbles: HTMLElement[], selBubble: HTMLElement | null, selName: string | null) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const outside = (r: DOMRect) => r.width === 0 || r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh;

  const items: Item[] = [];
  bubbles.forEach((b) => {
    if (b.classList.contains("vaa-bubble-hidden")) return;
    const shift = num(b.dataset.shift);
    const sdx = num(b.dataset.dx);
    const r = b.getBoundingClientRect();
    if (outside(r)) return;
    // rectangle at its natural place (the shifts applied earlier taken off again)
    items.push({ el: b, shift, dx: sdx, name: text(b.querySelector(".vaa-bubble-name")),
      left: r.left - sdx, right: r.right - sdx, top: r.top + shift, bottom: r.bottom + shift });
  });
  // the selected volcano's own bubble stays where it is; then north to south
  items.sort((a, b) => {
    const as = selName && a.name === selName ? 1 : 0;
    const bs = selName && b.name === selName ? 1 : 0;
    return bs - as || a.top - b.top;
  });

  // a selected volcano without a small bubble (no advisory): the dark name bubble keeps its normal place
  if (selBubble && selBubble.dataset.shift && !items.some((it) => selName && it.name === selName)) {
    selBubble.style.marginTop = "";
    delete selBubble.dataset.shift;
  }

  // triangles of the other volcanoes and the red ring: a small bubble must not sit on them
  const icons: IconRect[] = [];
  document.querySelectorAll<HTMLElement>(
    ".leaflet-marker-icon.marker-blink, .leaflet-marker-icon.marker-ended, .leaflet-marker-icon.selected-ring",
  ).forEach((m) => {
    const r = m.getBoundingClientRect();
    if (outside(r)) return;
    // 3 px smaller on every side: the icon box has transparent margins around the drawn triangle
    icons.push({ left: r.left + 3, right: r.right - 3, top: r.top + 3, bottom: r.bottom - 3, cx: (r.left + r.right) / 2 });
  });

  const placed: Rect[] = [];
  items.forEach((it) => {
    let dy = 0; // > 0: moved up, < 0: moved down below its triangle
    let dx = 0; // sideways step (px), the arrow stays on the triangle
    let below = false;
    const own = !!selName && it.name === selName;
    const cx = (it.left + it.right) / 2;
    // what a rectangle of this bubble would run into: other bubbles, and triangles that are not its own
    const firstHit = (c: Rect): Rect | null => {
      for (const p of placed) if (overlaps(c, p)) return p;
      for (const ic of icons) if (Math.abs(ic.cx - cx) >= 4 && overlaps(c, ic)) return ic;
      return null;
    };
    // the red ring of the selected volcano is wider than its triangle: lift the bubble clear of it
    const lift = ringLift(it);
    const top0 = it.top;
    const bottom0 = it.bottom;
    it.top -= lift;
    it.bottom -= lift;
    if (!own) {
      if (firstHit({ left: it.left, right: it.right, top: it.top, bottom: it.bottom })) {
        // Two neighbours: the northern one keeps its place above its triangle, this (southern) one goes BELOW its
        // triangle. Only if that does not work either, it is moved up until it is clear.
        const down = belowShift({ left: it.left, right: it.right, top: top0, bottom: bottom0 });
        const freeBelow = !firstHit({ left: it.left, right: it.right, top: top0 + down, bottom: bottom0 + down });
        if (freeBelow) {
          dy = -down - lift; // (lift is added back below: total = -down)
          below = true;
        } else if ((dx = sideShift(it, firstHit)) !== 0) {
          dy = 0; // stays at its height, only moved to the side
        } else {
          let guard = 0;
          let d = 0;
          while (guard++ < 40) {
            const hit = firstHit({ left: it.left, right: it.right, top: it.top - d, bottom: it.bottom - d });
            if (!hit) break;
            d = it.bottom - hit.top + GAP;
          }
          dy = d;
        }
      }
    }
    placed.push({ left: it.left + dx, right: it.right + dx, top: it.top - dy, bottom: it.bottom - dy });
    dy += lift; // what is applied to the element: the lift plus the rest
    if (own && selBubble) {
      // the dark name bubble goes right above this volcano's small bubble (never over it) ...
      const dshift = num(selBubble.dataset.shift);
      const sr = selBubble.getBoundingClientRect();
      const sTop = sr.top + dshift;
      const sBottom = sr.bottom + dshift;
      const ddy = Math.max(0, sBottom - (it.top - dy) + GAP);
      if (Math.abs(ddy - dshift) > 0.5) {
        selBubble.style.marginTop = BASE_MARGIN - ddy + "px";
        selBubble.dataset.shift = String(ddy);
      }
      // ... and it is an obstacle for every other small bubble
      placed.push({ left: sr.left, right: sr.right, top: sTop - ddy, bottom: sBottom - ddy });
    }
    if (Math.abs(dy - it.shift) > 0.5) {
      it.el.style.marginTop = BASE_MARGIN - dy + "px";
      it.el.dataset.shift = String(dy);
    }
    if (Math.abs(dx - it.dx) > 0.5) {
      it.el.style.marginLeft = dx ? dx + "px" : "";
      it.el.style.setProperty("--arrow-dx", dx + "px");
      if (dx) it.el.dataset.dx = String(dx);
      else delete it.el.dataset.dx;
    }
    it.el.classList.toggle("vaa-bubble-below", below);
  });
  // bubbles outside the view lose old shifts
  bubbles.forEach((b) => {
    if ((b.dataset.shift || b.dataset.dx) && items.every((it) => it.el !== b)) {
      b.style.marginTop = "";
      delete b.dataset.shift;
      b.style.marginLeft = "";
      b.style.removeProperty("--arrow-dx");
      delete b.dataset.dx;
      b.classList.remove("vaa-bubble-below");
    }
  });
}

/** How far (px) a small bubble has to move up to clear the red ring of the selected volcano. */
function ringLift(it: Rect): number {
  const cx = (it.left + it.right) / 2;
  let lift = 0;
  document.querySelectorAll<HTMLElement>(".leaflet-marker-icon.selected-ring").forEach((m) => {
    const r = m.getBoundingClientRect();
    if (Math.abs((r.left + r.right) / 2 - cx) < 4 && it.bottom > r.top - GAP && it.top < r.bottom) {
      lift = Math.max(lift, it.bottom - (r.top - GAP));
    }
  });
  return lift;
}

/**
 * How far (px) a small bubble has to step to the side (right first, then left) to be clear, at its own height.
 * The arrow must stay inside the bubble: at most half its width minus 12 px. 0 = no free place within that.
 * It does not step under the legend, the clock box or the minimap: they are drawn over the bubbles and would hide it.
 */
function sideShift(it: Rect, firstHit: (c: Rect) => Rect | null): number {
  const maxDx = Math.floor((it.right - it.left) / 2 - 12);
  const ui: Rect[] = [];
  document.querySelectorAll(".home-legend, .home-clockbar, .home-minimap").forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) ui.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  });
  for (let s = 2; s <= maxDx; s += 2) {
    for (let sign = 1; sign >= -1; sign -= 2) {
      const d = s * sign;
      const c = { left: it.left + d, right: it.right + d, top: it.top, bottom: it.bottom };
      if (ui.some((u) => overlaps(c, u))) continue;
      if (!firstHit(c)) return d;
    }
  }
  return 0;
}

/** How far (px) a small bubble has to move down to sit just under its own triangle. */
function belowShift(it: Rect): number {
  const cx = (it.left + it.right) / 2;
  let best: DOMRect | null = null;
  document.querySelectorAll<HTMLElement>(".leaflet-marker-icon.marker-blink, .leaflet-marker-icon.marker-ended").forEach((m) => {
    const r = m.getBoundingClientRect();
    if (Math.abs((r.left + r.right) / 2 - cx) < 4 && r.top >= it.bottom - 4 && (!best || r.top < best.top)) best = r;
  });
  const b = best as DOMRect | null;
  const iconBottom = b ? b.bottom : it.bottom + 32;
  return iconBottom + 8 - it.top; // 8 px of room for the arrow
}

/** Starts the bubble tidy-up; returns the function that stops it. */
export function startBubbleDeclutter(): () => void {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = window.setInterval(schedule, 500); // zooming moves the bubbles without adding or removing any
  schedule();
  return () => {
    observer.disconnect();
    window.clearInterval(timer);
  };
}
