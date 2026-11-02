"""Persistent volcano-number keyed alert registry for project1.

Stage 1: JMA and VAAC normalization. PVMBG/KVERT collectors can call
upsert_alerts() when their source-specific parsers have been validated.
"""
import json
import os
import re
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import pandas as pd

_LOCK = threading.RLock()
SCHEMA = """
CREATE TABLE IF NOT EXISTS volcano_alerts (
 volcano_number INTEGER NOT NULL,
 source TEXT NOT NULL,
 alert_type TEXT NOT NULL,
 level TEXT NOT NULL,
 label TEXT NOT NULL,
 issued_at TEXT,
 observed_at TEXT,
 fetched_at TEXT NOT NULL,
 source_url TEXT,
 raw_json TEXT,
 PRIMARY KEY(volcano_number, source, alert_type)
);
CREATE TABLE IF NOT EXISTS alert_events (
 volcano_number INTEGER NOT NULL,
 source TEXT NOT NULL,
 kind TEXT NOT NULL,
 label TEXT NOT NULL,
 level TEXT,
 event_time TEXT NOT NULL,
 detail TEXT,
 url TEXT,
 first_seen TEXT NOT NULL,
 PRIMARY KEY(volcano_number, source, kind, label, event_time)
);
CREATE INDEX IF NOT EXISTS idx_alert_events_time ON alert_events(event_time);
CREATE TABLE IF NOT EXISTS source_refresh (
 source TEXT PRIMARY KEY,
 last_success TEXT,
 last_attempt TEXT,
 status TEXT NOT NULL,
 error TEXT
);
"""


def _utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _number(value):
    if value is None or pd.isna(value):
        return None
    try:
        n = int(float(value))
        return n if n > 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def _key(name):
    return re.sub(r"[^a-z0-9]", "", str(name or "").casefold())


class VolcanoIndex:
    def __init__(self, master_path):
        df = pd.read_excel(master_path, usecols=["volcano_number", "volcano_name", "country"])
        self.by_number = {}
        self.by_name = {}
        for row in df.itertuples(index=False):
            number = _number(row.volcano_number)
            if number is None:
                continue
            info = {"volcano_number": number, "volcano_name": str(row.volcano_name),
                    "country": str(row.country)}
            self.by_number[number] = info
            self.by_name.setdefault(_key(row.volcano_name), set()).add(number)
        # Explicit aliases, only accepted if the target number exists in the master.
        self.aliases = {
            "sakurajima": 282080, "sakurajimaairacaldera": 282080,
            "aira": 282080, "shiveluch": 300270, "sheveluch": 300270,
        }

    def resolve(self, volcano_number=None, name=None, country=None):
        n = _number(volcano_number)
        if n is not None:
            return n if n in self.by_number else None
        key = _key(name)
        if key in self.aliases and self.aliases[key] in self.by_number:
            return self.aliases[key]
        matches = self.by_name.get(key, set())
        if country:
            matches = {i for i in matches if self.by_number[i]["country"].casefold() == str(country).casefold()}
        return next(iter(matches)) if len(matches) == 1 else None


def _connect(db_path):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=15)
    conn.execute("PRAGMA busy_timeout=15000")
    conn.executescript(SCHEMA)
    return conn


_VAA_TIME = re.compile(r"(\d{8})[/ ](\d{4})")


def event_time_iso(value, default=None):
    """Best-effort UTC ISO timestamp from the formats the sources use
    ('20261012/0604Z', ISO strings, '2026-10-12 06:04 UTC', ...)."""
    if value is None or str(value).strip() == "":
        return default
    raw = str(value).strip()
    m = _VAA_TIME.search(raw)
    try:
        if m:
            dt = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        else:
            ts = pd.to_datetime(raw.replace(" UTC", ""), utc=True, errors="coerce")
            if pd.isna(ts):
                return default
            dt = ts.to_pydatetime()
        return dt.astimezone(timezone.utc).isoformat(timespec="seconds")
    except (ValueError, TypeError, OverflowError):
        return default


def _insert_events(conn, events, now):
    for e in events:
        n = _number(e.get("volcano_number"))
        when = event_time_iso(e.get("event_time"), default=now)
        if n is None:
            continue
        if event_time_iso(e.get("event_time")) is None:
            # No issue time from the source (e.g. PVMBG): the time above is just
            # "first seen". Don't add a new row on every refresh - only when
            # this volcano's label for the source actually changed.
            last = conn.execute("""SELECT label FROM alert_events WHERE volcano_number=? AND source=?
                                   AND kind=? ORDER BY event_time DESC LIMIT 1""",
                                (n, str(e.get("source") or ""), str(e.get("kind") or ""))).fetchone()
            if last and last[0] == str(e.get("label") or ""):
                continue
        conn.execute("""INSERT OR IGNORE INTO alert_events
          (volcano_number,source,kind,label,level,event_time,detail,url,first_seen)
          VALUES (?,?,?,?,?,?,?,?,?)""",
          (n, str(e.get("source") or ""), str(e.get("kind") or ""), str(e.get("label") or ""),
           None if e.get("level") is None else str(e.get("level")), when,
           e.get("detail"), e.get("url"), now))


def record_events(db_path, events):
    """Append-only history; duplicates (same source/kind/label/time) are ignored."""
    if not events:
        return
    with _LOCK, _connect(db_path) as conn:
        _insert_events(conn, events, _utcnow())


def read_events(db_path, since_iso, volcano_number=None, limit=2000):
    """Events with event_time >= since_iso, newest first."""
    sql = "SELECT * FROM alert_events WHERE event_time >= ?"
    args = [since_iso]
    if volcano_number is not None:
        sql += " AND volcano_number = ?"
        args.append(int(volcano_number))
    sql += " ORDER BY event_time DESC LIMIT ?"
    args.append(int(limit))
    with _LOCK, _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, args)]


def upsert_alerts(db_path, source, alerts, success=True, error=None):
    """Atomic source refresh; empty successful refresh clears old alerts for source.

    An unsuccessful refresh NEVER clears prior alerts. Old alerts are marked stale
    in read_alerts() based on source_refresh status, not silently considered normal.
    """
    now = _utcnow()
    with _LOCK, _connect(db_path) as conn:
        if success:
            conn.execute("DELETE FROM volcano_alerts WHERE source=?", (source,))
            # A source may publish multiple advisories for one volcano. The
            # snapshot schema stores one row per (number, source, alert_type),
            # so retain the latest advisory rather than raising UNIQUE errors.
            unique = {}
            for a in alerts:
                n = _number(a.get("volcano_number"))
                if n is None:
                    raise ValueError("Unresolved volcano_number in alert: " + repr(a))
                key = (n, str(a["alert_type"]))
                previous = unique.get(key)
                # Prefer the most recent issued timestamp; keep the last item
                # for equal/missing timestamps (e.g. repeated JMA table rows).
                if previous is None or str(a.get("issued_at") or "") >= str(previous.get("issued_at") or ""):
                    unique[key] = a
            _insert_events(conn, [{
                "volcano_number": a.get("volcano_number"), "source": source,
                "kind": a["alert_type"], "label": a.get("label") or a["level"],
                "level": a["level"], "event_time": a.get("issued_at") or a.get("observed_at"),
                "detail": (a.get("raw") or {}).get("eruption") if isinstance(a.get("raw"), dict) else None,
                "url": a.get("source_url"),
            } for a in unique.values()], now)
            for a in unique.values():
                n = _number(a.get("volcano_number"))
                if n is None:
                    raise ValueError("Unresolved volcano_number in alert: " + repr(a))
                conn.execute("""INSERT INTO volcano_alerts
                  (volcano_number,source,alert_type,level,label,issued_at,observed_at,fetched_at,source_url,raw_json)
                  VALUES (?,?,?,?,?,?,?,?,?,?)""",
                  (n, source, str(a["alert_type"]), str(a["level"]),
                   str(a.get("label") or a["level"]), a.get("issued_at"),
                   a.get("observed_at"), now, a.get("source_url"),
                   json.dumps(a.get("raw", {}), ensure_ascii=False, default=str)))
        last = conn.execute("SELECT last_success FROM source_refresh WHERE source=?", (source,)).fetchone()
        last_success = now if success else (last[0] if last else None)
        conn.execute("""INSERT INTO source_refresh(source,last_success,last_attempt,status,error)
           VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET
           last_success=excluded.last_success,last_attempt=excluded.last_attempt,
           status=excluded.status,error=excluded.error""",
           (source, last_success, now, "ok" if success else "error", None if success else str(error)))


# A failed refresh does not make the records stale at once: official levels change over days, and a source that
# times out for one attempt (PVMBG does now and then) would otherwise lose every triangle colour for a while.
# Records count as stale only when the last SUCCESSFUL refresh is older than this.
STALE_AFTER = timedelta(hours=6)


def _is_stale(status):
    if status.get("status") == "ok":
        return False
    try:
        last = datetime.fromisoformat(status["last_success"])
    except (KeyError, TypeError, ValueError):
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - last > STALE_AFTER


def read_alerts(db_path):
    with _LOCK, _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        statuses = {r["source"]: dict(r) for r in conn.execute("SELECT * FROM source_refresh")}
        result = {}
        for row in conn.execute("SELECT * FROM volcano_alerts"):
            d = dict(row)
            d["stale"] = _is_stale(statuses.get(d["source"], {}))
            result.setdefault(str(d["volcano_number"]), []).append(d)
        return {"by_number": result, "sources": statuses}


def normalize_jma(index, raw_levels, issued=None):
    """Only published levels are stored; no match does NOT mean level 1."""
    from volcano_data import JMA_NAME_MAP
    alerts = []
    unresolved = []
    for name, level in (raw_levels or {}).items():
        number = index.resolve(name=JMA_NAME_MAP.get(name, name), country="Japan")
        if number is None:
            unresolved.append(name)
            continue
        try:
            level_int = int(level)
        except (ValueError, TypeError):
            continue
        alerts.append({"volcano_number": number, "alert_type": "volcano_level",
                       "level": str(level_int), "label": "JMA Level " + str(level_int),
                       "issued_at": (issued or {}).get(name),
                       "source_url": "https://www.jma.go.jp/bosai/map.html#contents=volcano",
                       "raw": {"source_name": name}})
    return alerts, unresolved


def normalize_vaac(index, rows):
    alerts, unresolved = [], []
    for row in rows or []:
        if row.get("is_terminal"):
            continue
        name = str(row.get("volcano", ""))
        number = row.get("volcano_number")
        if not number:
            match = re.search(r"(?<!\d)(\d{6})(?!\d)", name)
            number = match.group(1) if match else None
        clean_name = re.sub(r"\b\d{6}\b", "", name).strip()
        n = index.resolve(volcano_number=number, name=clean_name)
        if n is None:
            unresolved.append(name)
            continue
        source = str(row.get("source") or "VAAC")
        alerts.append({"volcano_number": n, "alert_type": "vaa",
                       "level": "ACTIVE", "label": source + " VAA",
                       "issued_at": row.get("datetime"), "source_url": row.get("detail_url"),
                       "raw": row})
    return alerts, unresolved
