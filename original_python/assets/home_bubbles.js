/* Home map bubbles (see pages/home.py).
 *  - While a volcano's big bubble (popup) is open, its small VAAC bubble and its dark name bubble are hidden,
 *    so they do not pile up under the big one.
 *  - While a volcano is selected (dark name bubble), its small VAAC bubble shows the VAAC time only: the name
 *    is already above it.
 *  - Small VAAC bubbles that would overlap on screen (Krakatau / Semeru, Ibu / Dukono ...) or would sit under
 *    the dark name bubble are moved up, each only as far as needed. Who overlaps whom depends on the zoom
 *    level, so this is done here from the real screen positions, not on the server.
 *  - When the spot below its triangle is taken too, a small bubble first steps SIDEWAYS (its arrow keeps pointing at
 *    its triangle) before it is moved up: with three volcanoes on the same spot (Karangetang / Ibu / Dukono) the
 *    last one used to be sent a few hundred px up, far from its triangle.
 *  - A small bubble never covers ANOTHER volcano's triangle (or the red ring of the selected one): it goes
 *    below its own triangle, or up, until clear. This matters when a neighbour's bubble is hidden because its
 *    big bubble is open: the freed volcano must not move into the place of that neighbour's triangle.
 * Plain DOM matching on the volcano name; no access to the Leaflet objects is needed. */
(function () {
  var GAP = 2;                       // px kept between two bubbles
  var BASE_MARGIN = -6;              // Leaflet's own margin-top of a tooltip that opens upwards

  function text(el) { return el ? (el.textContent || "").trim() : null; }

  function overlaps(a, b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  }

  function sync() {
    var popup = document.querySelector(".leaflet-popup.vaa-popup");
    var popupName = popup ? text(popup.querySelector(".status-title")) : null;
    var sel = document.querySelector(".leaflet-tooltip.selected-bubble");
    var selName = text(sel);

    var bubbles = Array.prototype.slice.call(document.querySelectorAll(".leaflet-tooltip.vaa-bubble"));
    bubbles.forEach(function (b) {
      var name = text(b.querySelector(".vaa-bubble-name"));
      b.classList.toggle("vaa-bubble-hidden", !!popupName && name === popupName);
      b.classList.toggle("vaa-bubble-noname", !!selName && name === selName);
    });
    document.querySelectorAll(".leaflet-tooltip.selected-bubble").forEach(function (b) {
      b.classList.toggle("selected-bubble-hidden", !!popupName && text(b) === popupName);
    });

    declutter(bubbles, sel && !sel.classList.contains("selected-bubble-hidden") ? sel : null, selName);
  }

  function declutter(bubbles, selBubble, selName) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var items = [];
    bubbles.forEach(function (b) {
      if (b.classList.contains("vaa-bubble-hidden")) { return; }
      var shift = parseFloat(b.dataset.shift || "0");
      var sdx = parseFloat(b.dataset.dx || "0");
      var r = b.getBoundingClientRect();
      if (r.width === 0 || r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) { return; }
      // rectangle at its natural place (the shifts applied earlier taken off again)
      items.push({ el: b, shift: shift, dx: sdx, name: text(b.querySelector(".vaa-bubble-name")),
                   left: r.left - sdx, right: r.right - sdx, top: r.top + shift, bottom: r.bottom + shift });
    });
    // the selected volcano's own bubble stays where it is; then north to south
    items.sort(function (a, b) {
      var as = selName && a.name === selName ? 1 : 0, bs = selName && b.name === selName ? 1 : 0;
      return (bs - as) || (a.top - b.top);
    });

    // a selected volcano without a small bubble (no advisory): the dark name bubble keeps its normal place
    if (selBubble && selBubble.dataset.shift && !items.some(function (it) { return selName && it.name === selName; })) {
      selBubble.style.marginTop = ""; delete selBubble.dataset.shift;
    }

    // triangles of the other volcanoes and the red ring: a small bubble must not sit on them
    var icons = [];
    document.querySelectorAll(".leaflet-marker-icon.marker-blink, .leaflet-marker-icon.marker-ended, .leaflet-marker-icon.selected-ring").forEach(function (m) {
      var r = m.getBoundingClientRect();
      if (r.width === 0 || r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) { return; }
      // 3 px smaller on every side: the icon box has transparent margins around the drawn triangle
      icons.push({ left: r.left + 3, right: r.right - 3, top: r.top + 3, bottom: r.bottom - 3, cx: (r.left + r.right) / 2 });
    });

    var placed = [];
    items.forEach(function (it) {
      var dy = 0;                         // > 0: moved up, < 0: moved down below its triangle
      var dx = 0;                         // sideways step (px), the arrow stays on the triangle
      var below = false;
      var own = selName && it.name === selName;
      var cx = (it.left + it.right) / 2;
      // what a rectangle of this bubble would run into: other bubbles, and triangles that are not its own
      var firstHit = function (c) {
        for (var k = 0; k < placed.length; k++) { if (overlaps(c, placed[k])) { return placed[k]; } }
        for (var j = 0; j < icons.length; j++) {
          if (Math.abs(icons[j].cx - cx) >= 4 && overlaps(c, icons[j])) { return icons[j]; }
        }
        return null;
      };
      // the red ring of the selected volcano is wider than its triangle: lift the bubble clear of it
      var lift = ringLift(it);
      var top0 = it.top, bottom0 = it.bottom;
      it.top -= lift; it.bottom -= lift;
      if (!own) {
        if (firstHit({ left: it.left, right: it.right, top: it.top, bottom: it.bottom })) {
          // Two neighbours: the northern one keeps its place above its triangle, this (southern) one goes
          // BELOW its triangle. Only if that does not work either, it is moved up until it is clear.
          var down = belowShift({ left: it.left, right: it.right, top: top0, bottom: bottom0 });
          var freeBelow = !firstHit({ left: it.left, right: it.right, top: top0 + down, bottom: bottom0 + down });
          if (freeBelow) {
            dy = -down - lift; below = true;     // (lift is added back below: total = -down)
          } else if ((dx = sideShift(it, firstHit)) !== 0) {
            dy = 0;                              // stays at its height, only moved to the side
          } else {
            var guard = 0, d = 0;
            while (guard++ < 40) {
              var hit = firstHit({ left: it.left, right: it.right, top: it.top - d, bottom: it.bottom - d });
              if (!hit) { break; }
              d = it.bottom - hit.top + GAP;
            }
            dy = d;
          }
        }
      }
      placed.push({ left: it.left + dx, right: it.right + dx, top: it.top - dy, bottom: it.bottom - dy });
      dy += lift;                         // what is applied to the element: the lift plus the rest
      if (own && selBubble) {
        // the dark name bubble goes right above this volcano's small bubble (never over it) ...
        var dshift = parseFloat(selBubble.dataset.shift || "0");
        var sr = selBubble.getBoundingClientRect();
        var sTop = sr.top + dshift, sBottom = sr.bottom + dshift;
        var ddy = Math.max(0, sBottom - (it.top - dy) + GAP);
        if (Math.abs(ddy - dshift) > 0.5) {
          selBubble.style.marginTop = (BASE_MARGIN - ddy) + "px";
          selBubble.dataset.shift = String(ddy);
        }
        // ... and it is an obstacle for every other small bubble
        placed.push({ left: sr.left, right: sr.right, top: sTop - ddy, bottom: sBottom - ddy });
      }
      if (Math.abs(dy - it.shift) > 0.5) {
        it.el.style.marginTop = (BASE_MARGIN - dy) + "px";
        it.el.dataset.shift = String(dy);
      }
      if (Math.abs(dx - it.dx) > 0.5) {
        it.el.style.marginLeft = dx ? dx + "px" : "";
        it.el.style.setProperty("--arrow-dx", dx + "px");
        if (dx) { it.el.dataset.dx = String(dx); } else { delete it.el.dataset.dx; }
      }
      it.el.classList.toggle("vaa-bubble-below", below);
    });
    // no volcano selected: the dark bubble does not exist; still make sure bubbles outside the view lose old shifts
    bubbles.forEach(function (b) {
      if ((b.dataset.shift || b.dataset.dx) && items.every(function (it) { return it.el !== b; })) {
        b.style.marginTop = ""; delete b.dataset.shift;
        b.style.marginLeft = ""; b.style.removeProperty("--arrow-dx"); delete b.dataset.dx;
        b.classList.remove("vaa-bubble-below");
      }
    });
  }

  // How far (px) a small bubble has to move up to clear the red ring of the selected volcano.
  function ringLift(it) {
    var cx = (it.left + it.right) / 2, lift = 0;
    document.querySelectorAll(".leaflet-marker-icon.selected-ring").forEach(function (m) {
      var r = m.getBoundingClientRect();
      if (Math.abs((r.left + r.right) / 2 - cx) < 4 && it.bottom > r.top - GAP && it.top < r.bottom) {
        lift = Math.max(lift, it.bottom - (r.top - GAP));
      }
    });
    return lift;
  }

  // How far (px) a small bubble has to step to the side (right first, then left) to be clear, at its own height.
  // The arrow must stay inside the bubble: at most half its width minus 12 px. 0 = no free place within that.
  // It does not step under the legend, the clock box or the minimap: they are drawn over the bubbles and would hide it.
  function sideShift(it, firstHit) {
    var maxDx = Math.floor((it.right - it.left) / 2 - 12);
    var ui = [];
    document.querySelectorAll(".home-legend, .home-clockbar, .home-minimap").forEach(function (e) {
      var r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { ui.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }); }
    });
    for (var s = 2; s <= maxDx; s += 2) {
      for (var sign = 1; sign >= -1; sign -= 2) {
        var d = s * sign;
        var c = { left: it.left + d, right: it.right + d, top: it.top, bottom: it.bottom };
        if (ui.some(function (u) { return overlaps(c, u); })) { continue; }
        if (!firstHit(c)) { return d; }
      }
    }
    return 0;
  }

  // How far (px) a small bubble has to move down to sit just under its own triangle.
  function belowShift(it) {
    var cx = (it.left + it.right) / 2, best = null;
    document.querySelectorAll(".leaflet-marker-icon.marker-blink, .leaflet-marker-icon.marker-ended").forEach(function (m) {
      var r = m.getBoundingClientRect();
      if (Math.abs((r.left + r.right) / 2 - cx) < 4 && r.top >= it.bottom - 4 && (!best || r.top < best.top)) { best = r; }
    });
    var iconBottom = best ? best.bottom : it.bottom + 32;
    return (iconBottom + 8) - it.top;      // 8 px of room for the arrow
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(function () { queued = false; sync(); });
  }

  function start() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.setInterval(schedule, 500);     // zooming moves the bubbles without adding or removing any
    schedule();
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
