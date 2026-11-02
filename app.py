# Review copy: only the Home page (the other menus are shown greyed out and cannot be opened).
# Start:  python app.py  ->  http://127.0.0.1:8050
import dash
from dash import Dash, html, dcc, callback, Output, Input, ALL
import dash_bootstrap_components as dbc
import os

# ── Which pages are served ─────────────────────────────────
# LAVA_PAGES unset (development, python app.py): every page.
# LAVA_PAGES=Home or Home,About ... (public service, see run_service.bat): only the listed pages. The other menu
# entries stay visible but greyed out and cannot be opened. Their files are not even loaded, so their addresses
# (/seismic, /pmcc ...) answer "page not found" and their callbacks do not exist on the server - greying a menu
# out would not stop anyone who types the address or calls the callbacks directly.
# To open another page later, add its menu name to LAVA_PAGES.
PAGE_MODULES = {"Home": "home", "About": "about", "Ash": "ash", "Data": "data", "Seismic": "seismic",
                "PMCC": "pmcc", "Infrasound": "infrasound"}          # menu name -> pages/<module>.py ("Report" has none yet)
_pages_env = os.getenv("LAVA_PAGES", "Home")      # review copy: Home only unless told otherwise
ENABLED_PAGES = None if _pages_env is None else {p.strip() for p in _pages_env.split(",") if p.strip()}
RESTRICTED = ENABLED_PAGES is not None


def page_enabled(item):
    return ENABLED_PAGES is None or item in ENABLED_PAGES


# ── Navigation menu ────────────────────────────────────────
NAV_ITEMS = ["Home", "About", "Ash", "Data", "Seismic", "PMCC", "Infrasound", "Report"]
# Menus listed here are hidden from the top bar only; their pages/ files stay in place
# (reachable by URL), so a menu comes back by removing its name from this set.
HIDDEN_MENUS = set()   # e.g. {"Data"} to hide a menu temporarily

# ── App initialization ─────────────────────────────────────
app = Dash(__name__, use_pages=True, suppress_callback_exceptions=True,
           pages_folder="" if RESTRICTED else "pages",    # "" = do not load every file of pages/
           external_stylesheets=[dbc.themes.BOOTSTRAP],
           update_title=None)    # keep the tab title as it is while callbacks run (no "Updating..." flicker)
if RESTRICTED:
    import importlib
    import sys
    from flask import request
    for _name in sorted(ENABLED_PAGES):
        if _name not in PAGE_MODULES:
            raise SystemExit(f"LAVA_PAGES: unknown page '{_name}' (known: {', '.join(PAGE_MODULES)})")
        importlib.import_module("pages." + PAGE_MODULES[_name])       # registers the page; needs the app to exist
    for _page in dash.page_registry.values():                          # what Dash does itself for pages/ files
        if "layout" not in _page:
            _page["layout"] = getattr(sys.modules[_page["module"]], "layout")
    print("[LAVA] pages served: " + ", ".join(sorted(ENABLED_PAGES)) + " (the other menus are locked)")

    _INTERNAL = ("/_dash-", "/_favicon", "/_reload-hash", "/assets/")

    @app.server.before_request
    def _only_enabled_pages():
        path = request.path
        if path.startswith(_INTERNAL) or path in {p["path"] for p in dash.page_registry.values()}:
            return None
        return ("404 - Page not found", 404)

# ── Layout ─────────────────────────────────────────────────
app.layout = html.Div([
    dcc.Location(id="url"),

    # ① Hero section with background video
    html.Div([

        html.Div([
            # Logo + videos side by side
            html.Div([
                # Logo
                dcc.Link([
                    html.Div("L.A.V.A.", style={"fontSize": "22px", "fontWeight": "bold"}),
                    html.Div("Live Acoustic & Seismic Volcano Archive",
                             style={"fontSize": "11px", "opacity": "0.8"})
                ], href="/", style={"color": "white", "textDecoration": "none",
                                    "marginRight": "16px"}),

                # Video thumbnails area
                html.Div(id="hero-videos", children=[
                    # html.Video(
                    #     src="/assets/HVO1.mp4",
                    #     id="hero-video",
                    #     autoPlay=True, loop=True, muted=True,
                    #     style={"height": "240px", "width": "360px",
                    #            "objectFit": "cover", "borderRadius": "4px",
                    #            "marginRight": "8px",
                    #            "border": "1px solid rgba(255,255,255,0.3)"}
                    # ),
                    # Add more videos here later:
                    # html.Video(src="/assets/HVO2.mp4", ...),
                ], style={"display": "flex", "alignItems": "center"}),

            ], style={"display": "flex", "alignItems": "center"}),

            # Navigation menu
            html.Div([
                (dcc.Link(item, href="/" if item == "Home" else f"/{item.lower()}",
                          style={
                              "color": "white", "padding": "6px 12px",
                              "cursor": "pointer", "fontSize": "13px",
                              "borderRadius": "4px",
                              "textDecoration": "none"
                          })
                 if page_enabled(item) else
                 # locked: visible, but not a link
                 html.Span(item, title="Coming soon",
                           style={"color": "rgba(255,255,255,0.35)", "padding": "6px 12px",
                                  "cursor": "not-allowed", "fontSize": "13px", "userSelect": "none"}))
                for item in NAV_ITEMS if item not in HIDDEN_MENUS
            ], style={"display": "flex", "gap": "4px"}),

        ], style={"position": "relative", "zIndex": 1,
                  "display": "flex", "justifyContent": "space-between",
                  "alignItems": "center", "padding": "12px 32px",
                  "color": "white",
                  "background": "rgba(0,0,0,0.5)",
                  "height": "100%"}),

        html.Div(id="hero-title", style={"display": "none"}),

    ], id="hero-section", style={"position": "fixed", "top": 0, "left": 0,
          "width": "100%", "height": "80px", "zIndex": 9999,
          "background": "#1a3a5c", "overflow": "hidden"}),

    # Page content area
    html.Div(dash.page_container, style={"marginTop": "80px"})

], style={"fontFamily": "Arial, sans-serif", "margin": 0})

# ── Callback: Hide video on non-home pages ─────────────────
@callback(
    Output("hero-videos", "style"),
    Input("url", "pathname"),
    prevent_initial_call=False,
)
def update_hero(pathname):
    if pathname == "/" or pathname is None:
        # Home: show videos
        return {"display": "flex", "alignItems": "center"}
    else:
        # Other pages: hide videos
        return {"display": "none"}

if __name__ == "__main__":
    # Two ways to start (see docs/서비스_운영_안내.md):
    #   python app.py                    development: this PC only (127.0.0.1), reloads when a file is saved.
    #   LAVA_SERVICE=1 python app.py     service for the institute network: all interfaces (0.0.0.0), no debug
    #                                    mode (no debugger console, fast production JS bundles, no reload polling).
    # LAVA_HOST / LAVA_PORT override the address and port in either mode.
    # LAVA_PAGES=Home serves only the listed pages and locks the other menus (see "Which pages are served").
    service = os.getenv("LAVA_SERVICE", "0") == "1"
    host = os.getenv("LAVA_HOST", "0.0.0.0" if service else "127.0.0.1")
    port = int(os.getenv("LAVA_PORT", "8050"))
    if service:
        app.run(host=host, port=port, debug=False)
    else:
        # dev_tools_ui=False hides the debug toolbar at the bottom right; the production JS bundles are served
        # (the development bundles made every callback much slower); the browser asks the server whether a file
        # changed (/_reload-hash) every 10 s instead of every 3 s. dev_tools_hot_reload=False turns reloading off.
        app.run(host=host, port=port, debug=True, dev_tools_ui=False,
                dev_tools_serve_dev_bundles=False, dev_tools_hot_reload_interval=10)
