"""Generates src/lib/__fixtures__/python-reference.json: what the ORIGINAL Python code (pages/home.py) decides for the
saved source snapshot (cache/latest_sources.json + cache/volcano_alerts.sqlite3), with "now" frozen at the snapshot time.

The TypeScript port is checked against it by src/lib/alertLogic.test.ts, so a difference in behaviour shows up as a
failing test instead of a visual surprise.

    python web/scripts/gen-python-reference.py

It runs the real Python functions (extracted from pages/home.py with `ast`, so the Dash / dash-leaflet imports are not
needed). Needs only pandas. The master list is read from src/data/volcanoes.json (same data as the xlsx).
"""
import ast
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import pandas as pd

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(os.path.dirname(WEB), "original_python")   # the Python app as it was before the conversion
if not os.path.isdir(ROOT):
    sys.exit(
        f"The original Python app was not found at {ROOT}\n"
        "It is not kept in the GitHub repository (see web/README.md); restore it from the git history first:\n"
        "    git checkout 60a30d4 -- original_python\n"
        "(npm test does not need it: the reference values are committed in src/lib/__fixtures__.)"
    )
sys.path.insert(0, ROOT)

master = json.load(open(os.path.join(WEB, "src", "data", "volcanoes.json"), encoding="utf-8"))
snapshot = json.load(open(os.path.join(ROOT, "cache", "latest_sources.json"), encoding="utf-8"))
NOW = datetime.strptime(snapshot["fetched_at"], "%Y-%m-%d %H:%M:%S UTC").replace(tzinfo=timezone.utc)


def fake_read_excel(path, usecols=None, **_kw):
    df = pd.DataFrame([{"volcano_number": v["n"], "volcano_name": v["name"], "country": v["country"],
                        "latitude": v["lat"], "longitude": v["lon"], "elevation": v["elev"]} for v in master])
    return df[usecols] if usecols else df


pd.read_excel = fake_read_excel  # the xlsx needs openpyxl; the JSON holds the same rows


class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz is None else NOW.astimezone(tz)


import volcano_alert_registry as registry  # noqa: E402  (pure pandas/sqlite3)

registry.datetime = FixedDatetime


def extract(path, funcs=(), assigns=()):
    tree = ast.parse(open(path, encoding="utf-8").read())
    keep = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in funcs:
            keep.append(node)
        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in assigns for t in node.targets):
            keep.append(node)
    return ast.Module(body=keep, type_ignores=[])


ns = {"pd": pd, "lru_cache": lru_cache, "datetime": FixedDatetime, "timedelta": timedelta, "timezone": timezone}
exec(compile(extract(os.path.join(ROOT, "volcano_data.py"), assigns={"JMA_NAME_MAP"}), "volcano_data", "exec"), ns)
_index = registry.VolcanoIndex("unused.xlsx")
ns["_registry_index"] = lambda: _index
exec(compile(extract(
    os.path.join(ROOT, "pages", "home.py"),
    funcs={"_norm_name", "_aliases", "_matches", "_time_label", "_time_short", "_vaa_issued_dt", "_vaa_sort_key",
           "_vaa_status", "_alert_for_volcano", "_official_alert", "_official_color", "_official_line",
           "_mirova_style", "_mirova_for", "_jma_issued"},
    assigns={"VAA_WINDOW_HOURS", "_EPOCH", "OFFICIAL_COLORS"}), "home", "exec"), ns)

# registry snapshot: read a COPY of the sqlite file (opening it runs CREATE TABLE IF NOT EXISTS)
tmp = tempfile.mkdtemp()
db_copy = os.path.join(tmp, "alerts.sqlite3")
shutil.copy(os.path.join(ROOT, "cache", "volcano_alerts.sqlite3"), db_copy)
reg = registry.read_alerts(db_copy)

alert_data = {
    "registry": reg,
    "vaac_rows": snapshot["vaac_rows"],
    "jma_raw": snapshot["jma_raw"],
    "jma_issued": snapshot["jma_issued"],
    "mirova_rows": snapshot["mirova_rows"],
}

# ── per-volcano decisions (the numeric part of build_map_markers) ──────────────────────────────
DEFAULT = {"size": 8, "fill": "transparent", "stroke": "#ffffff", "width": 2.4, "opacity": 0.5, "bubble": None}
expected = {}
for row in master:
    if row["lat"] is None or row["lon"] is None:
        continue
    name = row["name"]
    status = ns["_vaa_status"](alert_data, name)
    vaa, ended = status["current"], status["ended"]
    jma, _unused, vrp = ns["_alert_for_volcano"](name, alert_data, status)
    official = ns["_official_alert"](name, alert_data, row["n"])
    has_bubble = bool(vaa) or ended is not None
    color = ns["_official_color"](official)
    active = jma >= 2 or has_bubble or vrp is not None or color != "transparent"
    state = {
        "size": 24 if vaa else (18 if active else 8),
        "fill": color or "transparent",
        "stroke": ns["_mirova_style"](vrp) if vrp is not None else "#ffffff",
        "width": 3.4 if vrp is not None else (1.7 if active else 2.4),
        "opacity": 1.0 if active else 0.5,
        "bubble": None,
    }
    if has_bubble:
        latest = max(vaa, key=ns["_vaa_sort_key"]) if vaa else ended
        state["bubble"] = {"kind": "blink" if vaa else "ended",
                           "timeLine": "VAAC " + ns["_time_short"](latest.get("datetime")) + ("" if vaa else " · final")}
    if state != DEFAULT:
        mirova = ns["_mirova_for"](name, alert_data)
        state["extra"] = {
            "officialLine": ns["_official_line"](official),
            "jmaIssued": ns["_jma_issued"](name, alert_data) if jma else None,
            "vaaCurrent": len(vaa),
            "mirovaTime": mirova.get("time") if mirova else None,
        }
        expected[str(row["n"])] = state

# ── time formats ────────────────────────────────────────────────────────────────────────────────
samples = {r["datetime"] for r in snapshot["vaac_rows"]} | set(snapshot["jma_issued"].values()) \
    | {r["time"] for r in snapshot["mirova_rows"]}
samples |= {"2026-10-12T06:04:00+00:00", "2026-10-12 06:04 UTC", "20261012/0604Z", "", "garbage", "2026-10-05T01:02:03Z"}
time_cases = [{"raw": s, "label": ns["_time_label"](s), "short": ns["_time_short"](s)} for s in sorted(samples)]

# registry view the UI receives (no raw_json)
by_number = {k: [{**{f: a[f] for f in ("volcano_number", "source", "alert_type", "level", "label", "issued_at",
                                         "observed_at", "fetched_at", "source_url")}, "stale": bool(a["stale"])}
                 for a in v] for k, v in reg["by_number"].items()}
payload = {
    "registry": {"by_number": by_number, "sources": reg["sources"]},
    "vaac_rows": snapshot["vaac_rows"], "jma_raw": snapshot["jma_raw"], "jma_issued": snapshot["jma_issued"],
    "mirova_rows": snapshot["mirova_rows"], "timestamp": snapshot["fetched_at"][:16] + " UTC", "sig": "reference",
}

out = os.path.join(WEB, "src", "lib", "__fixtures__", "python-reference.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as fh:
    json.dump({"now": NOW.isoformat(), "payload": payload, "expected": expected, "timeCases": time_cases},
              fh, ensure_ascii=False, indent=1, default=str)
shutil.rmtree(tmp, ignore_errors=True)
bubbles = sum(1 for s in expected.values() if s["bubble"])
print(f"now={NOW.isoformat()}  non-default volcanoes={len(expected)} (with bubble: {bubbles})  time cases={len(time_cases)}")
print("->", out)
