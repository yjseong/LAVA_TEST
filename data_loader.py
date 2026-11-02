import pandas as pd
import os
from datetime import datetime, timedelta, timezone

# Data root path (Windows NAS for testing, change to Linux path later)
DATA_ROOT = r"A:\JP_data"
# DATA_ROOT = "/home/kigam/Data/JP_data"  # Linux path (uncomment when switching)

def get_date_range():
    """Return start and end datetime for the last 7 days."""
    end = datetime.now(timezone.utc).replace(tzinfo=None)
    start = end - timedelta(days=7)
    return start, end

def resolve_date_range(start_date=None, end_date=None):
    """Turn optional start_date/end_date ('YYYY-MM-DD' strings, e.g.
    from a Dash DatePickerSingle) into (start_dt, end_dt) naive UTC
    datetimes. end_date is treated as inclusive of that whole day.
    Falls back to the last 7 days if either is missing or unparsable
    — same default as before, so callers that don't pass dates (like
    home.py) keep working exactly as they did."""
    if start_date and end_date:
        try:
            start = datetime.strptime(str(start_date).split("T")[0], "%Y-%m-%d")
            end = datetime.strptime(str(end_date).split("T")[0], "%Y-%m-%d") + timedelta(days=1)
            return start, end
        except (ValueError, TypeError):
            pass
    return get_date_range()

def get_monthly_files(volcano, prefix, start, end, root=None):
    """
    Return list of CSV file paths covering the date range.
    Handles month boundary (e.g. late June needs May + June files).
    """
    files = []
    current = start.replace(day=1)
    while current <= end:
        filename = f"{prefix}_{current.strftime('%Y%m')}.csv"
        filepath = os.path.join(root or DATA_ROOT, volcano, filename)
        if os.path.exists(filepath):
            files.append(filepath)
        current = (current.replace(day=28) + timedelta(days=4)).replace(day=1)
    return files

def load_rsam(volcano, start_date=None, end_date=None):
    """
    Load RSAM data for the given date range (default: last 7 days).
    Returns DataFrame with columns [time_utc, RSAM] or empty DataFrame.
    """
    try:
        start, end = resolve_date_range(start_date, end_date)
        files = get_monthly_files(volcano, "RSAM", start, end)
        if not files:
            return pd.DataFrame(columns=["time_utc", "RSAM"])

        df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
        df["time_utc"] = pd.to_datetime(df["time_utc"])
        df = df[(df["time_utc"] >= start) & (df["time_utc"] <= end)]
        df = df.sort_values("time_utc").reset_index(drop=True)
        return df

    except Exception as e:
        print(f"[RSAM] {volcano}: {e}")
        return pd.DataFrame(columns=["time_utc", "RSAM"])

def load_ssam(volcano, start_date=None, end_date=None):
    """
    Load SSAM data for the given date range (default: last 7 days).
    Returns DataFrame with time_utc + frequency columns or empty DataFrame.
    """
    try:
        start, end = resolve_date_range(start_date, end_date)
        files = get_monthly_files(volcano, "SSAM", start, end)
        if not files:
            return pd.DataFrame()

        df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
        df["time_utc"] = pd.to_datetime(df["time_utc"])
        df = df[(df["time_utc"] >= start) & (df["time_utc"] <= end)]
        df = df.sort_values("time_utc").reset_index(drop=True)
        return df

    except Exception as e:
        print(f"[SSAM] {volcano}: {e}")
        return pd.DataFrame()

def load_peak_pressure(volcano, start_date=None, end_date=None):
    """
    Load Peak Pressure data for the given date range (default: last 7 days).
    Returns DataFrame with columns [time_utc, peak_pressure_Pa] or empty DataFrame.
    """
    try:
        start, end = resolve_date_range(start_date, end_date)
        files = get_monthly_files(volcano, "infra", start, end)
        if not files:
            return pd.DataFrame(columns=["time_utc", "peak_pressure_Pa"])

        df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
        df["time_utc"] = pd.to_datetime(df["time_utc"])
        df = df[(df["time_utc"] >= start) & (df["time_utc"] <= end)]
        df = df.sort_values("time_utc").reset_index(drop=True)
        return df

    except Exception as e:
        print(f"[Peak pressure] {volcano}: {e}")
        return pd.DataFrame(columns=["time_utc", "peak_pressure_Pa"])


def load_band(volcano, start_date=None, end_date=None):
    """
    Load band-limited amplitudes (band_YYYYMM.csv, written by load_5volcano.py)
    for the given date range (default: last 7 days).
    Columns: time_utc, v_<band>... (velocity, m/s), d_<band>... (displacement, m)
    Returns an empty DataFrame if no band files exist yet for that range.
    """
    try:
        start, end = resolve_date_range(start_date, end_date)
        files = get_monthly_files(volcano, "band", start, end)
        if not files:
            return pd.DataFrame()

        df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
        df["time_utc"] = pd.to_datetime(df["time_utc"])
        df = df[(df["time_utc"] >= start) & (df["time_utc"] <= end)]
        df = df.drop_duplicates(subset="time_utc")
        df = df.sort_values("time_utc").reset_index(drop=True)
        return df

    except Exception as e:
        print(f"[Band] {volcano}: {e}")
        return pd.DataFrame()


def load_dvv(volcano, start_date=None, end_date=None):
    """
    Load dv/v results (dvv_YYYYMM.csv, written on the server by export_dvv_csv.py)
    for the given date range (default: last 7 days).
    Columns: time_utc, filter, mov_stack_days, comp, pair, dvv_pct, err_pct
    The folder can be overridden with the LAVA_DVV_ROOT environment variable
    (used for testing with sample files); it defaults to DATA_ROOT.
    Returns an empty DataFrame if no dv/v files exist yet for that range.
    """
    try:
        start, end = resolve_date_range(start_date, end_date)
        files = get_monthly_files(volcano, "dvv", start, end, root=os.environ.get("LAVA_DVV_ROOT"))
        if not files:
            return pd.DataFrame()

        df = pd.concat([pd.read_csv(f, dtype={"pair": str, "comp": str}) for f in files], ignore_index=True)
        df["time_utc"] = pd.to_datetime(df["time_utc"])
        df = df[(df["time_utc"] >= start) & (df["time_utc"] <= end)]
        df = df.drop_duplicates(subset=["time_utc", "filter", "mov_stack_days", "comp", "pair"], keep="last")
        df = df.sort_values("time_utc").reset_index(drop=True)
        return df

    except Exception as e:
        print(f"[dv/v] {volcano}: {e}")
        return pd.DataFrame()


# ── Quick test ─────────────────────────────────────────────
if __name__ == "__main__":
    VOLCANOES = ["Asosan", "Kirishimayama", "Sakurajima", "Kuchinoerabujima", "Ontakesan"]

    for v in VOLCANOES:
        print(f"\n{'='*40}")
        print(f"Volcano: {v}")

        rsam = load_rsam(v)
        print(f"  RSAM      : {len(rsam)} rows")
        if not rsam.empty:
            print(f"             {rsam['time_utc'].min()} ~ {rsam['time_utc'].max()}")

        ssam = load_ssam(v)
        print(f"  SSAM      : {len(ssam)} rows")
        if not ssam.empty:
            print(f"             {ssam['time_utc'].min()} ~ {ssam['time_utc'].max()}")

        peak = load_peak_pressure(v)
        print(f"  Peak pres.: {len(peak)} rows")
        if not peak.empty:
            print(f"             {peak['time_utc'].min()} ~ {peak['time_utc'].max()}")