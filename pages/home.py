import dash
from dash import html, dcc, callback, Output, Input, State, ALL
import dash_leaflet as dl
import dash_bootstrap_components as dbc
import pandas as pd
import json
import math
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from volcano_alert_registry import (VolcanoIndex, normalize_jma, normalize_vaac, upsert_alerts, read_alerts,
                                    record_events, read_events)
from volcano_data import XLSX_PATH, BASE_DIR
from volcano_official_collectors import collect_pvmbg, collect_kvert, collect_phivolcs
import os
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from source_cache import cached_call, digest

_REGISTRY_DB = os.path.join(BASE_DIR, "cache", "volcano_alerts.sqlite3")
_REGISTRY_INDEX = None
_LAST_RECENT_KEY = [None]     # skip re-recording an unchanged Tokyo advisory list
_LAST_REGISTRY_KEY = [None]   # skip JMA/VAAC DB upserts when nothing changed

def _registry_index():
    global _REGISTRY_INDEX
    if _REGISTRY_INDEX is None:
        _REGISTRY_INDEX = VolcanoIndex(XLSX_PATH)
    return _REGISTRY_INDEX

from data_loader import load_rsam, load_ssam, load_peak_pressure
from plot_utils import plot_rsam, plot_ssam, plot_peak_pressure, empty_figure
from volcano_data import (
    load_volcano_master, get_target_info, get_combined_vaac_table,
    get_jma_alerts, get_jma_alert_for_target,
    get_mirova_alerts, get_mirova_active_volcanoes, get_mirova_all_names,
    get_vaac_active_volcanoes, JMA_NAME_MAP, VAAC_URL, DARWIN_LATEST_URL,
    get_vaac_table, get_darwin_vaac_table, get_vaa_history, get_vaac_recent_list, MIROVA_URL
)

dash.register_page(__name__, path="/")

# The view shown right after a page load (and by the home button): Kamchatka in the north-east to
# Indonesia in the south-west. Given as bounds so it fits any screen size.
INITIAL_BOUNDS = [[-22.0, 80.0], [63.0, 180.0]]   # extra room in the south-west: the legend covers that corner
VOLCANOES   = ["Asosan", "Kirishimayama", "Sakurajima", "Kuchinoerabujima", "Ontakesan"]
DATA_TYPES  = ["RSAM", "SSAM"]

# JMA alert color rules
# Yellow blink: level 2, 3 (yellow/orange on JMA map)
# Red blink: level 4, 5 (red/purple on JMA map)
def jma_blink_color(level):
    if level in [2, 3]:
        return "yellow"
    elif level >= 4:
        return "red"
    return None

# ── Mini graph helper ──────────────────────────────────────
# Returns (dcc.Graph, figure) — the figure is also handed back so the
# caller can read the last x-value off it for the "last data time"
# display, without needing to know data_loader's raw dataframe columns.
def make_mini_graph(volcano, dtype, idx, show_xaxis=False):
    try:
        if dtype == "RSAM":
            df = load_rsam(volcano)
            fig = plot_rsam(df, mini=True, volcano=volcano)
        elif dtype == "SSAM":
            df = load_ssam(volcano)
            fig = plot_ssam(df, mini=True, volcano=volcano)
        else:
            df = load_peak_pressure(volcano)
            fig = plot_peak_pressure(df, mini=True, volcano=volcano)
    except Exception:
        fig = empty_figure(mini=True)

    # X-axis (date) stays hidden on every mini graph except the very
    # last one in the whole grid (Ontakesan/SSAM) — repeating the same
    # date scale on all 10 graphs was just clutter. That one graph
    # gets extra bottom margin + height so the "2026" year label isn't
    # clipped. This runs at layout-build time (not inside a callback),
    # so guard it — an unhandled exception here would break the whole
    # Home page.
    try:
        if show_xaxis:
            fig.update_xaxes(visible=True, showticklabels=True)
            fig.update_layout(margin=dict(b=40))
        else:
            fig.update_xaxes(visible=False)
            fig.update_layout(margin=dict(b=6))
    except Exception:
        pass

    graph = dcc.Graph(
        figure=fig,
        id={"type": "mini-graph", "index": idx},
        config={"displayModeBar": False},
        style={"height": "120px" if show_xaxis else "80px"},
    )
    return graph, fig


# ── Pull the last timestamp plotted in a figure (works for any
# plot_utils output, since it just reads trace.x — no need to know
# data_loader's raw dataframe column names). ──
def get_fig_last_time(fig):
    try:
        for trace in fig.data:
            x = getattr(trace, "x", None)
            if x is not None and len(x) > 0:
                return pd.to_datetime(x[-1], utc=True)
    except Exception:
        pass
    return None


def round_up_to_hour(ts):
    if ts.minute == 0 and ts.second == 0 and ts.microsecond == 0:
        return ts.replace(minute=0, second=0, microsecond=0)
    return (ts + pd.Timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)


# ── One volcano's block in the right-hand grid: header + its mini
# graphs. Also returns the last-plotted timestamps found, so the
# caller can combine them into ONE shared "last data" footer instead
# of repeating it under every volcano. ──
def build_volcano_block(v, is_last_volcano):
    graph_cells = []
    block_last_times = []
    n_dtypes = len(DATA_TYPES)
    for i, dt in enumerate(DATA_TYPES):
        show_axis = is_last_volcano and (i == n_dtypes - 1)
        graph, fig = make_mini_graph(v, dt, f"{v}_{dt}", show_xaxis=show_axis)
        graph_cells.append(html.Div(
            graph,
            id={"type": "grid-cell", "volcano": v, "dtype": dt},
            style={"border": "1.5px solid #27ae60", "borderRadius": "6px",
                   "overflow": "hidden", "marginBottom": "4px",
                   "backgroundColor": "#f0faf4"}
        ))
        t = get_fig_last_time(fig)
        if t is not None:
            block_last_times.append(t)

    block = html.Div([
        html.Div(v,
                 id={"type": "volcano-header", "volcano": v},
                 style={"fontSize": "12px", "fontWeight": "500",
                        "color": "#27ae60", "marginBottom": "4px",
                        "paddingLeft": "4px", "cursor": "pointer",
                        "borderBottom": "1px solid #27ae60",
                        "paddingBottom": "2px"}),
        *graph_cells,
    ], id=f"grid-volcano-{v}", style={"padding": "4px", "marginBottom": "12px"})

    return block, block_last_times


# ── Shared "last data" / countdown footer, shown once at the very
# bottom of the grid (below Ontakesan) instead of once per volcano. ──
def build_grid_footer(all_last_times):
    if all_last_times:
        last_time_str = round_up_to_hour(max(all_last_times)).strftime("%Y-%m-%d %H:%M UTC")
    else:
        last_time_str = "N/A"

    row_style = {"fontSize": "17px", "fontWeight": "700", "textAlign": "center",
                "color": "#1a3a5c"}

    return html.Div([
        html.Div([
            html.Span("Last data: "),
            html.Span(last_time_str),
        ], style={**row_style, "marginBottom": "8px"}),
        html.Div([
            html.Span("Next update in: "),
            html.Span("--:--", id="global-countdown-timer",
                      style={"fontFamily": "monospace"}),
        ], style=row_style),
    ], style={"padding": "14px 8px", "marginTop": "4px",
             "borderTop": "2px solid #1a3a5c", "backgroundColor": "#f0faf4"})


def _build_grid_children():
    blocks = []
    all_last_times = []
    for i, v in enumerate(VOLCANOES):
        is_last = (i == len(VOLCANOES) - 1)
        block, times = build_volcano_block(v, is_last)
        blocks.append(block)
        all_last_times.extend(times)
    blocks.append(build_grid_footer(all_last_times))
    return blocks


# ── Build map markers ──────────────────────────────────────
def _norm_name(value):
    return "".join(c for c in str(value).casefold() if c.isalnum())

@lru_cache(maxsize=4096)
def _aliases(name):
    names = {str(name), "Sakurajima" if name == "Aira" else str(name)}
    if name in ("Aira", "Sakurajima"):
        names.update(("Aira", "Sakurajima", "Sakurajima (Aira Caldera)"))
    for original, mapped in JMA_NAME_MAP.items():
        if mapped in names:
            names.add(original)
    return {_norm_name(n) for n in names}


def _matches(name, candidate):
    key = _norm_name(candidate)
    aliases = _aliases(name)
    if key in aliases:
        return True
    # Tokyo VAA sometimes appends the caldera name and/or volcano number.
    if name in ("Aira", "Sakurajima"):
        return key.startswith("sakurajima") or key == "aira" or "282080" in key
    return False


def _time_label(value):
    if not value:
        return "Time not available"
    raw = str(value).strip()
    try:
        import re
        m = re.search(r"(\d{8})[/ ](\d{4})(?:Z)?", raw)
        if m:
            dt = datetime.strptime(m.group(1)+m.group(2), "%Y%m%d%H%M")
            return dt.strftime("%b %d, %Y %H:%M UTC")
        dt = pd.to_datetime(raw, utc=True, errors="coerce")
        if not pd.isna(dt):
            return dt.strftime("%b %d, %Y %H:%M UTC")
    except (ValueError, TypeError, OverflowError):
        pass
    return raw


def _time_short(value):
    """Compact form for the small bubbles: 'Oct 20 20:52Z' (same parsing as _time_label)."""
    label = _time_label(value)
    try:
        return datetime.strptime(label, "%b %d, %Y %H:%M UTC").strftime("%b %d %H:%MZ")
    except ValueError:
        return label


VAA_WINDOW_HOURS = 24      # a volcano counts as "VAAC advisory current" for this long after its latest VAA


def _vaa_issued_dt(value):
    """Issue time of an advisory as an aware UTC datetime, or None. Handles the formats of every source
    (Tokyo front page, Tokyo list, BoM bulletins 'YYYYMMDD/HHMMZ')."""
    if not value:
        return None
    raw = str(value).strip()
    try:
        import re
        m = re.search(r"(\d{8})[/ ](\d{4})(?:Z)?", raw)
        if m:
            return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        dt = pd.to_datetime(raw, utc=True, errors="coerce")
        return None if pd.isna(dt) else dt.to_pydatetime()
    except (ValueError, TypeError, OverflowError):
        return None


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _vaa_sort_key(row):
    """Sort key by real issue time. The sources write the time in different formats, so comparing the
    raw strings can put an older advisory first."""
    return _vaa_issued_dt(row.get("datetime")) or _EPOCH


def _vaa_status(alert_data, name):
    """State of one volcano's advisories in BoM's 24-hour feed (all VAACs).

    {"current": [...], "ended": row or None}
      current - advisories issued within the last VAA_WINDOW_HOURS (blinking triangle); empty if the
                latest one says "no further advisories".
      ended   - that latest advisory, when it says "no further advisories" (the VAAC has finished with
                this event): the volcano keeps a quiet, non-blinking bubble for the rest of the 24 hours.
    A bulletin that appears twice (same issuing VAAC, same volcano, same issue minute) is kept once; it
    counts as "no further advisories" if any copy says so."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=VAA_WINDOW_HOURS)
    found = {}
    for r in alert_data.get("vaac_rows", []):
        if not _matches(name, r.get("volcano", "")):
            continue
        issued = _vaa_issued_dt(r.get("datetime"))
        if issued is None or issued < cutoff:
            continue
        key = (r.get("source"), _norm_name(r.get("volcano", ""))[:10], issued.strftime("%Y%m%d%H%M"))
        if key in found:
            found[key]["terminal"] = found[key]["terminal"] or bool(r.get("is_terminal", False))
        else:
            found[key] = {"row": r, "issued": issued, "terminal": bool(r.get("is_terminal", False))}
    if not found:
        return {"current": [], "ended": None}
    latest = max(found.values(), key=lambda c: c["issued"])
    if latest["terminal"]:
        return {"current": [], "ended": latest["row"]}
    return {"current": [c["row"] for c in found.values() if not c["terminal"]], "ended": None}


def _recent_vaa(alert_data, name):
    """Advisories that make the volcano's triangle blink (see _vaa_status)."""
    return _vaa_status(alert_data, name)["current"]


def _jma_issued(name, data):
    for source_name, value in data.get("jma_issued", {}).items():
        if _matches(name, JMA_NAME_MAP.get(source_name, source_name)) or _matches(name, source_name):
            return _time_label(value)
    return "Issue time unavailable"


def _mirova_for(name, data):
    matched = [r for r in data.get("mirova_rows", [])
               if _matches(name, r.get("our_name") or r.get("volcano", ""))]
    def vrp(row):
        try: return float(str(row.get("vrp_mw", "")).replace(",", ""))
        except (TypeError, ValueError): return -1
    return max(matched, key=vrp) if matched else None

def _mirova_style(vrp):
    try:
        value = float(str(vrp).replace(",", ""))
    except (ValueError, TypeError):
        return None
    if value > 10000: return "#8e44ad"
    if value >= 1000: return "#e74c3c"
    if value >= 100: return "#e67e22"
    if value >= 10: return "#f1c40f"
    return "#2ecc71"

def _alert_for_volcano(name, alert_data, status=None):
    aliases = _aliases(name)
    jma = 0
    for source_name, level in alert_data.get("jma_raw", {}).items():
        if _matches(name, source_name) or _matches(name, JMA_NAME_MAP.get(source_name, source_name)):
            try: jma = max(jma, int(level))
            except (ValueError, TypeError): pass
    vaa = (status or _vaa_status(alert_data, name))["current"]
    mirova = [r for r in alert_data.get("mirova_rows", [])
              if _matches(name, r.get("our_name") or r.get("volcano", ""))]
    vrp = None
    if mirova:
        valid = []
        for r in mirova:
            try: valid.append(float(str(r.get("vrp_mw", "")).replace(",", "")))
            except (ValueError, TypeError): pass
        if valid: vrp = max(valid)
    return jma, vaa, vrp

OFFICIAL_COLORS = {
    "JMA": {"2":"#FFD400", "3":"#FF8C00", "4":"#E02020", "5":"#B000B0"},
    "PVMBG": {"2":"#FFD400", "3":"#FF8C00", "4":"#B000B0"},
    "KVERT": {"GREEN":"#2ecc71", "YELLOW":"#FFD400", "ORANGE":"#FF8C00", "RED":"#E02020"},
    # Level 0 (no alert) is deliberately absent -> transparent marker, like PVMBG level I.
    "PHIVOLCS": {"1":"#FFD400", "2":"#FF8C00", "3":"#E02020", "4":"#B000B0", "5":"#5b0a7a"},
}

def _official_alert(name, data, number=None):
    try:
        index = _registry_index()
        n = index.resolve(volcano_number=number, name=name)
        records = (data or {}).get("registry", {}).get("by_number", {}).get(str(n), [])
        options = [r for r in records if r.get("source") in OFFICIAL_COLORS
                   and r.get("alert_type") in ("volcano_level", "aviation_code")]
        country = str(index.by_number.get(n, {}).get("country", "")).casefold()
        preferred = ("PVMBG" if "indonesia" in country else "KVERT" if "russia" in country
                     else "PHIVOLCS" if "philippines" in country else "JMA")
        options.sort(key=lambda r: (r.get("source") == preferred, not r.get("stale", False)), reverse=True)
        return options[0] if options else None
    except Exception:
        return None

def _official_color(record):
    if not record or record.get("stale"):
        return "transparent"
    return OFFICIAL_COLORS.get(record.get("source"), {}).get(str(record.get("level")), "transparent")

def _official_line(record):
    if not record:
        return "Official alert: not available"
    return str(record.get("label") or record.get("source")) + (" · STALE (last successful record)" if record.get("stale") else "")

@lru_cache(maxsize=512)
def _marker_icon_url(size, fill, stroke, width):
    """Triangle icon data-URL; only a handful of distinct combinations exist."""
    svg = (f"<svg xmlns='http://www.w3.org/2000/svg' width='{size}' height='{size}' viewBox='0 0 24 24'>"
           f"<polygon points='12,2 22,22 2,22' fill='{fill}' stroke='{stroke}' stroke-width='{width}' "
           f"stroke-linejoin='round'/></svg>")
    return "data:image/svg+xml;charset=utf-8," + urllib.parse.quote(svg)


def build_map_markers(alert_data):
    df = load_volcano_master()
    markers, ended_markers, blinking = [], [], []
    jma_colors = {2:"#FFD400",3:"#FF8C00",4:"#E02020",5:"#B000B0"}
    for _, row in df.iterrows():
        name = str(row["volcano_name"])
        display_name = "Sakurajima" if name == "Aira" else name
        status = _vaa_status(alert_data, name)
        vaa, ended = status["current"], status["ended"]
        jma, _vaa_unused, vrp = _alert_for_volcano(name, alert_data, status)
        official = _official_alert(name, alert_data, row.get("volcano_number"))
        has_bubble = bool(vaa) or ended is not None
        active = jma >= 2 or has_bubble or vrp is not None or _official_color(official) != "transparent"
        # No alert: small and see-through, so the 1,200+ quiet volcanoes do not compete with the alerts.
        # Alert level only (and an ended advisory): 18. Blinking (VAAC advisory current): the largest (24)
        # with a glow (.leaflet-marker-icon.marker-blink in home_layout.css), so it stands out among yellow
        # triangles.
        size = 24 if vaa else (18 if active else 8)
        fill = _official_color(official) or "transparent"
        stroke = _mirova_style(vrp) if vrp is not None else "#ffffff"
        width = 3.4 if vrp is not None else (1.7 if active else 2.4)
        url = _marker_icon_url(size, fill, stroke, width)
        pos = [float(row["latitude"]), float(row["longitude"])]
        marker_id = {"type": "map-marker", "name": display_name}
        if not has_bubble:
            markers.append(dl.Marker(position=pos, opacity=1.0 if active else 0.5,
                icon=dict(iconUrl=url, iconSize=[size, size], iconAnchor=[size/2, size], className=""),
                id=marker_id, children=dl.Tooltip(display_name)))
            continue
        # A VAAC advisory within the last 24 h: a small bubble above the triangle names the volcano and the
        # time of the LATEST advisory; clicking opens the big bubble (same content as the right-hand status
        # message). Blinking while the advisory series is open; a volcano whose latest advisory says
        # "no further advisories" keeps the bubble (marked "final") but does not blink.
        latest = max(vaa, key=_vaa_sort_key) if vaa else ended
        time_line = "VAAC " + _time_short(latest.get("datetime")) + ("" if vaa else " · final")
        # Bubbles of neighbouring volcanoes (Ibu / Dukono, Krakatau / Semeru) are kept apart in the
        # browser, from their real on-screen positions (assets/home_bubbles.js), because who overlaps
        # whom depends on the zoom level.
        bubble = dl.Tooltip(
            html.Div([html.Div(display_name, className="vaa-bubble-name"),
                      html.Div(time_line, className="vaa-bubble-time")]),
            permanent=True, direction="top", className="vaa-bubble" + ("" if vaa else " vaa-bubble-final"),
            interactive=True)
        # The big bubble does not open the right-hand panel by itself; its button does.
        # only the latest advisory of the volcano on the map (several bulletins within 24 h: latest one)
        popup = dl.Popup([_volcano_status_panel(display_name, alert_data, max_vaa=1), *_popup_buttons(display_name)],
                         className="vaa-popup",
                         maxWidth=340, minWidth=300, autoPan=False)    # the map flies to the volcano itself
        marker = dl.Marker(position=pos,
            icon=dict(iconUrl=url, iconSize=[size, size], iconAnchor=[size/2, size],
                      tooltipAnchor=[0, -(size + 2)], popupAnchor=[0, -(size + 6)],
                      className="marker-blink" if vaa else "marker-ended"),
            # Leaflet's z-index is the marker's pixel row + this offset; the pixel row reaches the tens
            # of thousands when zoomed in, so the offset has to be far larger than that.
            zIndexOffset=1_000_000 if vaa else 500_000, id=marker_id, children=[bubble, popup])
        (blinking if vaa else ended_markers).append(marker)
    return markers + ended_markers + blinking

# Volcanoes that have a page on the Seismic menu: their big bubble gets a button that opens it.
SEISMIC_VOLCANOES = ("Sakurajima", "Asosan", "Kirishimayama")


def _popup_buttons(name):
    """Buttons at the bottom of a big bubble: the side panel, and (Sakurajima / Asosan / Kirishimayama) the Seismic page."""
    buttons = [html.Button("More details in the side panel ▸", id={"type": "popup-more", "name": name},
                           n_clicks=0, className="home-popup-more")]
    # the public service (LAVA_PAGES) may not serve the Seismic menu: then there is nothing to open
    pages = os.getenv("LAVA_PAGES")
    if name in SEISMIC_VOLCANOES and (pages is None or "Seismic" in [p.strip() for p in pages.split(",")]):
        buttons.append(dcc.Link("Open Seismic ▸", href="/seismic?volcano=" + urllib.parse.quote(name),
                                className="home-popup-more home-popup-seismic"))
    return buttons


def _legend_item(label, fill="transparent", stroke="#98a2b3", blink=False, size=22, title=None):
    svg = f"<svg xmlns='http://www.w3.org/2000/svg' width='{size}' height='{size}' viewBox='0 0 24 24'><polygon points='12,2 22,22 2,22' fill='{fill}' stroke='{stroke}' stroke-width='3'/></svg>"
    return html.Div([html.Img(src="data:image/svg+xml;charset=utf-8,"+urllib.parse.quote(svg),
                              className="marker-blink" if blink else "",style={"width":f"{size}px","height":f"{size}px"}),
                     html.Span(label,style={"fontSize":"12px"}) if label else html.Span()],
                    title=title or None,
                    style={"display":"flex","alignItems":"center","gap":"4px"})


# ── VAAC areas of responsibility ──
# Hand-traced (lat, lon) outlines of the ICAO VAAC areas, read off the
# "Volcanic Ash Advisory Centers – Areas of Responsibility" chart. Display
# only — NOT official boundaries. Longitudes run -30..330 so that regions
# crossing the dateline stay one polygon; _vaac_region_polygons() also draws
# +/-360 copies so every world copy of the map shows them.
VAAC_RED, VAAC_BLUE = "#e02020", "#1f4fd8"
VAAC_AREAS = {
    "Tokyo": [[90,90],[90,150],[60,150],[60,180],[54,170],[50,160],[43.5,165],[27,165],[27,155],
              [21,155],[21,130],[10,130],[10,100],[20,100],[20,90]],
    "Anchorage": [[90,150],[90,220],[61,220],[60,226],[55,231],[55,228],[51,230],[48.5,235],
                  [48.5,211],[43,211],[43.5,165],[50,160],[54,170],[60,180],[60,150]],
    "Montreal": [[90,220],[61,220],[60,226],[55,231],[55,228],[51,230],[48.5,235],[48.5,269],
                 [44,276],[43.5,284],[45,294],[45,320],[45,330],[90,330]],
    "Washington": [[43.5,165],[43,211],[48.5,211],[48.5,269],[44,276],[43.5,284],[45,294],[45,320],
                   [20.5,320],[16,322],[8,324],[4,330],[-10,330],[-10,220],[0,220],[0,160.5],
                   [10,160.5],[10,130],[21,130],[21,155],[27,155],[27,165]],
    "London": [[90,-30],[90,90],[71,90],[71,30],[67,30],[60,28],[55,10],[49,-5],[48,-8],[45,-8],[45,-30]],
    "Toulouse": [[45,-30],[45,-8],[48,-8],[49,-5],[55,10],[60,28],[71,30],[71,90],[20,90],[20,83],
                 [10,81],[5,78.5],[-4,78.5],[-7,76],[-90,75],[-90,-10],[-6,-10],[-6,-15],[3.5,-30]],
    "Darwin": [[20,90],[20,100],[10,100],[10,160.5],[-14,160.5],[-17,163],[-90,163],[-90,75],
               [-7,76],[-4,78.5],[5,78.5],[10,81],[20,83]],
    "Wellington": [[0,160.5],[0,220],[-10,220],[-10,270],[-90,270],[-90,163],[-17,163],[-14,160.5]],
    "Buenos Aires": [[-10,-90],[-10,-10],[-90,-10],[-90,-90]],
}

# Regions that have a data feed → summary tile (name must match row["source"]).
VAAC_REGIONS = [
    {"name": "Tokyo VAAC", "area": "Tokyo", "color": VAAC_BLUE, "source_url": VAAC_URL,
     "bounds": [[10, 90], [70, 180]]},
    {"name": "Darwin VAAC", "area": "Darwin", "color": VAAC_BLUE, "source_url": DARWIN_LATEST_URL,
     "bounds": [[-40, 75], [20, 163]]},
]


# Where each area's name is written on the main map. Chosen to lie inside the first screen
# (INITIAL_BOUNDS) wherever the area reaches it - the polygon centre of the big areas
# (Tokyo and Darwin run to the pole) would fall off the screen.
VAAC_LABEL_POS = {
    # Tokyo / Anchorage / Washington / Darwin / Wellington: the spots the user marked on a screenshot
    # of the first screen (open ocean, away from the volcano triangles).
    "Tokyo": [31.3, 151.4], "Darwin": [5.1, 148.8], "Anchorage": [46.7, 172.8],
    "Washington": [38.9, 174.1], "Wellington": [-4.1, 170.5], "Toulouse": [12.0, 70.0],
    "London": [62.0, 45.0], "Montreal": [60.0, 285.0], "Buenos Aires": [-30.0, -50.0],
}
_LABEL_ICON = dict(iconUrl="data:image/svg+xml;charset=utf-8," + urllib.parse.quote(
    "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>"), iconSize=[1, 1], iconAnchor=[0, 0])


# Minimap: the names are tooltips on the area outlines, which put them at the centre of each area's bounding
# box. These five are placed by hand instead ([lat, lon]), where the user marked them on a screenshot of the
# first screen: clear of the box's edges (Wellington sits where the Leaflet logo used to be, on the same line as Darwin).
MINI_LABEL_POS = {"Toulouse": [30.4, 53.0], "Tokyo": [37.5, 124.1], "Darwin": [-34.9, 119.8],
                  "Wellington": [-34.9, 210.0], "Washington": [15.2, 196.0]}


def _vaac_region_polygons(highlight=None, mini=False):
    """All areas blue; the `highlight` area (the one holding the selected volcano) red.
    mini=True gives the thin version used on the minimap. On the main map the area
    names are separate label markers (VAAC_LABEL_POS), the outlines carry no tooltip."""
    polys = []
    if not mini:
        for name, pos in VAAC_LABEL_POS.items():
            on = name == highlight
            polys.append(dl.Marker(
                id=f"vaac-label-{name}-{'on' if on else 'off'}", position=pos, icon=_LABEL_ICON,
                interactive=False, keyboard=False,
                children=dl.Tooltip(f"{name} VAAC", permanent=True, direction="center",
                                    className="vaac-label vaac-label-on" if on else "vaac-label")))
    # Highlighted area last so its red outline sits on top of the shared borders.
    for name, pts in sorted(VAAC_AREAS.items(), key=lambda kv: kv[0] == highlight):
        on = name == highlight
        color = VAAC_RED if on else VAAC_BLUE
        for shift in (-360, 0, 360):
            polys.append(dl.Polygon(
                # The id carries the highlight state so Leaflet re-creates the
                # shape (restyling in place does not repaint the path).
                id=f"{'mini-' if mini else ''}vaac-{name}-{shift}-{'on' if on else 'off'}",
                positions=[[lat, lon + shift] for lat, lon in pts],
                color=color,
                weight=(2 if on else 1) if mini else (4 if on else 3),
                fillColor=color,
                fillOpacity=0 if mini else (0.12 if on else 0.04),
                interactive=not mini,
                children=(dl.Tooltip(name, permanent=True, direction="center",
                                     className="vaac-label vaac-label-mini")
                          if mini and shift == 0 and name not in MINI_LABEL_POS else None),
            ))
        if mini and name in MINI_LABEL_POS:       # a hand-placed name: a label marker at that position
            polys.append(dl.Marker(
                id=f"mini-vaac-label-{name}-{'on' if on else 'off'}", icon=_LABEL_ICON, interactive=False, keyboard=False,
                position=MINI_LABEL_POS[name],
                children=dl.Tooltip(name, permanent=True, direction="center", className="vaac-label vaac-label-mini")))
    return polys


def _point_in_polygon(lat, lon, pts):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        lat_i, lon_i = pts[i]
        lat_j, lon_j = pts[j]
        if (lat_i > lat) != (lat_j > lat) and                 lon < (lon_j - lon_i) * (lat - lat_i) / (lat_j - lat_i) + lon_i:
            inside = not inside
        j = i
    return inside


def _vaac_area_for(lat, lon):
    """Name of the VAAC area containing (lat, lon), or None. Areas run -30..330 E,
    so try the longitude and its +/-360 equivalents."""
    for name, pts in VAAC_AREAS.items():
        for shift in (0, 360, -360):
            if _point_in_polygon(lat, lon + shift, pts):
                return name
    return None


# Official alert scales per agency. PHIVOLCS levels 0-5 follow
# phivolcs.dost.gov.ph/volcano-alert-levels (that scheme defines no colours, so
# the fills are display-only). Level 0 is "no alert" -> nothing is drawn, so it
# is not in the legend. Full level names are shown as hover tooltips.
PHIVOLCS_LEGEND = [
    ("L1", "#FFD400", "1 · Low-level unrest"),
    ("L2", "#FF8C00", "2 · Increasing unrest"),
    ("L3", "#E02020", "3 · Intensified / magmatic unrest"),
    ("L4", "#B000B0", "4 · Eruption imminent"),
    ("L5", "#5b0a7a", "5 · Hazardous eruption in progress"),
]

# Agency -> scope shown next to the agency name.
LEGEND_AGENCIES = {
    "JMA": "Japan",
    "PVMBG": "Indonesia",
    "PHIVOLCS": "Philippines",
    "KVERT": "Kamchatka",
    "MIROVA": "thermal",
    "VAAC": "aviation",
}

# MIROVA volcanic radiative power classes: (short label, border colour, range)
MIROVA_LEGEND = [
    ("Low", "#2ecc71", "< 10 MW"),
    ("Moderate", "#f1c40f", "10 – 100 MW"),
    ("High", "#e67e22", "100 – 1,000 MW"),
    ("Very high", "#e74c3c", "1,000 – 10,000 MW"),
    ("Extreme", "#8e44ad", "> 10,000 MW"),
]

# Explanations shown beside the legend when an agency name is clicked.
# rows: (colour, "fill" | "stroke" | None, label, meaning)
LEGEND_DETAILS = {
    "JMA": {
        "title": "JMA · Volcanic Alert Level (Japan)",
        "intro": "Five-level scheme for the area people should keep out of. Level 1 is not drawn.",
        "rows": [("#FFD400", "fill", "Level 2", "Do not approach the crater"),
                 ("#FF8C00", "fill", "Level 3", "Do not approach the volcano"),
                 ("#E02020", "fill", "Level 4", "Prepare to evacuate"),
                 ("#B000B0", "fill", "Level 5", "Evacuate")],
        "link": ("jma.go.jp", "https://www.jma.go.jp/jma/en/Activities/volcano.html"),
    },
    "PVMBG": {
        "title": "PVMBG · Activity level (Indonesia)",
        "intro": "Four levels. Level I (Normal) is not drawn.",
        "rows": [("#FFD400", "fill", "II · Waspada", "Alert: activity above normal"),
                 ("#FF8C00", "fill", "III · Siaga", "Standby: eruption may be approaching"),
                 ("#B000B0", "fill", "IV · Awas", "Danger: eruption imminent or under way")],
        "link": ("magma.esdm.go.id", "https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas"),
    },
    "PHIVOLCS": {
        "title": "PHIVOLCS · Volcano Alert Level (Philippines)",
        "intro": "Levels 0-5. Level 0 (No alert / Normal) is not drawn. PHIVOLCS defines no colours; "
                 "these are display colours only.",
        "rows": [(c, "fill", "Level " + t.split(" · ")[0], t.split(" · ")[1])
                 for _l, c, t in PHIVOLCS_LEGEND],
        "link": ("phivolcs.dost.gov.ph", "https://www.phivolcs.dost.gov.ph/volcano-alert-levels"),
    },
    "KVERT": {
        "title": "KVERT · Aviation Colour Code (Kamchatka)",
        "intro": "ICAO colour code for the aviation hazard. Shown as the triangle fill.",
        "rows": [("#2ecc71", "fill", "Green", "Normal background activity"),
                 ("#FFD400", "fill", "Yellow", "Elevated unrest above background"),
                 ("#FF8C00", "fill", "Orange", "Heightened unrest, eruption possible, or eruption with little ash"),
                 ("#E02020", "fill", "Red", "Eruption imminent or in progress with significant ash")],
        "link": ("kvert.febras.net", "http://kvert.febras.net/van/"),
    },
    "MIROVA": {
        "title": "MIROVA · thermal anomaly (VRP)",
        "intro": "Volcanic Radiative Power: heat radiated by a volcano, measured from satellite "
                 "(MODIS/VIIRS) infrared data. Shown as the triangle border colour.",
        "rows": [(c, "stroke", l, r) for l, c, r in MIROVA_LEGEND],
        "link": ("mirovaweb.it", MIROVA_URL),
    },
    "VAAC": {
        "title": "VAAC · Volcanic Ash Advisory Centres",
        "intro": "Nine ICAO centres, each responsible for one region. Advisories come from Tokyo and Darwin.",
        "rows": [(None, "blink", "Advisory", "Blinking triangle: an ash advisory is current"),
                 (None, None, "Area (blue)", "Area of responsibility of each VAAC"),
                 (VAAC_RED, None, "Selected (red)", "The VAAC area that holds the selected volcano")],
        "link": ("data.jma.go.jp/vaac", VAAC_URL),
    },
}


def _legend_agency(code, items):
    """Compact legend row: clickable agency name + scope, then its items on one line."""
    return html.Div([
        html.Div([
            html.Button([code, " ⓘ"], id={"type": "legend-chip", "code": code}, n_clicks=0,
                        className="legend-chip legend-chip-btn", title="Click for level descriptions"),
            html.Span(LEGEND_AGENCIES[code], className="legend-scope"),
        ], className="legend-head"),
        html.Div(items, className="legend-items"),
    ], className="legend-agency")


def _legend_body():
    tri = lambda text, fill, tip=None: _legend_item(text, fill=fill, size=18, title=tip)
    return html.Div([
        _legend_agency("JMA", [tri(f"L{lvl}", c) for lvl, c in
                               [(2, "#FFD400"), (3, "#FF8C00"), (4, "#E02020"), (5, "#B000B0")]]),
        _legend_agency("PVMBG", [tri(l, c, t) for l, c, t in
                                 [("II", "#FFD400", "II Waspada"), ("III", "#FF8C00", "III Siaga"),
                                  ("IV", "#B000B0", "IV Awas")]]),
        _legend_agency("PHIVOLCS", [tri(l, c, t) for l, c, t in PHIVOLCS_LEGEND]),
        # KVERT is a pure colour code: triangles only, no text.
        _legend_agency("KVERT", [tri(None, c, n) for n, c in
                                 [("GREEN", "#2ecc71"), ("YELLOW", "#FFD400"),
                                  ("ORANGE", "#FF8C00"), ("RED", "#E02020")]]),
        _legend_agency("MIROVA", [_legend_item(l, stroke=c, size=18, title=f"{l}: {r}") for l, c, r in MIROVA_LEGEND]),
        _legend_agency("VAAC", [_legend_item("Advisory", blink=True, size=18),
                                _legend_item("None", size=18),
                                html.Span([html.Span("▭", style={"color": VAAC_BLUE, "fontWeight": "700"}), " Area"],
                                          className="legend-text"),
                                html.Span([html.Span("▭", style={"color": VAAC_RED, "fontWeight": "700"}), " Selected"],
                                          className="legend-text")]),
        html.Div("Fill = agency level · Border = MIROVA · click a name for details", className="legend-foot"),
    ])


def _legend_detail_content(code):
    """Panel body for one agency: what each legend level means."""
    d = LEGEND_DETAILS[code]
    rows = []
    for colour, mode, label, meaning in d["rows"]:
        if mode in ("fill", "stroke"):
            icon = _legend_item(None, fill=colour if mode == "fill" else "transparent",
                                stroke=colour if mode == "stroke" else "#98a2b3", size=16)
        elif mode == "blink":
            icon = _legend_item(None, blink=True, size=16)
        else:
            icon = html.Span("▭", style={"color": colour or VAAC_BLUE, "fontWeight": "700", "width": "16px"})
        rows.append(html.Div([icon,
                              html.Span(label, style={"fontWeight": "600", "minWidth": "84px"}),
                              html.Span(meaning, style={"color": "#475467"})],
                             style={"display": "flex", "alignItems": "center", "gap": "8px", "fontSize": "12px",
                                    "padding": "2px 0"}))
    return [
        html.Div(d["title"], style={"fontWeight": "700", "marginBottom": "6px"}),
        *rows,
        html.A(d["link"][0], href=d["link"][1], target="_blank", style={"fontSize": "11px", "marginTop": "6px"}),
    ]


# ── Layout ─────────────────────────────────────────────────
layout = html.Div([

    # Full-area map with overlays
    dl.Map(
        id="volcano-map",
        className="home-map",     # hidden until the first fit is done (see fit_first_screen and the reveal callback in pages/home.py)
        # NOT the `bounds` prop: with it set from the start, dash-leaflet's moveend handler throws on every
        # move and the map's `bounds` output (minimap, area-name size) stops updating. A viewport with
        # bounds fits the same way and keeps it working.
        # Created at this centre / zoom and fitted to the first screen right after (fit_first_screen below). A fit given
        # here as `viewport` would be undone and animated away again by dash-leaflet applying zoom / center on top.
        center=[33.0, 125.0], zoom=3,
        zoomSnap=0.25,            # lets the initial fit use a fractional zoom instead of rounding down
        children=[
            dl.LayersControl([
                dl.BaseLayer(
                    dl.TileLayer(
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
                        attribution="Esri"
                    ),
                    name="Map"
                ),
                dl.BaseLayer(
                    dl.TileLayer(
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                        attribution="Esri World Imagery"
                    ),
                    name="Satellite", checked=True
                ),
                dl.Overlay(dl.LayerGroup(id="vaac-region-layer", children=_vaac_region_polygons()),
                           name="VAAC regions", checked=True),
            ]),
            dl.LayerGroup(id="marker-layer"),
            dl.LayerGroup(id="selected-marker-layer"),
        ],
        style={"height": "100%", "width": "100%"}
    ),

    # Back to the first screen in one click (zoom out + recentre)
    html.Button("⌂", id="reset-view", n_clicks=0, className="home-reset-btn",
                title="Back to the initial view"),

    # Top bar: clocks (UTC / KST)
    html.Div([
        html.Div(id="home-clocks"),     # filled by assets/home_clock.js
        html.Div([
            dbc.Switch(id="auto-refresh-switch", label="Auto refresh", value=True,
                       persistence=True, persistence_type="local", className="mb-0"),
            dbc.Select(id="refresh-interval", value="5", size="sm",
                       options=[{"label": "1 min", "value": "1"}, {"label": "5 min", "value": "5"},
                                {"label": "10 min", "value": "10"}, {"label": "30 min", "value": "30"}],
                       persistence=True, persistence_type="local", style={"width": "90px"}),
            html.Button("↻ Refresh", id="refresh-now", n_clicks=0, className="home-refresh-btn",
                        title="Refresh alert data now"),
            html.Span("", id="refresh-status", style={"fontSize": "11px", "color": "#667085"}),
            html.Span("", id="last-check", style={"fontSize": "11px", "color": "#667085"}),
        ], className="home-refresh-row"),
    ], className="home-clockbar"),

    # Map Legend (collapsible)
    html.Div([
        html.Div([
            html.Span("Map Legend", style={"fontWeight": "700", "fontSize": "14px"}),
            html.Button("▾", id="legend-toggle", n_clicks=0, className="home-legend-toggle",
                        title="Collapse / expand legend"),
        ], className="home-legend-header"),
        dbc.Collapse(_legend_body(), id="legend-collapse", is_open=True),
        html.Div(id="legend-detail", className="home-legend-detail", style={"display": "none"}),
    ], className="home-legend"),


    # Which volcano / VAAC area is selected (visible at any zoom level; empty when nothing is selected)
    html.Div(id="selected-info", className="home-selected-chip"),

    # Minimap overlay (bottom right)
    html.Div([
        dl.Map(
            id="mini-map",
            center=[33.0, 132.0],
            zoom=1,
            children=[
                dl.TileLayer(
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
                    attribution=""
                ),
                dl.LayerGroup(id="mini-vaac-layer", children=_vaac_region_polygons(mini=True)),
                dl.Rectangle(
                    id="minimap-bounds-rect",
                    bounds=[[20, 120], [50, 150]],
                    color="red", fill=True, fillColor="red", fillOpacity=0.1, weight=2,
                ),
            ],
            zoomControl=False, scrollWheelZoom=False, dragging=False, doubleClickZoom=False,
            attributionControl=False,       # no Leaflet logo on the minimap (the main map keeps its attribution)
            style={"height": "100%", "width": "100%"}
        )
    ], className="home-minimap"),

    # Right-edge tab button (single merged panel)
    html.Div([
        html.Button(["Volcano & Alerts ", html.Span("0", id="alert-count-badge", className="home-badge")],
                    id="tab-info", n_clicks=0, className="home-tab"),
    ], className="home-side-tabs"),

    # Slide-in side panel: selected volcano (30 days) or all active alerts (7 days)
    html.Div([
        html.Div([
            html.Span("Active Alerts · last 7 days", id="side-title", style={"fontWeight": "700", "fontSize": "17px"}),
            html.Div([
                html.Button("← All alerts", id="clear-selection", n_clicks=0, className="home-refresh-btn",
                            style={"display": "none"}, title="Clear selection"),
                html.Button("✕", id="side-close", n_clicks=0, className="home-legend-toggle", title="Close"),
            ], style={"display": "flex", "gap": "8px", "alignItems": "center"}),
        ], className="home-side-header"),
        html.Div(id="side-body", children="Loading…", style={"padding": "12px 16px 20px", "fontSize": "15px"}),
    ], id="side-panel", className="home-side-panel"),

    # Data stores
    dcc.Store(id="alert-store"),
    dcc.Store(id="selected-volcano-store"),
    dcc.Store(id="side-panel-state", data={"open": False}),
    dcc.Store(id="legend-open"),
    dcc.Store(id="selection-ctx"),
    dcc.Store(id="area-store"),               # VAAC area under the centre of the map view
    dcc.Store(id="map-ready-flag"),           # (only the targets of the clientside callbacks that show the map / markers)
    dcc.Store(id="markers-ready-flag"),
    dcc.Store(id="fit-trigger", data=1),      # fires the first fit once the page is built (see fit_first_screen)
    dcc.Store(id="fit-done"),                 # set when the first screen has been fitted (see the fit callback below)
    dcc.Store(id="label-scale"),              # current size of the VAAC area names (see the clientside callback)
    dcc.Interval(id="alert-interval", interval=300000, n_intervals=0),  # 5 min refresh
], id="home-root", className="home-root")


# ── Auto-refresh options: on/off switch + interval (minutes) ──
@callback(
    Output("alert-interval", "interval"),
    Output("alert-interval", "disabled"),
    Output("refresh-status", "children"),
    Input("auto-refresh-switch", "value"),
    Input("refresh-interval", "value"),
)
def configure_auto_refresh(enabled, minutes):
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        minutes = 5
    return minutes * 60 * 1000, not enabled, (f"every {minutes} min" if enabled else "paused")


# ── Agency level descriptions beside the legend ────────────
@callback(
    Output("legend-open", "data"),
    Input({"type": "legend-chip", "code": ALL}, "n_clicks"),
    Input("volcano-map", "clickData"),
    State("legend-open", "data"),
    prevent_initial_call=True,
)
def toggle_legend_detail(_clicks, _map_click, current):
    from dash import ctx
    trig = ctx.triggered_id
    if trig == "volcano-map":                 # a click on the map folds the details away again
        return None if current else dash.no_update
    if not (isinstance(trig, dict) and ctx.triggered and ctx.triggered[0].get("value")):
        return dash.no_update
    return None if trig["code"] == current else trig["code"]      # same chip again closes it


@callback(
    Output("legend-detail", "children"),
    Output("legend-detail", "style"),
    Input("legend-open", "data"),
    Input("legend-collapse", "is_open"),
)
def render_legend_detail(code, legend_is_open):
    # The details belong to the legend: they go away while it is minimised and return when it is expanded.
    if not code or code not in LEGEND_DETAILS or legend_is_open is False:
        return [], {"display": "none"}
    return _legend_detail_content(code), {"display": "flex"}


# ── VAAC area names: size follows the zoom, so a name never runs over its area's border ──
# The names keep a fixed size in pixels, so zooming out made them wider than their areas. The size is
# now proportional to the zoom (capped at 15 px, as before), and a name that would be too small to
# read is hidden. Written to CSS variables used by .vaac-label.
dash.clientside_callback("""function(bounds) {
    const el = document.getElementById('volcano-map');
    if (!bounds || !el) { return window.dash_clientside.no_update; }
    const lonSpan = Math.abs(bounds[1][1] - bounds[0][1]) || 1;
    const pxPerDeg = el.clientWidth / lonSpan;
    const size = Math.min(15, pxPerDeg * 1.7);
    const root = document.documentElement.style;
    root.setProperty('--vaac-label-size', size.toFixed(1) + 'px');
    root.setProperty('--vaac-label-vis', size < 6.5 ? 'hidden' : 'visible');
    return size;
}""", Output("label-scale", "data"), Input("volcano-map", "bounds"))


# ── Fit the first screen ───────────────────────────────────
# dash-leaflet needs `center` / `zoom` to create the map, and applies them again on top of any `viewport` fit made
# while it is being created (a visible zoom jump). So the map is created at that fixed view, and the fit to the
# first screen is made right after - in the browser (clientside), without a server round trip - while the map is
# still invisible (see the reveal below).
# The callback runs while the map is being created, i.e. BEFORE dash-leaflet applies `zoom` / `center`, which
# would undo a fit made at that moment. It therefore answers a moment later (a Promise).
dash.clientside_callback("""function(_) {
    const b = %s;
    return new Promise(function (resolve) {
        window.setTimeout(function () {
            resolve([{bounds: b, transition: "fitBounds", options: {animate: false, padding: [0, 0]}}, true]);
        }, 120);
    });
}""" % json.dumps(INITIAL_BOUNDS),
    Output("volcano-map", "viewport", allow_duplicate=True),
    Output("fit-done", "data"),
    Input("fit-trigger", "data"),
    prevent_initial_call="initial_duplicate",
)


# The screen is built up in two steps: the base map fades in as soon as the first fit is done (its tiles then
# load in place, like on any web map); the volcano markers and bubbles (the marker and tooltip panes) fade in
# after the base map's tiles have arrived. Two callbacks, because Dash holds a callback back until all its inputs
# are final, and the markers take a second to arrive: the map must not wait for them. CSS fallbacks
# (home_layout.css) show both after 2.5 s / 3.5 s whatever happens. (dash-leaflet applies the Map's className only
# when it creates the container, so the classes `map-ready` and `markers-ready` are set on the DOM element.)
_REVEAL_STATE_JS = """
    const el = document.getElementById('volcano-map');
    if (!el) { return false; }
    let S = window.__lavaReveal;
    if (!S || S.el !== el) { S = window.__lavaReveal = {el: el}; }      // a new map after navigating back to Home
"""
dash.clientside_callback("""function(fitDone) {""" + _REVEAL_STATE_JS + """
    if (!fitDone) { return false; }
    if (!S.started) {
        S.started = true;
        window.setTimeout(function () {             // a moment for the fit to be applied before the map is shown
            el.classList.add('map-ready');
            const t0 = Date.now();
            (function waitForTiles() {
                const total = el.querySelectorAll('.leaflet-tile').length;
                const loaded = el.querySelectorAll('.leaflet-tile-loaded').length;
                if ((total > 0 && loaded >= total) || Date.now() - t0 > 1500) { S.tilesDone = true; }
                else { window.setTimeout(waitForTiles, 60); }
            })();
        }, 150);
    }
    return true;
}""", Output("map-ready-flag", "data"), Input("fit-done", "data"))

dash.clientside_callback("""function(markers) {""" + _REVEAL_STATE_JS + """
    const has = Array.isArray(markers) ? markers.length > 0 : !!markers;
    if (!has) { return false; }
    const t0 = Date.now();
    (function showWhenMapIsThere() {
        if (S.tilesDone) {
            if (!S.markersShown) {
                S.markersShown = true;
                window.setTimeout(function () { el.classList.add('markers-ready'); }, 150);
            }
        } else if (Date.now() - t0 < 4000) { window.setTimeout(showWhenMapIsThere, 60); }
    })();
    return true;
}""", Output("markers-ready-flag", "data"), Input("marker-layer", "children"))


# ── Back to the initial view ───────────────────────────────
@callback(
    Output("volcano-map", "viewport", allow_duplicate=True),
    Input("reset-view", "n_clicks"),
    prevent_initial_call=True,
)
def reset_view(_clicks):
    return dict(bounds=INITIAL_BOUNDS, transition="flyToBounds", options={"duration": 1.2})


# ── Legend collapse toggle ─────────────────────────────────
dash.clientside_callback("""function(n, isOpen) {
    if (!n) { return [window.dash_clientside.no_update, window.dash_clientside.no_update]; }
    const next = !isOpen;
    return [next, next ? '▾' : '▸'];
}""", Output("legend-collapse", "is_open"), Output("legend-toggle", "children"),
     Input("legend-toggle", "n_clicks"), State("legend-collapse", "is_open"))


# ── Side panel open / close ────────────────────────────────
@callback(
    Output("side-panel-state", "data"),
    Output("side-panel", "className"),
    Output("tab-info", "className"),
    Output("home-root", "className"),
    Input("tab-info", "n_clicks"),
    Input("side-close", "n_clicks"),
    Input({"type": "popup-more", "name": ALL}, "n_clicks"),
    Input("selected-volcano-store", "data"),
    Input("volcano-map", "clickData"),
    State("side-panel-state", "data"),
    prevent_initial_call=True,
)
def toggle_side_panel(_tab, _close, _more, selected, _map_click, state):
    from dash import ctx
    state = dict(state or {"open": False})
    trig = ctx.triggered_id
    if trig == "tab-info":
        state["open"] = not state.get("open", False)
    elif trig == "side-close":
        state["open"] = False
    elif trig == "volcano-map":               # a click on the bare map (select_volcano drops the selection and
        if not state.get("open"):             # the big bubble goes with it): the side panel folds away as well
            return (dash.no_update,) * 4
        state["open"] = False
    elif isinstance(trig, dict) and trig.get("type") == "popup-more":
        if not (ctx.triggered and ctx.triggered[0].get("value")):    # ignore re-render noise
            return (dash.no_update,) * 4
        state["open"] = True                  # the big bubble's "More details" button
    elif trig == "selected-volcano-store":
        # A selection made on the map opens a big bubble and leaves the side panel alone: it opens from the
        # bubble's button. A selection made from the panel's alert cards opens it.
        if not selected or selected.get("via") == "marker-popup":
            return (dash.no_update,) * 4
        state["open"] = True
    is_open = state["open"]
    return (
        state,
        "home-side-panel open" if is_open else "home-side-panel",
        "home-tab active" if is_open else "home-tab",
        "home-root side-open" if is_open else "home-root",
    )


# The UTC / KST clock is drawn by assets/home_clock.js, outside Dash: a callback every second made the tab title
# flicker ("Updating...") and re-checked every component of the page each time.

# ── Source refresh runs in the BACKGROUND ─────────────────
# Page loads must never wait for the network (JMA alone is a ~10 s Selenium
# scrape). A daemon thread keeps the latest source data fresh and persists it
# to disk; load_alert_data() just reads that snapshot, so even the very first
# load after a server restart is instant once a snapshot exists.
_LATEST_PATH = os.path.join(BASE_DIR, "cache", "latest_sources.json")
_LATEST = {}                         # vaac_rows, jma_raw, jma_issued, mirova_rows, fetched_at
_FIRST_DATA = threading.Event()
_REFRESH_LOCK = threading.Lock()     # one source refresh at a time
_BG = {"thread": None}
BACKGROUND_INTERVAL = 60             # seconds between background refreshes


def _load_latest_from_disk():
    try:
        with open(_LATEST_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("vaac_rows") is not None and "jma_raw" in data:
            _LATEST.update(data)
            _FIRST_DATA.set()
            print(f"[sources] restored snapshot from {data.get('fetched_at')}")
    except (OSError, ValueError):
        pass


def _save_latest():
    try:
        os.makedirs(os.path.dirname(_LATEST_PATH), exist_ok=True)
        tmp = _LATEST_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_LATEST, fh, ensure_ascii=False, default=str)
        os.replace(tmp, _LATEST_PATH)
    except OSError as exc:
        print("[sources] could not persist snapshot:", exc)


def _refresh_sources(force=False):
    """Fetch every source (in parallel), update the registry, publish _LATEST."""
    with _REFRESH_LOCK:
        t_start = time.time()
        # All remote sources are independent network calls, so fetch them
        # concurrently (total wait = slowest source, not the sum). PVMBG/KVERT
        # keep their 30-minute throttle.
        idx_for_fetch = _registry_index()
        try:
            previous_snapshot = read_alerts(_REGISTRY_DB)
        except Exception:
            previous_snapshot = {"by_number": {}, "sources": {}}
        due_collectors = {}
        for source, collector, minutes in (("PVMBG", collect_pvmbg, 30), ("KVERT", collect_kvert, 30),
                                           ("PHIVOLCS", collect_phivolcs, 30)):
            src_status = previous_snapshot.get("sources", {}).get(source, {})
            last = src_status.get("last_attempt")
            should_fetch = True
            if last:
                # after a failed attempt try again soon (5 min) instead of waiting the full interval
                wait_min = minutes if src_status.get("status") == "ok" else 5
                try:
                    should_fetch = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() >= wait_min * 60
                except (ValueError, TypeError):
                    pass
            if should_fetch:
                due_collectors[source] = collector

        pool = ThreadPoolExecutor(max_workers=6)
        try:
            f_darwin  = pool.submit(get_darwin_vaac_table)      # BoM 24-hour feed: ALL VAACs, the Home source
            f_recent  = pool.submit(get_vaac_recent_list)
            # JMA is a Selenium scrape (Chrome launch + wait): reuse it for 10 min.
            # Manual refresh shortens the window to 60 s instead of re-scraping every click.
            f_jma     = pool.submit(cached_call, "jma", get_jma_alerts, 60 if force else 600, False,
                                    lambda v: bool(v and v[0]))
            f_mirova  = pool.submit(get_mirova_alerts)
            f_sources = {src: pool.submit(col, idx_for_fetch) for src, col in due_collectors.items()}

            vaac_rows = f_darwin.result()
            (jma_raw, jma_issued), _jma_changed = f_jma.result()
            mirova_rows = f_mirova.result()
            recent_vaa = f_recent.result()

            # Slow official sources must not hold things up: wait a bounded
            # time, otherwise fall back to the last successful DB snapshot.
            source_results = {}
            for src, fut in f_sources.items():
                try:
                    source_results[src] = (fut.result(timeout=60), None)   # PVMBG may need 2 slow tries
                except Exception as exc:
                    source_results[src] = (None, exc)
        finally:
            pool.shutdown(wait=False)  # never block on a hung source

        # Persist normalized records only when JMA/VAAC/MIROVA content changed.
        reg_key = digest([jma_raw, jma_issued, vaac_rows, mirova_rows])
        try:
            if reg_key != _LAST_REGISTRY_KEY[0]:
                idx = _registry_index()
                jma_normalized, jma_unmatched = normalize_jma(idx, jma_raw, jma_issued)
                vaac_normalized, vaac_unmatched = normalize_vaac(idx, vaac_rows)
                upsert_alerts(_REGISTRY_DB, "JMA", jma_normalized)
                upsert_alerts(_REGISTRY_DB, "VAAC", vaac_normalized)
                mirova_events = []
                for r in mirova_rows:
                    num = idx.resolve(name=r.get("our_name") or r.get("volcano"))
                    if num is None:
                        continue
                    vrp_txt = str(r.get("vrp_mw", "")).replace(",", "")
                    mirova_events.append({
                        "volcano_number": num, "source": "MIROVA", "kind": "thermal",
                        "label": f"MIROVA {vrp_txt} MW", "level": vrp_txt,
                        "event_time": r.get("time"), "detail": r.get("sensor") or None, "url": MIROVA_URL})
                record_events(_REGISTRY_DB, mirova_events)
                _LAST_REGISTRY_KEY[0] = reg_key
                print(f"[registry] JMA/VAAC saved: {len(jma_normalized)} JMA, {len(vaac_normalized)} VAAC records")
                if jma_unmatched or vaac_unmatched:
                    print("[registry] unmatched JMA:", jma_unmatched[:30],
                          "VAAC:", vaac_unmatched[:30])
        except Exception as registry_error:
            print("[registry] update failed:", registry_error)
        # Tokyo's issued-advisory list -> alert history (the front page only lists
        # advisories active right now, so past ones would otherwise never be stored).
        try:
            recent_key = digest(recent_vaa)
            if recent_vaa and recent_key != _LAST_RECENT_KEY[0]:
                idx = _registry_index()
                alerts, unresolved = normalize_vaac(idx, recent_vaa)
                events = []
                for a in alerts:
                    row = a["raw"]
                    events.append({
                        "volcano_number": a["volcano_number"], "source": row.get("source") or "Tokyo VAAC",
                        "kind": "vaa", "label": f"{row.get('source') or 'Tokyo VAAC'} VAA {row.get('advisory') or ''}".strip(),
                        "level": "ACTIVE", "event_time": a["issued_at"],
                        "detail": row.get("area") or None, "url": a.get("source_url")})
                record_events(_REGISTRY_DB, events)
                _LAST_RECENT_KEY[0] = recent_key
                print(f"[registry] Tokyo VAA history: {len(events)} advisories"
                      + (f", unmatched {sorted(set(unresolved))[:10]}" if unresolved else ""))
        except Exception as exc:
            print("[registry] VAA history update failed:", exc)
        # A failed source never clears its last successful DB snapshot.
        try:
            for source, (items, exc) in source_results.items():
                if exc is None:
                    upsert_alerts(_REGISTRY_DB, source, items)
                    print(f"[registry] {source}: {len(items)} matched alerts")
                else:
                    upsert_alerts(_REGISTRY_DB, source, [], success=False, error=str(exc)[:350])
                    print(f"[registry] {source} unavailable: {exc}")
        except Exception as exc:
            print("[registry] source refresh error:", exc)

        _LATEST.update(vaac_rows=vaac_rows, jma_raw=jma_raw, jma_issued=jma_issued,
                       mirova_rows=mirova_rows,
                       fetched_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"))
        _save_latest()
        _FIRST_DATA.set()
        print(f"[sources] refreshed in {time.time() - t_start:.1f}s ({'manual' if force else 'background'})")


def _background_loop():
    while True:
        try:
            _refresh_sources()
        except Exception as exc:
            print("[sources] background refresh failed:", exc)
        time.sleep(BACKGROUND_INTERVAL)


def _ensure_background():
    """Start the refresher once, in the process that actually serves pages."""
    t = _BG["thread"]
    if t is None or not t.is_alive():
        _BG["thread"] = threading.Thread(target=_background_loop, name="source-refresher", daemon=True)
        _BG["thread"].start()


_load_latest_from_disk()


# ── Callback: Load alert data ──────────────────────────────
@callback(
    Output("alert-store", "data"),
    Output("last-check", "children"),
    Input("alert-interval", "n_intervals"),
    Input("refresh-now", "n_clicks"),
    State("alert-store", "data"),
)
def load_alert_data(n, _refresh_clicks, current):
    """Compose the page payload from the latest source snapshot (no network).

    Only changed data is pushed to the page. The manual Refresh button asks the
    background refresher for a fresh pull and waits at most 4 s for it."""
    from dash import ctx
    force = ctx.triggered_id == "refresh-now"
    t_start = time.time()
    try:
        _ensure_background()
        if force:
            worker = threading.Thread(target=_refresh_sources, kwargs={"force": True}, daemon=True)
            worker.start()
            worker.join(timeout=4)
        if not _LATEST:                       # cold start, nothing persisted yet
            _FIRST_DATA.wait(timeout=45)
        latest = dict(_LATEST)
        vaac_rows = latest.get("vaac_rows", [])
        jma_raw, jma_issued = latest.get("jma_raw", {}), latest.get("jma_issued", {})
        mirova_rows = latest.get("mirova_rows", [])
        try:
            registry_snapshot = read_alerts(_REGISTRY_DB)
        except Exception as exc:
            print("[registry] read failed:", exc)
            registry_snapshot = {"by_number": {}, "sources": {}}
        payload = {
            "registry": registry_snapshot,
            "vaac_active":    list({r["volcano"].upper() for r in vaac_rows}),
            "vaac_rows":      vaac_rows,
            # changes every 30 min, so the page re-evaluates the 24 h window even if no source changed
            "vaa_bucket":     datetime.now(timezone.utc).strftime("%Y%m%d%H") + ("a" if datetime.now(timezone.utc).minute < 30 else "b"),
            "jma_alerts":     get_jma_alert_for_target(jma_raw),
            "jma_raw":        jma_raw,
            "jma_raw_full":   jma_raw,  # full raw data
            "jma_issued":     jma_issued,
            "mirova_all":     [],
            "mirova_target":  [],
            "mirova_rows":    mirova_rows,
            "timestamp":      str(latest.get("fetched_at") or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))[:16] + " UTC",
        }
        # Compare everything except volatile bookkeeping (timestamps, fetch attempts).
        sources_state = (registry_snapshot or {}).get("sources", {}) or {}
        sig = digest({
            **{k: v for k, v in payload.items() if k not in ("timestamp", "registry")},
            "by_number": (registry_snapshot or {}).get("by_number", {}),
            "source_status": {k: (v or {}).get("status") for k, v in sources_state.items()},
        })
        checked = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")
        unchanged = bool(current and current.get("sig") == sig)
        print(f"[alert load] {time.time() - t_start:.1f}s ({'manual' if force else 'auto'}), "
              f"{'unchanged' if unchanged else 'changed'}")
        # Compare against what THIS browser tab already holds (not a server
        # global), so a freshly opened/reloaded tab always receives the data.
        if unchanged:
            return dash.no_update, f"checked {checked} · no changes"
        payload["sig"] = sig
        return payload, f"checked {checked} · " + ("updated" if current else "loaded")
    except Exception as e:
        print(f"[alert store] {e}")
        return (dash.no_update if current else {}), "check failed"


# ── Callback: Build map markers ────────────────────────────
@callback(
    Output("marker-layer", "children"),
    Input("alert-store", "data"),
)
def update_markers(alert_data):
    # Initial call (alert-store still empty) draws every volcano from the
    # master list right away; alert styling is applied once the data arrives.
    return build_map_markers(alert_data or {})


def _volcano_status_panel(name, alert_data, latest_vaa=None, max_vaa=4):
    """Coordinates + current alert status block for one volcano."""
    is_target = name in VOLCANOES

    # Get coordinates from master
    target_info = get_target_info()
    df_all = load_volcano_master()

    if is_target:
        info = target_info.get(name, {})
        lat  = info.get("lat", "N/A")
        lon  = info.get("lon", "N/A")
        elev = info.get("elev", "N/A")
    else:
        xlsx_name = "Aira" if name == "Sakurajima" else name
        row = df_all[df_all["volcano_name"].str.contains(xlsx_name, case=False, na=False)]
        if not row.empty:
            lat  = float(row.iloc[0]["latitude"])
            lon  = float(row.iloc[0]["longitude"])
            elev = float(row.iloc[0]["elevation"])
        else:
            lat = lon = elev = "N/A"

    vaa_status = _vaa_status(alert_data, name)
    level, vaa, vrp = _alert_for_volcano(name, alert_data, vaa_status)
    ended_vaa = vaa_status["ended"]
    colors = {2:"#A88B00",3:"#E07800",4:"#E02020",5:"#B000B0"}
    mirova_row = _mirova_for(name, alert_data)
    def status_line(title, main, sub, color="#1a3a5c"):
        return html.Div([
            html.Div([html.Span(title,style={"fontWeight":"700","minWidth":"82px","display":"inline-block"}),
                      html.Span(main,style={"color":color,"fontWeight":"700"})],style={"fontSize":"17px"}),
            html.Div(sub,style={"fontSize":"14px","color":"#667085","paddingLeft":"82px","marginTop":"3px","overflowWrap":"anywhere"}),
        ],style={"padding":"8px 0","borderBottom":"1px solid #e6e9ed"})
    official = _official_alert(name, alert_data)
    official_line = status_line("Official", _official_line(official),
                "Issued: " + _time_label(official.get("issued_at")) if official else "Source not available",
                _official_color(official) if official else "#667085")
    jma_line = status_line("JMA",f"Level {level}" if level else "No level 2–5 alert",
                           "Issued: "+_jma_issued(name, alert_data) if level else "",colors.get(level,"#667085"))
    if mirova_row and vrp is not None:
        mirova_line = status_line("MIROVA",f"{vrp:g} MW",
                "Observed: "+str(mirova_row.get("time") or "Time unavailable")+
                (" · "+str(mirova_row.get("sensor")) if mirova_row.get("sensor") else ""),
                _mirova_style(vrp) or "#667085")
    else:
        mirova_line = status_line("MIROVA","No recent thermal alert","", "#667085")
    vaa_lines = []
    for r in sorted(vaa, key=_vaa_sort_key, reverse=True)[:max_vaa]:
        vaa_lines.append(html.Div([
            html.Div(str(r.get("source") or "VAAC")+" · "+str(r.get("advisory") or "Advisory"),
                     style={"fontWeight":"700","color":"#b42318","fontSize":"16px"}),
            html.Div("Issued: "+_time_label(r.get("datetime")),style={"fontSize":"14px","color":"#667085"}),
            html.Div(str(r.get("eruption") or r.get("eruption_details") or ""),style={"fontSize":"14px","overflowWrap":"anywhere"}),
            html.A("View advisory",href=r["detail_url"],target="_blank",style={"fontSize":"14px"}) if r.get("detail_url") else html.Span(),
        ],style={"padding":"7px 0","borderBottom":"1px solid #e6e9ed"}))
    if not vaa_lines and ended_vaa:
        r = ended_vaa
        vaa_lines.append(html.Div([
            html.Div(str(r.get("source") or "VAAC")+" · "+str(r.get("advisory") or "Advisory"),
                     style={"fontWeight":"700","color":"#667085","fontSize":"16px"}),
            html.Div("Issued: "+_time_label(r.get("datetime"))+" · final (no further advisories)",
                     style={"fontSize":"14px","color":"#667085"}),
            html.Div(str(r.get("eruption") or r.get("eruption_details") or ""),style={"fontSize":"14px","overflowWrap":"anywhere"}),
            html.A("View advisory",href=r["detail_url"],target="_blank",style={"fontSize":"14px"}) if r.get("detail_url") else html.Span(),
        ],style={"padding":"7px 0","borderBottom":"1px solid #e6e9ed"}))
    panel = html.Div([
        html.Div(name, className="status-title",
                 style={"fontSize":"26px","fontWeight":"800","color":"#1a3a5c","marginBottom":"5px"}),
        html.Div(f"{lat}° N  ·  {lon}° E  ·  {elev} m",style={"fontSize":"15px","color":"#667085","marginBottom":"16px"}),
        html.Div([
            html.Div("Alert Status",style={"fontSize":"19px","fontWeight":"700","marginBottom":"5px"}),
            official_line,mirova_line,
            html.Div([html.Div("VAA",style={"fontSize":"17px","fontWeight":"700","marginBottom":"4px"}),
                      *(vaa_lines if vaa_lines else [html.Div(
                          ["No advisory active now",
                           html.Div(f"Latest: {latest_vaa.get('label')} · {_time_label(latest_vaa.get('event_time'))}",
                                    style={"fontSize":"14px","color":"#b42318","marginTop":"3px"})
                           if latest_vaa else html.Span()],
                          style={"color":"#667085","fontSize":"15px"})])],
                     style={"padding":"9px 0"}),
        ],style={"paddingLeft":"12px","borderLeft":"3px solid #d6e0ea"}),
    ])
    return panel


# ── Unified side panel ─────────────────────────────────────
# Volcano selected  -> volcano info + its alerts of the last 30 days.
# Nothing selected  -> active alerts of all volcanoes for the last 7 days.
WINDOW_SELECTED_DAYS = 30
WINDOW_ALL_DAYS = 7


@callback(
    Output("selected-volcano-store", "data"),
    Input({"type": "map-marker", "name": ALL}, "n_clicks"),
    Input({"type": "alert-card", "number": ALL, "name": ALL}, "n_clicks"),
    Input("clear-selection", "n_clicks"),
    Input("reset-view", "n_clicks"),
    Input("volcano-map", "clickData"),
    State("alert-store", "data"),
    prevent_initial_call=True,
)
def select_volcano(_marker_clicks, _card_clicks, _clear, _reset, _map_click, alert_data):
    from dash import ctx
    trig = ctx.triggered_id
    # reset button and a click on the bare map (not on a volcano) both drop the selection
    if trig in ("clear-selection", "reset-view", "volcano-map"):
        return None
    if isinstance(trig, dict) and trig.get("type") == "alert-card":
        if ctx.triggered and ctx.triggered[0].get("value"):   # ignore re-render noise
            return {"name": trig["name"], "number": int(trig["number"]), "via": "card"}
        return dash.no_update
    if isinstance(trig, dict) and ctx.triggered and ctx.triggered[0].get("value"):
        name = trig["name"]
        df = load_volcano_master()
        xlsx_name = "Aira" if name == "Sakurajima" else name
        row = df[df["volcano_name"] == xlsx_name]
        if row.empty:
            row = df[df["volcano_name"].str.contains(xlsx_name, case=False, na=False, regex=False)]
        number = int(row.iloc[0]["volcano_number"]) if not row.empty else None
        # Every volcano answers a click with its big bubble ("marker-popup"): the marker's own for a volcano
        # with a VAAC advisory, the one from show_selected_callout() for all others. The side panel opens
        # from the bubble's button.
        return {"name": name, "number": number, "via": "marker-popup"}
    return dash.no_update


@callback(
    Output("area-store", "data"),
    Input("volcano-map", "bounds"),
    State("area-store", "data"),
)
def remember_view_area(bounds, current):
    """VAAC area under the centre of the map view; follows every pan and zoom. Only written when it
    changes, so moving inside one area does not redraw the area layers."""
    if not bounds:
        return dash.no_update
    (south, west), (north, east) = bounds
    import math
    # the middle of the screen is the middle in Web-Mercator, not the plain mean of the two latitudes
    def merc(la):
        return math.log(math.tan(math.pi / 4 + math.radians(max(-85.0, min(85.0, la))) / 2))
    lat = math.degrees(2 * math.atan(math.exp((merc(south) + merc(north)) / 2)) - math.pi / 2)
    lon = ((west + east) / 2 + 180) % 360 - 180       # the map can be scrolled around the globe
    area = _vaac_area_for(lat, lon)
    if (current or {}).get("area") == area and current is not None:
        return dash.no_update
    return {"area": area}


@callback(
    Output("vaac-region-layer", "children"),
    Output("mini-vaac-layer", "children"),
    Output("selected-info", "children"),
    Input("selected-volcano-store", "data"),
    Input("area-store", "data"),
)
def highlight_vaac_region(selected, clicked):
    """Red area + the chip at the top. A selected volcano wins (chip: volcano and its area);
    without a selection the area under the centre of the current view is shown ("You are in")."""
    area = None
    number = (selected or {}).get("number")
    if number is not None:
        df = load_volcano_master()
        row = df[df["volcano_number"] == number]
        if not row.empty:
            area = _vaac_area_for(float(row.iloc[0]["latitude"]), float(row.iloc[0]["longitude"]))
    elif not selected:
        area = (clicked or {}).get("area")
    chip = []
    if selected and selected.get("name"):
        # Stays on screen at every zoom level, so the selected volcano and its VAAC area are always known
        chip = [html.Span("Selected", className="chip-label"),
                html.Span(selected["name"], className="chip-name"),
                html.Span(f"{area} VAAC area" if area else "outside the VAAC areas", className="chip-area")]
    elif area:
        chip = [html.Span("You are in", className="chip-label"),
                html.Span(f"{area} VAAC area", className="chip-area")]
    return _vaac_region_polygons(highlight=area), _vaac_region_polygons(highlight=area, mini=True), chip


# Selecting a volcano never changes the zoom: the map only slides so that the volcano sits a little below the
# centre (room for its big bubble above it).
POPUP_ROOM_PX = 410    # height of the big bubble (~370 px) plus its arrow, from the top of the map down to the triangle


# Capture the map's real pixel width at the moment of selection (ordering is guaranteed
# because fly_to_selected listens to this callback's output, not to the store directly).
dash.clientside_callback("""function(selected) {
    const el = document.getElementById('volcano-map');
    return {selected: selected, width: el ? el.clientWidth : null, height: el ? el.clientHeight : null, t: Date.now()};
}""", Output("selection-ctx", "data"), Input("selected-volcano-store", "data"))


@callback(
    Output("volcano-map", "viewport", allow_duplicate=True),
    Input("selection-ctx", "data"),
    State("volcano-map", "bounds"),
    prevent_initial_call=True,
)
def fly_to_selected(ctx_data, bounds):
    """Slide the map to the selected volcano WITHOUT changing the zoom."""
    import math
    selected = (ctx_data or {}).get("selected") or {}
    number = selected.get("number")
    if number is None:
        return dash.no_update
    df = load_volcano_master()
    row = df[df["volcano_number"] == number]
    if row.empty:
        return dash.no_update
    # Current zoom from the visible longitude span and the map's real pixel width. It is only used to place the
    # volcano below the centre; the zoom itself is left alone (transition "panTo" takes the centre only).
    width = (ctx_data or {}).get("width") or 1200
    zoom_now = 5.0
    if bounds:
        span = abs(bounds[1][1] - bounds[0][1])
        if span > 0:
            zoom_now = math.log2(360.0 * width / (256.0 * span))
    lat, lon = float(row.iloc[0]["latitude"]), float(row.iloc[0]["longitude"])
    # Land the volcano BELOW the centre, so that its big bubble (which opens upwards, ~370 px high) fits above it:
    # 15 % of the map height below the centre on a tall map, more on a low one (at most 38 %).
    height = (ctx_data or {}).get("height") or 700
    below = max(0.15, min(0.38, POPUP_ROOM_PX / height - 0.5))
    deg_per_px = 360.0 / (256.0 * 2 ** zoom_now) * math.cos(math.radians(lat))
    return dict(center=[min(84.0, lat + below * height * deg_per_px), lon], zoom=zoom_now,
                transition="panTo", options={"duration": 0.8})


_CALLOUT_RING = ("data:image/svg+xml;charset=utf-8," + urllib.parse.quote(
    "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'>"
    "<circle cx='20' cy='20' r='16' fill='none' stroke='#ff3b30' stroke-width='3'/></svg>"))


@callback(
    Output("selected-marker-layer", "children"),
    Input("selected-volcano-store", "data"),
    State("alert-store", "data"),
)
def show_selected_callout(selected, alert_data):
    """Ring + name bubble above the triangle of the selected volcano. A volcano without a VAAC bubble that was
    picked on the map also gets its big bubble here (the same one a VAAC volcano has on its marker)."""
    number = (selected or {}).get("number")
    if number is None:
        return []
    # A volcano with a VAAC advisory in the last 24 h already has its small bubble (name + advisory time)
    # above the triangle: it gets only the red ring, no second name bubble. Any other volcano gets its name
    # right on top of the ring.
    try:
        _st = _vaa_status(alert_data or {}, selected.get("name") or "")
        has_small_bubble = bool(_st["current"]) or _st["ended"] is not None
    except Exception:
        has_small_bubble = False
    row = load_volcano_master()
    row = row[row["volcano_number"] == number]
    if row.empty:
        return []
    pos = [float(row.iloc[0]["latitude"]), float(row.iloc[0]["longitude"])]
    layers = []
    if not has_small_bubble and selected.get("via") == "marker-popup":
        # new id on every pick: a popup the user closed opens again when the same volcano is clicked again
        layers.append(dl.Popup([_volcano_status_panel(selected["name"], alert_data or {}, max_vaa=1),
                                *_popup_buttons(selected["name"])],
                               id=f"callout-popup-{number}-{int(time.time() * 1000)}", position=pos,
                               offset=[0, -30], className="vaa-popup", maxWidth=340, minWidth=300, autoPan=False))
    return layers + [dl.Marker(
        id=f"callout-{number}",
        position=pos,
        # Ring centred ~10 px above the point (the triangle sits on its coordinate).
        icon=dict(iconUrl=_CALLOUT_RING, iconSize=[40, 40], iconAnchor=[20, 30], tooltipAnchor=[0, -32],
                  className="selected-ring"),
        interactive=False, keyboard=False, zIndexOffset=2_000_000,
        children=([] if has_small_bubble else
                  dl.Tooltip(selected.get("name") or "", permanent=True, direction="top",
                             className="selected-bubble", offset=[0, 6])),
    )]


def _dedupe_events(events):
    """One row per (volcano, source, kind, minute): the live table and the issued list
    both report the same VAA; keep the more specific label (with advisory number)."""
    best = {}
    for e in events:
        key = (e.get("volcano_number"), e.get("source"), e.get("kind"), str(e.get("event_time"))[:16])
        if key not in best or len(str(e.get("label"))) > len(str(best[key].get("label"))):
            best[key] = e
    return sorted(best.values(), key=lambda e: str(e.get("event_time")), reverse=True)


def _events_since(days, volcano_number=None):
    from datetime import timedelta
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
    try:
        return _dedupe_events(read_events(_REGISTRY_DB, since, volcano_number))
    except Exception as exc:
        print("[events] read failed:", exc)
        return []


def _event_color(e):
    source, level = e.get("source") or "", str(e.get("level") or "")
    if level in OFFICIAL_COLORS.get(source, {}):
        return OFFICIAL_COLORS[source][level]
    if e.get("kind") == "vaa" or "VAA" in source:
        return "#b42318"
    if source == "MIROVA":
        return _mirova_style(level) or "#667085"
    return "#667085"


def _event_row(e):
    color = _event_color(e)
    detail = str(e.get("detail") or "").strip()
    url = str(e.get("url") or "")
    return html.Div([
        html.Div([html.Span(e.get("label") or e.get("source"), style={"fontWeight": "700", "color": color}),
                  html.Span(" · " + _time_label(e.get("event_time")), style={"color": "#667085", "fontSize": "13px"})]),
        html.Div(detail[:180] + ("…" if len(detail) > 180 else ""),
                 style={"fontSize": "13px", "overflowWrap": "anywhere"}) if detail else html.Span(),
        html.A("View", href=url, target="_blank", style={"fontSize": "13px"}) if url.startswith("http") else html.Span(),
    ], style={"padding": "6px 8px 6px 10px", "borderLeft": f"4px solid {color}",
              "marginBottom": "5px", "backgroundColor": "#fff"})


def _selected_events(number):
    events = _events_since(WINDOW_SELECTED_DAYS, number)
    if number is not None:
        # Month-long VAA history straight from the advisory DB (cached 5 min).
        try:
            db_rows, _ = cached_call(f"vaa-history-{number}",
                                     lambda: get_vaa_history(number, WINDOW_SELECTED_DAYS), 300)
        except Exception:
            db_rows = []
        have = {str(e["event_time"])[:16] for e in events if e.get("kind") == "vaa"}
        for r in db_rows:
            if str(r["event_time"])[:16] not in have:
                events.append({"source": "VAA DB", "kind": "vaa", "label": "VAA (database)",
                               "level": None, "event_time": r["event_time"], "detail": r["detail"], "url": None})
        events.sort(key=lambda e: str(e.get("event_time")), reverse=True)
    return events


def _volcano_section(selected, data):
    name, number = selected.get("name"), selected.get("number")
    events = _selected_events(number)
    return html.Div([
        _volcano_status_panel(name, data, next((e for e in events if e.get("kind") == "vaa"), None)),
        html.Div([
            html.Div(f"Recent alerts · last {WINDOW_SELECTED_DAYS} days ({len(events)})",
                     style={"fontSize": "17px", "fontWeight": "700", "margin": "16px 0 6px"}),
            *([_event_row(e) for e in events[:60]] or
              [html.Div("No alerts recorded in this period.", style={"color": "#667085"})]),
        ]),
    ])


def _all_alerts_section():
    events = _events_since(WINDOW_ALL_DAYS)
    names = {}
    df = load_volcano_master()
    for r in df.itertuples(index=False):
        names[int(r.volcano_number)] = "Sakurajima" if str(r.volcano_name) == "Aira" else str(r.volcano_name)
    groups = {}
    for e in events:
        src, lvl = e.get("source"), str(e.get("level") or "")
        if (src == "PVMBG" and lvl == "1") or (src == "KVERT" and lvl == "GREEN") or (src == "PHIVOLCS" and lvl == "0"):
            continue                      # normal status is not an active alert
        groups.setdefault(int(e["volcano_number"]), []).append(e)
    cards = []
    for number, items in sorted(groups.items(), key=lambda kv: str(kv[1][0]["event_time"]), reverse=True)[:100]:
        color = _event_color(items[0])
        cards.append(html.Div([
            html.Div(names.get(number, f"Volcano {number}"),
                     style={"fontSize": "18px", "fontWeight": "800", "color": color}),
            *[_event_row(e) for e in items[:3]],
            html.Div(f"+{len(items) - 3} more", style={"fontSize": "12px", "color": "#667085"}) if len(items) > 3 else html.Span(),
        ], id={"type": "alert-card", "number": number, "name": names.get(number, f"Volcano {number}")},
            n_clicks=0, className="home-alert-card", title="Click to select this volcano",
            style={"padding": "10px 8px", "borderBottom": "1px solid #dce3e9", "backgroundColor": "#f4f7f9",
                   "marginBottom": "6px"}))
    return cards, len(groups)


@callback(
    Output("side-body", "children"),
    Output("side-title", "children"),
    Output("alert-count-badge", "children"),
    Output("clear-selection", "style"),
    Input("alert-store", "data"),
    Input("selected-volcano-store", "data"),
)
def render_side_panel(data, selected):
    data = data or {}
    cards, count = _all_alerts_section()          # always keeps the tab badge current
    source_states = (data.get("registry") or {}).get("sources", {})
    source_note = " · ".join(f"{n}: {source_states.get(n, {}).get('status', 'not collected')}"
                             for n in ("JMA", "PVMBG", "PHIVOLCS", "KVERT"))
    footer = html.Div(["Last refresh: " + str(data.get("timestamp", "N/A")) + " | " + source_note,
                       html.Div("History is recorded from the first run; levels issued before the window are not listed.",
                                style={"marginTop": "3px"})],
                      style={"fontSize": "12px", "color": "#666", "marginTop": "14px"})
    if selected and selected.get("name"):
        body = html.Div([_volcano_section(selected, data), footer])
        return body, selected["name"], str(count), {"display": "inline-block"}
    body = html.Div([
        *(cards or [html.Div(f"No alerts in the last {WINDOW_ALL_DAYS} days.", style={"color": "#667085"})]),
        footer,
    ])
    return body, f"Active Alerts · last {WINDOW_ALL_DAYS} days", str(count), {"display": "none"}


def _merc(lat):
    """Latitude to the vertical coordinate of the Web Mercator map (radians)."""
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def _unmerc(y):
    return math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)


@callback(
    Output("mini-map", "viewport"),
    Output("minimap-bounds-rect", "bounds"),
    Input("volcano-map", "bounds"),
)
def sync_minimap(bounds):
    """Keep the minimap an overview of the main map: same centre, showing ~3x the
    main view, so zooming the main map out/in zooms the minimap out/in too.

    Uses fitBounds rather than a zoom number: dash-leaflet ignores a viewport zoom
    of 0 (falsy), which would stop the minimap from ever zooming out fully."""
    if not bounds:
        return dash.no_update, [[20, 120], [50, 150]]
    # bounds format from dash_leaflet: [[south, west], [north, east]]
    south, west = bounds[0]
    north, east = bounds[1]
    c_lon = (west + east) / 2
    half_w = max(east - west, 0.01) * 1.5
    # The vertical centre is taken on the Mercator scale the map is drawn in (and the view is kept symmetric
    # around it, within the +-85 degrees the map covers): with the plain middle latitude, and a view cut off at
    # 85 degrees on one side only, the red rectangle sat above the centre of the minimap.
    m_south, m_north = _merc(max(south, -84.0)), _merc(min(north, 84.0))
    m_mid = (m_south + m_north) / 2
    m_half = min(max(m_north - m_south, 0.01) * 1.5, _merc(85.0) - abs(m_mid))
    view = [[_unmerc(m_mid - m_half), c_lon - half_w], [_unmerc(m_mid + m_half), c_lon + half_w]]
    viewport = {"bounds": view, "transition": "fitBounds", "options": {"animate": False}}
    return viewport, [[south, west], [north, east]]