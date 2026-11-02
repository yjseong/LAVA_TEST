import pandas as pd
import os
import re
from datetime import datetime, timezone
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from webdriver_manager.chrome import ChromeDriverManager
from bs4 import BeautifulSoup
import requests
import urllib3
import time
import pymysql
from sqlalchemy import create_engine
from db_config import DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS
from source_cache import cached_http_parse

# ── Paths ──────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))   # review copy: the folder this file is in
ASSETS_DIR = os.path.join(BASE_DIR, "assets")
XLSX_PATH  = os.path.join(BASE_DIR, "volcano_master_all.xlsx")

# ── Network ────────────────────────────────────────────────
# On some institutional networks, an SSL-inspecting proxy re-signs
# HTTPS traffic with its own root certificate. The actual Chrome
# browser (once launched) usually already trusts it via the OS
# certificate store — but two things here go through Python's own
# `requests` library instead, which uses a separate certifi bundle
# that doesn't include that root cert, and so fail with
# "self-signed certificate in certificate chain":
#   1) our own VAAC/MIROVA page fetches below
#   2) webdriver_manager's fetch of the chromedriver binary itself,
#      which happens BEFORE Chrome ever launches
#
# Setting this to False skips certificate verification for those
# requests.get() calls only. It only applies to the public, read-only
# pages fetched here (VAAC advisories, MIROVA) and to fetching the
# driver binary — not to anything that sends credentials.
#
# The more correct long-term fix is to get the institution's root CA
# certificate from IT and point the REQUESTS_CA_BUNDLE environment
# variable at a bundle that includes it — then this can go back to True.
VERIFY_SSL = False
if not VERIFY_SSL:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    # webdriver_manager's own documented way to skip verification for
    # its chromedriver-download requests. Must be set before
    # ChromeDriverManager is used anywhere (it's read at call time, so
    # anywhere before make_driver() actually runs is fine).
    os.environ["WDM_SSL_VERIFY"] = "0"

# ── URLs ───────────────────────────────────────────────────
VAAC_URL   = "https://www.data.jma.go.jp/vaac/data/index.html"
MIROVA_URL = "https://www.mirovaweb.it/NRT/index.php"
JMA_URL    = "https://www.jma.go.jp/bosai/map.html#5/34.5/135/&contents=volcano&lang=en"

# ── Target volcanoes ───────────────────────────────────────
TARGET_VOLCANOES = {
    "Asosan":            {"xlsx_name": "Asosan"},
    "Kirishimayama":     {"xlsx_name": "Kirishimayama"},
    "Sakurajima":        {"xlsx_name": "Aira"},
    "Kuchinoerabujima":  {"xlsx_name": "Kuchinoerabujima"},
    "Ontakesan":         {"xlsx_name": "Ontakesan"},
}

# MIROVA IDs for target volcanoes
MIROVA_IDS = {
    282110: "Asosan",
    282090: "Kirishimayama",
    282080: "Sakurajima",
}

# JMA name mapping (JMA name → our name)
JMA_NAME_MAP = {
    # Target volcanoes
    "Kirishimayama(Shinmoedake)": "Kirishimayama",
    "Kirishimayama":              "Kirishimayama",
    "Sakurajima":                 "Aira",
    "Asosan":                     "Asosan",
    "Kuchinoerabujima":           "Kuchinoerabujima",
    "Ontakesan":                  "Ontakesan",
    # Current JMA alerts
    "Tokachidake":                "Tokachidake",
    "Meakandake":                 "Akan",
    "Iwatesan":                   "Iwatesan",
    "Sumisujima(Smith Rocks)":    "Sumisujima",
    "Suwanosejima":               "Suwanosejima",
    "Beyonesu(Bayonnaise) Rocks": "Kita-Bayonnaise",
    "Fukutoku-Oka-no-Ba":         "Fukutoku-Oka-no-Ba",
    "Satsuma-Iojima":             "Ata",
    "Nishinoshima":               "Nishinoshima",
    "Ioto":                       "Ioto",
    # Other possible JMA alerts (all Japanese volcanoes)
    "Atosanupuri":                "Etorofu-Atosanupuri [Atosanupuri]",
    "Meakan":                     "Akan",
    "Taisetsuzan":                "Taisetsuzan",
    "Tokachi":                    "Tokachidake",
    "Tarumae":                    "Shikotsu",
    "Kuttara":                    "Kuttara",
    "Usu":                        "Toya",
    "Komagatake":                 "Hokkaido-Komagatake",
    "Esan":                       "Esan",
    "Iwaki":                      "Iwakisan",
    "Akita-Yakeyama":             "Akita-Yakeyama",
    "Iwate":                      "Iwatesan",
    "Akita-Komagatake":           "Akita-Komagatake",
    "Chokai":                     "Chokaisan",
    "Kurikoma":                   "Kurikomayama",
    "Zao":                        "Zaozan [Zaosan]",
    "Zaozan":                     "Zaozan [Zaosan]",
    "Azuma":                      "Azumayama",
    "Adatara":                    "Adatarayama",
    "Bandai":                     "Bandaisan",
    "Numazawa":                   "Numazawa",
    "Nasu":                       "Nasudake",
    "Nikko-Shirane":              "Nikko-Shiranesan",
    "Nikko-Shiranesan":           "Nikko-Shiranesan",
    "Kusatsu-Shirane":            "Kusatsu-Shiranesan",
    "Kusatsu-Shiranesan":         "Kusatsu-Shiranesan",
    "Asama":                      "Asamayama",
    "Asamayama":                  "Asamayama",
    "Yakeyama":                   "Yakedake",
    "Yakedake":                   "Yakedake",
    "Norikura":                   "Norikuradake",
    "Norikuradake":               "Norikuradake",
    "Hakusan":                    "Hakusan",
    "Fuji":                       "Fujisan",
    "Fujisan":                    "Fujisan",
    "Hakone":                     "Hakoneyama",
    "Hakoneyama":                 "Hakoneyama",
    "Izu-Tobu Volcanoes":         "Izu-Tobu",
    "Izu-Tobu":                   "Izu-Tobu",
    "Izu-Oshima":                 "Izu-Oshima",
    "Niijima":                    "Niijima",
    "Kozushima":                  "Kozushima",
    "Miyakejima":                 "Miyakejima",
    "Hachijojima":                "Hachijojima",
    "Aogashima":                  "Aogashima",
    "Bayonnaise Rocks":           "Kita-Bayonnaise",
    "Beyonezu":                   "Kita-Bayonnaise",
    "Izu-Torishima":              "Izu-Torishima",
    "Nishinoshima":               "Nishinoshima",
    "Ioto":                       "Ioto",
    "Iojima":                     "Ioto",
    "Fukutoku-oka-no-ba":         "Fukutoku-Oka-no-Ba",
    "Kuchinoerabu":               "Kuchinoerabujima",
    "Satsuma-Iojima":             "Ata",
    "Suwanose":                   "Suwanosejima",
    "Unzen":                      "Unzendake",
    "Unzendake":                  "Unzendake",
    "Kuju":                       "Kujusan",
    "Kujusan":                    "Kujusan",
    "Aso":                        "Asosan",
    "Io-Torishima":               "Izu-Torishima",
    "Nakanoshima":                "Nakanoshima",
    "Suwanose":                   "Suwanosejima",
}

# ── Load volcano master data ───────────────────────────────
_MASTER_CACHE = {"mtime": None, "df": None}

def load_volcano_master():
    """Load all volcanoes from xlsx for map markers (re-read only if the file changed)."""
    try:
        mtime = os.path.getmtime(XLSX_PATH)
        if _MASTER_CACHE["df"] is None or _MASTER_CACHE["mtime"] != mtime:
            df = pd.read_excel(XLSX_PATH)
            df = df[["volcano_number", "volcano_name", "country", "latitude", "longitude", "elevation"]].dropna(
                subset=["latitude", "longitude"]
            )
            _MASTER_CACHE.update(mtime=mtime, df=df)
        return _MASTER_CACHE["df"].copy()
    except Exception as e:
        print(f"[volcano_master] {e}")
        return pd.DataFrame()

def get_target_info():
    """Return dict of target volcano info from xlsx."""
    df = load_volcano_master()
    result = {}
    for our_name, meta in TARGET_VOLCANOES.items():
        xlsx_name = meta["xlsx_name"]
        match = df[df["volcano_name"].str.contains(xlsx_name, case=False, na=False)]
        if not match.empty:
            row = match.iloc[0]
            result[our_name] = {
                "lat":  float(row["latitude"]),
                "lon":  float(row["longitude"]),
                "elev": float(row["elevation"]),
            }
    return result

# ── Selenium helper ────────────────────────────────────────
def make_driver():
    """Create a headless Chrome driver."""
    options = Options()
    options.add_argument("--headless")
    options.add_argument("--window-size=1400,900")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    return webdriver.Chrome(
        service=Service(ChromeDriverManager().install()),
        options=options
    )

# ── VAAC ───────────────────────────────────────────────────
def get_vaac_table():
    """Read Tokyo VAAC latest-advisory table, keeping source name and timestamps.

    Tokyo may label Sakurajima as 'SAKURAJIMA (AIRA CALDERA)'.
    """
    from urllib.parse import urljoin

    def parse(res):
        soup = BeautifulSoup(res.text, "html.parser")
        rows = []
        for table in soup.find_all("table"):
            for tr in table.find_all("tr"):
                cells = tr.find_all("td")
                if len(cells) < 4:
                    continue
                cols = [cell.get_text(" ",strip=True) for cell in cells]
                if not cols[0] or cols[0].casefold() in ("volcano", "volcano name"):
                    continue
                link = next((a for cell in cells for a in cell.find_all("a",href=True)),None)
                detail_url = urljoin(VAAC_URL,link["href"]) if link else None
                rows.append({"volcano":cols[0],"advisory":cols[1],
                             "eruption":cols[2],"datetime":cols[3],
                             "detail_url":detail_url,"source":"Tokyo VAAC",
                             "is_terminal":False})
        return rows

    try:
        rows, changed = cached_http_parse(VAAC_URL, parse, timeout=15, verify=VERIFY_SSL,
                                          headers={"User-Agent":"Mozilla/5.0"})
        if changed:
            print(f"[Tokyo VAAC] parsed {len(rows)} rows")
        return rows
    except Exception as e:
        print(f"[Tokyo VAAC] {e}")
        return []

VAAC_LIST_URL = "https://www.data.jma.go.jp/vaac/data/vaac_list.html"

def get_vaac_recent_list():
    """Tokyo VAAC 'Recently Advisories' list (about 6 weeks of issued VAAs).

    The front page only shows advisories that are active right now (often none),
    so this list is the source for the alert history of the last 7/30 days.
    The hidden first column holds the issue time in UTC (YYYY/MM/DD HH:MM:SS).
    """
    from urllib.parse import urljoin

    def parse(res):
        soup = BeautifulSoup(res.text, "html.parser")
        tbody = soup.find("tbody", id="tbd1")
        rows = []
        for tr in (tbody.find_all("tr") if tbody else []):
            td = tr.find_all("td")
            if len(td) < 6:
                continue
            raw_time = td[0].get_text(strip=True)
            try:
                issued = datetime.strptime(raw_time, "%Y/%m/%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat()
            except ValueError:
                continue
            link = td[5].find("a", href=True)
            rows.append({
                "volcano": td[2].get_text(" ", strip=True),
                "area": td[3].get_text(" ", strip=True),
                "advisory": td[4].get_text(strip=True),
                "datetime": issued,
                "detail_url": urljoin(VAAC_LIST_URL, link["href"]) if link else None,
                "source": "Tokyo VAAC",
                "is_terminal": False,
            })
        return rows

    try:
        rows, changed = cached_http_parse(VAAC_LIST_URL, parse, timeout=20, verify=VERIFY_SSL,
                                          headers={"User-Agent": "Mozilla/5.0"})
        if changed:
            print(f"[Tokyo VAAC list] parsed {len(rows)} advisories")
        return rows
    except Exception as e:
        print(f"[Tokyo VAAC list] {e}")
        return []

def get_vaac_eruption_details(detail_url):
    """
    Fetch the VAA detail text page and extract the ERUPTION DETAILS line.
    Returns string or None.
    """
    if not detail_url:
        return None
    try:
        res = requests.get(detail_url, timeout=10, verify=VERIFY_SSL)
        text = res.text
        # Extract text content, look for ERUPTION DETAILS line
        soup = BeautifulSoup(text, "html.parser")
        full_text = soup.get_text("\n")
        for line in full_text.split("\n"):
            line = line.strip()
            if line.startswith("ERUPTION DETAILS"):
                return line
        return None
    except Exception as e:
        print(f"[VAAC detail] {e}")
        return None

def get_vaac_active_volcanoes():
    """Return set of volcano names currently in VAAC advisory."""
    rows = get_vaac_table()
    return {r["volcano"].upper() for r in rows}

# ── JMA ────────────────────────────────────────────────────
def get_jma_alerts():
    """
    Scrape JMA alert levels.
    Returns dict: {volcano_name: level_int}
    """
    from datetime import datetime, timedelta, timezone
    driver = make_driver()
    try:
        driver.get(JMA_URL)
        time.sleep(8)
        soup = BeautifulSoup(driver.page_source, "html.parser")
        results = {}
        issued_times = {}
        seen = set()

        # Parse issued times (JST → UTC)
        jst = timezone(timedelta(hours=9))
        utc = timezone.utc
        for el in soup.find_all(True):
            text = el.get_text(strip=True)
            # Match "HH:MM JST, DD Mon. YYYY"
            m = re.search(r'(\d{2}:\d{2})\s+JST,\s+(\d{2})\s+(\w+\.?)\s+(\d{4})', text)
            if m and len(text) < 150:
                time_str = f"{m.group(1)} {m.group(2)} {m.group(3).replace('.','')} {m.group(4)}"
                try:
                    dt_jst = datetime.strptime(time_str, "%H:%M %d %b %Y").replace(tzinfo=jst)
                    dt_utc = dt_jst.astimezone(utc)
                    # Get volcano name from same element
                    for vname in results:
                        if vname in text and vname not in issued_times:
                            issued_times[vname] = dt_utc.strftime("%Y-%m-%d %H:%M UTC")
                except Exception:
                    pass

        for el in soup.find_all(class_=lambda c: c and "volcano-level" in c):
            classes = el.get("class", [])
            level = None
            for cls in classes:
                m = re.match(r"volcano-level(\d+)$", cls)
                if m:
                    level = int(m.group(1))
                    break
            if not level:
                continue
            parent = el.parent
            if not parent:
                continue
            parent_text = parent.get_text(" ", strip=True)
            name_match = re.search(
                r"\d{4}\s+([A-Za-z][A-Za-z0-9 \-\(\)]+?)\s+(?:Near-crater|Volcanic|Level|Caution)",
                parent_text
            )
            if not name_match:
                continue
            name = name_match.group(1).strip()
            if name in seen:
                continue
            seen.add(name)
            results[name] = level

            # Try to find issued time from parent text
            tm = re.search(r'(\d{2}:\d{2})\s+JST,\s+(\d{2})\s+(\w+\.?)\s+(\d{4})', parent_text)
            if tm:
                time_str = f"{tm.group(1)} {tm.group(2)} {tm.group(3).replace('.', '')} {tm.group(4)}"
                try:
                    dt_jst = datetime.strptime(time_str, "%H:%M %d %b %Y").replace(tzinfo=jst)
                    dt_utc = dt_jst.astimezone(utc)
                    issued_times[name] = dt_utc.strftime("%Y-%m-%d %H:%M UTC")
                except Exception:
                    pass

        return results, issued_times
    except Exception as e:
        print(f"[JMA alerts] {e}")
        return {}, {}
    finally:
        driver.quit()

def get_jma_alert_for_target(jma_alerts):
    """
    Map JMA alert dict to our target volcano names.
    Returns dict: {our_name: level_int}
    """
    result = {}
    for jma_name, level in jma_alerts.items():
        our_name = JMA_NAME_MAP.get(jma_name)
        if our_name:
            result[our_name] = level
    return result

# ── MIROVA ─────────────────────────────────────────────────
def get_mirova_alerts():
    """
    Scrape ALL MIROVA latest alerts (all 38 volcanoes).
    Returns list of dicts with volcano name, VRP, time.
    """
    def parse(res):
        soup = BeautifulSoup(res.text, "html.parser")
        rows = []
        for table in soup.find_all("table"):
            for tr in table.find_all("tr")[1:]:
                cols = [td.get_text(strip=True) for td in tr.find_all("td")]
                if len(cols) >= 5:
                    try:
                        vol_id = int(cols[1])
                        # Check if it's one of our target volcanoes
                        our_name = MIROVA_IDS.get(vol_id, None)
                        rows.append({
                            "volcano":    cols[2],          # Original MIROVA name
                            "our_name":   our_name,         # Our name if target, else None
                            "is_target":  our_name is not None,
                            "volcano_id": vol_id,
                            "time":       cols[0],
                            "vrp_mw":     cols[3],
                            "sensor":     cols[5] if len(cols) > 5 else "",
                        })
                    except ValueError:
                        continue
        return rows

    try:
        rows, _changed = cached_http_parse(MIROVA_URL, parse, timeout=10, verify=VERIFY_SSL)
        return rows
    except Exception as e:
        print(f"[MIROVA] {e}")
        return []

def get_mirova_active_volcanoes():
    """Return set of our target volcano names currently in MIROVA alerts."""
    rows = get_mirova_alerts()
    return {r["our_name"] for r in rows if r["is_target"]}

def get_mirova_all_names():
    """Return set of ALL volcano names in MIROVA alerts (for map blinking)."""
    rows = get_mirova_alerts()
    return {r["volcano"] for r in rows}

# ── Combined alert status ──────────────────────────────────
def get_all_alert_status():
    """
    Fetch all alert data and return combined status.
    Returns dict with keys: vaac_active, jma_alerts, mirova_active, timestamp
    """
    vaac_active  = get_vaac_active_volcanoes()
    jma_raw, jma_issued = get_jma_alerts()
    jma_alerts   = get_jma_alert_for_target(jma_raw)
    mirova_active = get_mirova_active_volcanoes()

    return {
        "vaac_active":   vaac_active,
        "jma_alerts":    jma_alerts,
        "jma_raw":       jma_raw,
        "mirova_active": mirova_active,
        "timestamp":     datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    }

# ── VAA database queries ────────────────────────────────────
def get_db_engine():
    """Create SQLAlchemy engine."""
    return create_engine(
        f"mysql+pymysql://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"
    )

ASH_QUERY_TEMPLATE = """
SELECT DISTINCT
    volcano_number,
    volcano_name,
    latitude,
    longitude,
    eruption_datetime,
    CAST(REPLACE(fl_str, 'FL', '') AS UNSIGNED) * 100 AS ash_height_ft,
    CAST(REPLACE(fl_str, 'FL', '') AS UNSIGNED) * 100 * 0.0003048 AS ash_height_km,
    full_text
FROM (
    SELECT
        vm.volcano_number,
        vm.volcano_name,
        vm.latitude,
        vm.longitude,
        REPLACE(COALESCE(
            NULLIF(REGEXP_SUBSTR(
                REGEXP_SUBSTR(vaa.eruption_details,
                              '(?i)(?:EXPLODED|ERUPTED) AT [0-9]{{8}}/[0-9]{{4}}Z'),
                '[0-9]{{8}}/[0-9]{{4}}Z'
            ), ''),
            DATE_FORMAT(vaa.date_time, '%%Y%%m%%d/%%H%%iZ')
        ), 'Z', '') AS eruption_datetime,
        -- Prefer the FL in ERUPTION DETAILS (when it's a real single
        -- value, not "UNKNOWN" and not an ambiguous "FLxxx/FLyyy"
        -- range). If that's not usable, fall back to the FL on the
        -- "OBS VA CLD:" line of the full advisory text instead of
        -- dropping the row entirely.
        COALESCE(
            CASE
                WHEN vaa.eruption_details NOT LIKE '%%UNKNOWN%%'
                     AND vaa.eruption_details REGEXP 'FL[0-9]+'
                     AND vaa.eruption_details NOT REGEXP 'FL[0-9]+/FL[0-9]+'
                THEN REGEXP_SUBSTR(vaa.eruption_details, 'FL[0-9]+')
            END,
            CASE
                WHEN vaa.full_text REGEXP 'OBS VA CLD:[ ]*SFC/FL[0-9]+'
                THEN REGEXP_SUBSTR(
                        REGEXP_SUBSTR(vaa.full_text, 'OBS VA CLD:[ ]*SFC/FL[0-9]+'),
                        'FL[0-9]+')
            END
        ) AS fl_str,
        vaa.full_text
    FROM volcano_ash_advisory vaa
    LEFT JOIN volcano_master vm ON vaa.volcano_number = vm.volcano_number
    WHERE
        vaa.date_time >= %s
        AND vaa.date_time <= %s
        {volcano_filter}
) src
WHERE fl_str IS NOT NULL
ORDER BY eruption_datetime ASC;
"""

def get_ash_volcano_list():
    """
    Return list of {volcano_number, volcano_name, latitude, longitude}
    for all volcanoes that have appeared in the ash advisory table.
    """
    try:
        engine = get_db_engine()
        query = """
        SELECT DISTINCT vm.volcano_number, vm.volcano_name, vm.latitude, vm.longitude
        FROM volcano_ash_advisory vaa
        LEFT JOIN volcano_master vm ON vaa.volcano_number = vm.volcano_number
        WHERE vm.volcano_name IS NOT NULL
        ORDER BY vm.volcano_name ASC;
        """
        with engine.connect() as conn:
            df = pd.read_sql(query, conn)

        return df
    except Exception as e:
        print(f"[get_ash_volcano_list] {e}")
        return pd.DataFrame()

def get_ash_data(volcano_number=None, start_date=None, end_date=None,
                 min_height_km=None, max_height_km=None):
    """
    Query ash advisory data with optional filters.

    Parameters:
        volcano_number: int or None (None = all volcanoes)
        start_date, end_date: datetime objects
        min_height_km, max_height_km: float or None

    Returns DataFrame with columns:
        volcano_number, volcano_name, latitude, longitude,
        eruption_datetime, ash_height_ft, ash_height_km
    """
    try:
        engine = get_db_engine()

        volcano_filter = ""
        params = []

        if start_date is None:
            start_date = datetime.now(timezone.utc) - pd.Timedelta(days=365)
        if end_date is None:
            end_date = datetime.now(timezone.utc)

        params = [start_date.strftime("%Y-%m-%d %H:%M:%S"),
                  end_date.strftime("%Y-%m-%d %H:%M:%S")]
        if volcano_number is not None:
            volcano_filter = "AND vm.volcano_number = %s"
            params.append(volcano_number)
        params = tuple(params)

        query = ASH_QUERY_TEMPLATE.format(volcano_filter=volcano_filter)
        with engine.connect() as conn:
            df = pd.read_sql(query, conn, params=params)

        # Apply height filters in pandas (simpler than adding to SQL)
        if min_height_km is not None:
            df = df[df["ash_height_km"] >= min_height_km]
        if max_height_km is not None:
            df = df[df["ash_height_km"] <= max_height_km]

        # Parse eruption_datetime (format: YYYYMMDD/HHMM)
        df["eruption_dt"] = pd.to_datetime(df["eruption_datetime"], format="%Y%m%d/%H%M", errors="coerce")

        return df.sort_values("eruption_dt")
    except Exception as e:
        print(f"[get_ash_data] {e}")
        return pd.DataFrame()

def get_vaa_history(volcano_number, days=30):
    """Recent VAA records for one volcano from the advisory DB (best effort).

    Returns a list of {"event_time", "detail"}; [] if the DB is unreachable.
    Uses a short connect timeout so the UI never hangs on an offline DB."""
    try:
        engine = create_engine(
            f"mysql+pymysql://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4",
            connect_args={"connect_timeout": 4, "read_timeout": 8})
        since = (datetime.now(timezone.utc) - pd.Timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
        query = ("SELECT date_time, eruption_details FROM volcano_ash_advisory "
                 "WHERE volcano_number = %s AND date_time >= %s ORDER BY date_time DESC LIMIT 100")
        with engine.connect() as conn:
            df = pd.read_sql(query, conn, params=(int(volcano_number), since))
        return [{"event_time": pd.Timestamp(r.date_time).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
                 "detail": str(r.eruption_details or "")} for r in df.itertuples(index=False)]
    except Exception as e:
        print(f"[get_vaa_history] {e}")
        return []

# ── Quick test ─────────────────────────────────────────────
if __name__ == "__main__":
    print("=== Volcano master ===")
    info = get_target_info()
    for k, v in info.items():
        print(f"  {k}: {v}")

    print("\n=== VAAC active ===")
    print(get_vaac_active_volcanoes())

    print("\n=== JMA alerts ===")
    jma, jma_issued = get_jma_alerts()
    for k, v in jma.items():
        print(f"  Level {v}: {k}")

    print("\n=== MIROVA target volcanoes ===")
    print(get_mirova_active_volcanoes())

    print("\n=== MIROVA all alerts ===")
    for r in get_mirova_alerts():
        print(f"  {'[TARGET] ' if r['is_target'] else ''}{r['volcano']}: {r['vrp_mw']} MW ({r['time']})")

    print("\n=== VAA volcano list ===")
    vlist = get_ash_volcano_list()
    print(f"Total volcanoes with ash data: {len(vlist)}")
    print(vlist.head(10))

    print("\n=== VAA data (Sakurajima, last 1 year) ===")
    df = get_ash_data(volcano_number=282080)
    print(f"Rows: {len(df)}")
    print(df[["volcano_name", "eruption_dt", "ash_height_km"]].head(10))

# --- Darwin VAAC (BoM): 24-hour advisory list; separate from Tokyo source ---
DARWIN_VAAC_URL = "https://www.bom.gov.au/aviation/volcanic-ash/darwin-va-advisory.shtml"
DARWIN_VAAC_FTP = "ftp://ftp.bom.gov.au/anon/gen/vaac/"

def _parse_darwin_vaa(text, detail_url=None):
    """Parse one ICAO VAA bulletin; only include identified volcanoes."""
    import re
    def field(key):
        m = re.search(r"(?im)^\s*" + re.escape(key) + r"\s*:\s*(.*)$", text)
        return m.group(1).strip() if m else ""
    volcano_field = field("VOLCANO")
    if not volcano_field:
        return None
    volcano = re.sub(r"\s+\d{6}\s*$", "", volcano_field).strip()
    advisory = field("ADVISORY NR")
    dtg = field("DTG")
    details = field("ERUPTION DETAILS")
    next_adv = field("NXT ADVISORY")
    # BoM's feed carries the bulletins of several VAACs (Darwin, Washington, Wellington, Tokyo ...).
    # Each bulletin names its issuing centre in the "VAAC:" line: use it as the source, instead of
    # calling everything "Darwin VAAC".
    issuer = field("VAAC")
    source = (issuer.title() + " VAAC") if issuer else "Darwin VAAC"
    return dict(volcano=volcano, advisory=advisory, eruption=details,
                datetime=dtg, detail_url=detail_url, source=source, issuer=issuer,
                eruption_details=details, next_advisory=next_adv,
                is_terminal=bool(re.search(r"NO FURTHER ADVISOR", next_adv, re.I)))

DARWIN_LATEST_URL = "https://www.bom.gov.au/products/Volc_ash_latest.shtml"
DARWIN_WARNINGS_URL = "https://www.bom.gov.au/aviation/warnings/volcanic-ash/"

def _parse_darwin_bulletins(page_text, detail_url):
    """Split a concatenated BoM bulletin feed at each VA ADVISORY header."""
    import re
    blocks = re.split(r"(?im)^\s*VA ADVISORY\s*$", page_text)
    result = []
    for block in blocks[1:]:
        # The next bulletin's Received header may occur before its VA ADVISORY.
        row = _parse_darwin_vaa(block, detail_url)
        if row and row.get("datetime") and row.get("advisory"):
            result.append(row)
    return result

def get_darwin_vaac_table():
    """Read Darwin VAAC bulletins from BoM's published 24-hour text feed.

    The older darwin-va-advisory.shtml can show stale 'Nil current' HTML;
    do not use it to suppress results from the live product feed.
    """
    from bs4 import BeautifulSoup
    feeds = [DARWIN_LATEST_URL, DARWIN_WARNINGS_URL]
    results = []
    for url in feeds:
        try:
            def parse(response, url=url):
                soup = BeautifulSoup(response.content, "html.parser")
                for tag in soup(["script", "style"]):
                    tag.decompose()
                return _parse_darwin_bulletins(soup.get_text("\n", strip=True), url)
            # ETag/body-hash check avoids re-parsing an unchanged feed.
            rows, _changed = cached_http_parse(url, parse, timeout=20, verify=VERIFY_SSL,
                                               headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
            if rows:
                results.extend(rows)
                break  # first working official feed wins
            print(f"[Darwin VAAC] No parsable bulletins at {url}")
        except Exception as exc:
            print(f"[Darwin VAAC] {url}: {exc}")
    unique = {}
    for row in results:
        key = (row["volcano"].casefold(), row["advisory"], row["datetime"])
        unique[key] = row
    print(f"[Darwin VAAC] Parsed {len(unique)} advisories")
    return list(unique.values())

def get_combined_vaac_table():
    """Return Tokyo + Darwin advisories with source and normalized fields."""
    tokyo = get_vaac_table()
    for r in tokyo:
        r.setdefault("source", "Tokyo VAAC")
    return tokyo + get_darwin_vaac_table()
