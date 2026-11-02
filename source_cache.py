"""Small in-process cache so a refresh only fetches / re-renders what changed.

Two helpers:

* cached_call()      - TTL cache for expensive fetches (e.g. Selenium scrape).
                       Keeps the last good value if a refresh fails or comes
                       back empty, and reports whether the value changed.
* cached_http_parse() - HTTP GET with ETag / Last-Modified revalidation plus a
                       body-hash check. Unchanged pages are not re-downloaded
                       (304) or re-parsed; the previously parsed result is
                       returned instead.
"""
import copy
import hashlib
import json
import threading
import time

import requests

_LOCK = threading.Lock()
_VALUES = {}   # key -> {"value", "at", "hash"}
_HTTP = {}     # url -> {"etag", "last_modified", "body_hash", "parsed"}


def digest(obj):
    """Stable short hash of any JSON-like object."""
    raw = json.dumps(obj, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def cached_call(key, fetch, ttl, force=False, is_valid=None):
    """Return (value, changed). Re-runs `fetch` only when the entry is older
    than `ttl` seconds (or `force`). A failed / invalid refresh keeps the
    previous value instead of wiping it."""
    now = time.time()
    with _LOCK:
        entry = _VALUES.get(key)
    if entry and not force and now - entry["at"] < ttl:
        return copy.deepcopy(entry["value"]), False

    try:
        value = fetch()
    except Exception as exc:
        if entry:
            print(f"[cache] {key}: refresh failed, using cached value ({exc})")
            return copy.deepcopy(entry["value"]), False
        raise

    if is_valid is not None and not is_valid(value):
        if entry:
            print(f"[cache] {key}: empty refresh, keeping previous value")
            return copy.deepcopy(entry["value"]), False
        # Nothing to fall back on: return it, but retry on the next call.
        with _LOCK:
            _VALUES[key] = {"value": value, "at": 0, "hash": digest(value)}
        return value, True

    new_hash = digest(value)
    changed = entry is None or entry["hash"] != new_hash
    with _LOCK:
        _VALUES[key] = {"value": value, "at": now, "hash": new_hash}
    return copy.deepcopy(value), changed


def cached_http_parse(url, parse, timeout=15, headers=None, verify=True, force=False):
    """GET `url` with conditional headers and return (parsed, changed).

    `parse(response)` is only called when the body actually changed. On a
    network error the last parsed result is returned if one exists."""
    with _LOCK:
        state = dict(_HTTP.get(url, {}))
    req_headers = dict(headers or {})
    if not force:
        if state.get("etag"):
            req_headers["If-None-Match"] = state["etag"]
        if state.get("last_modified"):
            req_headers["If-Modified-Since"] = state["last_modified"]
    try:
        res = requests.get(url, timeout=timeout, headers=req_headers, verify=verify)
        if res.status_code == 304 and "parsed" in state:
            return copy.deepcopy(state["parsed"]), False
        res.raise_for_status()
        body_hash = hashlib.sha1(res.content).hexdigest()
        new_state = {
            "etag": res.headers.get("ETag"),
            "last_modified": res.headers.get("Last-Modified"),
            "body_hash": body_hash,
        }
        if "parsed" in state and state.get("body_hash") == body_hash:
            new_state["parsed"] = state["parsed"]
            with _LOCK:
                _HTTP[url] = new_state
            return copy.deepcopy(state["parsed"]), False
        parsed = parse(res)
        new_state["parsed"] = parsed
        with _LOCK:
            _HTTP[url] = new_state
        return copy.deepcopy(parsed), True
    except Exception as exc:
        if "parsed" in state:
            print(f"[cache] {url}: fetch failed, using cached copy ({exc})")
            return copy.deepcopy(state["parsed"]), False
        raise
