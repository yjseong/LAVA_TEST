"""Best-effort public official volcano alert collectors.

No fabricated levels: unknown HTML formats raise errors and preserve the cache.
The KVERT public Telegram mirror is a fallback for the official VAN text, not a
claim that the official website is always reachable. A bounded recent-post feed
cannot establish current codes for volcanoes absent from the feed.
"""
import re
from datetime import datetime, timezone
from bs4 import BeautifulSoup
import requests
import os
import warnings
from requests.exceptions import SSLError
from urllib3.exceptions import InsecureRequestWarning
import truststore

truststore.inject_into_ssl()

PVMBG_URL = 'https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas'
KVERT_URL = 'http://kvert.febras.net/van/'
KVERT_ARCHIVE_URL = 'http://kvert.febras.net/van/index?type=2'
KVERT_MIRROR = 'https://t.me/s/ivsfebras_kvert'
KVERT_MIRROR_ALT = 'https://telegram.me/s/ivsfebras_kvert'
HEADERS = {'User-Agent':'Mozilla/5.0 (compatible; VolcanoAlertDashboard/1.0)'}


def _fetch(url):
    """HTTPS verification on by default; explicit per-source fallback only.

    Set VOLCANO_PVMBG_ALLOW_UNVERIFIED=1 ONLY after checking the host and
    certificate chain in your network. Unverified data are marked in logs.
    """
    # magma.esdm.go.id is slow at times: the TLS handshake alone can take more than 7 s (requests reports
    # that as a "read" timeout, because the handshake runs under the connect timeout). A generous timeout
    # and one retry keep a slow minute from becoming a failed refresh. The other sources keep 7 s / 18 s, one try.
    slow_host = 'magma.esdm.go.id' in url
    timeout, tries = ((15, 25), 2) if slow_host else ((7, 18), 1)
    response = None
    for attempt in range(1, tries + 1):
        try:
            response = requests.get(url, timeout=timeout, headers=HEADERS)
            break
        except SSLError:
            break                       # a certificate problem: retrying does not help, handled below
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError):
            if attempt == tries:
                raise
    if response is None:                # SSLError
        if 'magma.esdm.go.id' not in url or os.getenv('VOLCANO_PVMBG_ALLOW_UNVERIFIED') != '1':
            raise RuntimeError('PVMBG TLS certificate verification failed. Check proxy/CA trust, '
                               'or explicitly set VOLCANO_PVMBG_ALLOW_UNVERIFIED=1 '
                               'for a temporary, unverified fallback.')
        warnings.warn('PVMBG TLS verification DISABLED by explicit opt-in; data integrity not guaranteed', RuntimeWarning)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', InsecureRequestWarning)
            response = requests.get(url, timeout=(7, 18), headers=HEADERS, verify=False)
    response.raise_for_status()
    if len(response.content) < 100:
        raise ValueError('Unexpectedly short response from ' + url)
    return response.text


# Explicit MAGMA name -> Smithsonian GVP number crosswalk. Do not fuzzy-match.
# Entries are restricted to identifiers present in the supplied volcano master.
PVMBG_NAME_ALIASES = {
    'anak krakatau': 262000, 'anak ranakah': 264071,
    'bromo': 263310, 'bur ni telong': 261050,
    'ili lewotolok': 264230, 'lewotobi laki-laki': 264180,
    'lewotobi perempuan': 264180, 'lokon': 266100,
    'tangkoko': 266130, 'batutara': 264260,
    'dieng': 263200, 'gede': 263060,
    'ile werung': 264250, 'lereboleng': 264200,
    'peut sague': 261030, 'rokatenda': 264150,
    'tandikat': 261150,
}


def parse_pvmbg(html, index):
    """Read the MAGMA activity table, including its row-spanned level sections.

    Only volcano rows containing an official report link are considered.
    The reported count for each section is checked against parsed rows; an
    incomplete or changed page raises rather than replacing a good snapshot.
    """
    soup = BeautifulSoup(html, 'html.parser')
    table = next((t for t in soup.select('table')
                  if 'Daftar Tingkat Aktivitas Gunung Api' in
                  t.parent.get_text(' ', strip=True)[:250]), None)
    if table is None:
        # Restrict fallback to a table explicitly containing activity levels.
        table = next((t for t in soup.select('table')
                      if 'Level III (Siaga)' in t.get_text(' ', strip=True)
                      and 'Level II (Waspada)' in t.get_text(' ', strip=True)), None)
    if table is None:
        raise ValueError('PVMBG official activity-level table not found')

    current_level = None
    declared = {}
    observed = {1: 0, 2: 0, 3: 0, 4: 0}
    result = {}
    for tr in table.select('tr'):
        cells = tr.find_all('td', recursive=False)
        if not cells:
            continue
        first = cells[0].get_text(' ', strip=True)
        m = re.search(r'\bLevel\s*(IV|III|II|I)\s*\((Awas|Siaga|Waspada|Normal)\)', first, re.I)
        if m:
            roman = m.group(1).upper()
            current_level = {'I': 1, 'II': 2, 'III': 3, 'IV': 4}[roman]
            if len(cells) >= 2:
                count = cells[1].get_text(' ', strip=True)
                if not count.isdigit():
                    raise ValueError('PVMBG level count is not numeric')
                declared[current_level] = int(count)
        if current_level is None:
            continue
        for td in cells:
            if not td.find('a', href=re.compile(r'/gunung-api/laporan/')):
                continue
            # The volcano's plain text precedes the report link.
            label = td.get_text(' ', strip=True)
            name = label.split(' - ', 1)[0].strip()
            if not name or name.lower().startswith('lihat laporan'):
                continue
            observed[current_level] += 1
            key = re.sub(r'\s+', ' ', name).casefold()
            number = index.resolve(name=name, country='Indonesia')
            if number is None and key == 'sumbing':
                # The master contains two Indonesian Sumbing volcanoes.
                number = 263220 if 'Jawa Tengah' in label else None
            if number is None:
                candidate = PVMBG_NAME_ALIASES.get(key)
                if candidate is not None:
                    number = index.resolve(volcano_number=candidate)
            if number is None:
                continue
            entry = {
                'volcano_number': number, 'alert_type': 'volcano_level',
                'level': str(current_level),
                'label': 'PVMBG Level ' + ['','I (Normal)', 'II (Waspada)',
                                          'III (Siaga)', 'IV (Awas)'][current_level],
                'source_url': PVMBG_URL,
                'raw': {'name': name, 'row': label, 'level': current_level},
            }
            previous = result.get(number)
            if previous is None:
                result[number] = entry
            elif previous['level'] != entry['level']:
                # E.g. Lewotobi Laki-laki and Perempuan share one GVP number.
                # A single marker cannot represent both: use the higher level
                # conservatively, while retaining the component-level evidence.
                components = previous['raw'].setdefault('components', [
                    {'name': previous['raw']['name'], 'level': int(previous['level'])}])
                components.append({'name': name, 'level': current_level})
                if current_level > int(previous['level']):
                    entry['raw']['components'] = components
                    result[number] = entry
            else:
                previous['raw'].setdefault('components', [
                    {'name': previous['raw']['name'], 'level': int(previous['level'])}]
                ).append({'name': name, 'level': current_level})
    if set(declared) != {1, 2, 3, 4} or any(
            observed[level] != declared[level] for level in (1, 2, 3, 4)):
        raise ValueError('PVMBG table incomplete: declared=' + str(declared)
                         + ', parsed=' + str(observed))
    if not result:
        raise ValueError('PVMBG table parsed but no volcanoes matched the master')
    return list(result.values())


def collect_pvmbg(index):
    text = _fetch(PVMBG_URL)
    rows = parse_pvmbg(text,index)
    if not rows:
        raise ValueError('PVMBG layout unrecognized or no matched rows; keeping prior snapshot')
    return rows


PHIVOLCS_URL = 'https://wovodat.phivolcs.dost.gov.ph/bulletin/list-of-bulletin'
# Volcano Alert Levels 0-5 (names: phivolcs.dost.gov.ph/volcano-alert-levels)
PHIVOLCS_LEVEL_NAMES = {
    0: 'No alert / Normal', 1: 'Low-level unrest', 2: 'Increasing unrest',
    3: 'Intensified / magmatic unrest', 4: 'Eruption imminent',
    5: 'Hazardous eruption in progress',
}


def parse_phivolcs(html, index):
    """Read the 'Alert Level Status' ticker, e.g. <span class="scroll-item">Taal - 1</span>.

    Only entries whose name resolves to a Philippine volcano in the master and
    whose level is 0-5 are accepted; anything else is ignored, never guessed.
    """
    soup = BeautifulSoup(html, 'html.parser')
    rows = []
    for span in soup.select('#scroll-text .scroll-item'):
        m = re.match(r'^\s*([A-Za-z][A-Za-z\- ]+?)\s*-\s*(\d)\s*$', span.get_text(' ', strip=True))
        if not m:
            continue
        name, level = m.group(1).strip(), int(m.group(2))
        if level not in PHIVOLCS_LEVEL_NAMES:
            continue
        n = index.resolve(name=name, country='Philippines')
        if n is None:
            continue
        rows.append({'volcano_number': n, 'alert_type': 'volcano_level', 'level': str(level),
                     'label': f'PHIVOLCS Alert Level {level} · {PHIVOLCS_LEVEL_NAMES[level]}',
                     'issued_at': None, 'source_url': PHIVOLCS_URL,
                     'raw': {'name': name, 'level': level}})
    return rows


def collect_phivolcs(index):
    rows = parse_phivolcs(_fetch(PHIVOLCS_URL), index)
    if not rows:
        raise ValueError('PHIVOLCS layout unrecognized or no matched rows; keeping prior snapshot')
    return rows


def parse_kvert_daily_report(html, index, source_url=KVERT_URL):
    """Parse KVERT Daily Report: VOLCANO (CAVW #NNNNNN) + Aviation Colour Code.

    Only codes inside the report's volcano heading are accepted; the legend
    elsewhere on the page must never be interpreted as an active alert.
    """
    soup = BeautifulSoup(html, 'html.parser')
    reports = []
    for tag in soup.find_all(['div', 'td']):
        # Report body is a div containing a bold KVERT DAILY REPORT header.
        # Avoid nested containers that would duplicate the same report.
        bolds = tag.find_all('b', recursive=False)
        if bolds and any('KVERT DAILY REPORT' in b.get_text(' ', strip=True).upper() for b in bolds):
            reports.append(tag)
    latest = {}
    for report in reports:
        header = report.get_text(' ', strip=True)[:220]
        date_match = re.search(r'\b([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s*,?\s*all time is UTC', header, re.I)
        if not date_match:
            continue
        try:
            dt = datetime.strptime(date_match.group(1), '%B %d, %Y').replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        for bold in report.find_all('b'):
            heading = bold.get_text(' ', strip=True)
            m = re.search(r'([A-Za-z][A-Za-z\- ]+?)\s+VOLCANO\s*\(\s*CAVW\s*#\s*(\d{6})\s*\)', heading, re.I)
            c = re.search(r'Aviation\s+Colou?r\s+Code\s+is\s*(GREEN|YELLOW|ORANGE|RED)\b', heading, re.I)
            if not (m and c):
                continue
            name, number, code = m.group(1).strip(), m.group(2), c.group(1).upper()
            n = index.resolve(volcano_number=number, name=name)
            if n is None:
                continue
            item = {'volcano_number': n, 'alert_type': 'aviation_code',
                    'level': code, 'label': 'KVERT ' + code,
                    'issued_at': dt.isoformat(), 'source_url': source_url,
                    'raw': {'name': name, 'cavw': number, 'code': code,
                            'report_date_utc': dt.date().isoformat(), 'report_type': 'daily'}}
            if n not in latest or item['issued_at'] >= latest[n]['issued_at']:
                latest[n] = item
    return list(latest.values())


def parse_kvert_vans(html, index, source_url=KVERT_URL):
    """Parse both numbered KVERT VANs and newer abbreviated VONA bulletins.

    Extract one bulletin at a time; choose latest issue per volcano. Never
    infer current status from a previous colour code or from article prose.
    """
    daily = parse_kvert_daily_report(html, index, source_url)
    if daily:
        return daily
    soup = BeautifulSoup(html, 'html.parser')
    blocks = soup.select('.tgme_widget_message_text')
    if blocks:
        texts = [b.get_text('\n', strip=True) for b in blocks]
    else:
        for tag in soup(['script', 'style', 'nav', 'footer']):
            tag.decompose()
        raw = soup.get_text('\n', strip=True)
        texts = re.split(r'(?=\(1\)\s*KVERT\s+VOLCANIC\s+ACTIVITY\s+NOTICE|\bVONA\s+DTG\s*:)', raw, flags=re.I)
    latest = {}
    for text in texts:
        # Some Telegram messages have multiple bulletins; split on (1).
        notices = re.split(r'(?=\(1\)\s*KVERT\s+VOLCANIC\s+ACTIVITY\s+NOTICE)', text, flags=re.I)
        for notice in notices:
            number_match = re.search(r'(?:CAVW\s*#|VOLCANO\s*:\s*[^\n]*?\b)(\d{6})\b', notice, re.I)
            name_match = re.search(r'\(3\)\s*Volcano\s*:\s*([^\n(]+)', notice, re.I)
            if not name_match:
                name_match = re.search(r'\bVOLCANO\s*:\s*([A-Za-z][A-Za-z\- ]+?)\s+\d{6}\b', notice, re.I)
            code_match = re.search(r'(?:\(4\)\s*)?Current\s+(?:aviation\s+)?colou?r\s+code\s*:\s*(GREEN|YELLOW|ORANGE|RED)', notice, re.I)
            time_match = re.search(r'(?:\(2\)\s*Issued|\bDTG)\s*:\s*(\d{8})\s*/\s*(\d{4})Z', notice, re.I)
            if not (code_match and time_match and (number_match or name_match)):
                continue
            name = name_match.group(1).strip() if name_match else ''
            n = index.resolve(volcano_number=number_match.group(1) if number_match else None, name=name)
            if not n:
                continue
            try:
                dt = datetime.strptime(time_match.group(1)+time_match.group(2), '%Y%m%d%H%M').replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            code = code_match.group(1).upper()
            item = {'volcano_number': n, 'alert_type': 'aviation_code', 'level': code,
                    'label': 'KVERT ' + code, 'issued_at': dt.isoformat(),
                    'source_url': source_url, 'raw': {'name': name, 'code': code}}
            if n not in latest or item['issued_at'] > latest[n]['issued_at']:
                latest[n] = item
    return list(latest.values())


def collect_kvert(index):
    errors=[]
    merged={}
    for url in (KVERT_URL, KVERT_ARCHIVE_URL, KVERT_MIRROR, KVERT_MIRROR_ALT):
        try:
            rows = parse_kvert_vans(_fetch(url),index,url)
            if rows:
                for item in rows:
                    key=item['volcano_number']
                    if key not in merged or item['issued_at'] > merged[key]['issued_at']:
                        merged[key]=item
                # A valid official Daily Report is sufficient; avoid overwriting
                # it with a delayed Telegram mirror or stale archive notice.
                if url == KVERT_URL:
                    return list(merged.values())
            else:
                errors.append(url+': no recognized notices')
        except Exception as exc:
            errors.append(url+': '+str(exc)[:180])
    if merged:
        return list(merged.values())
    raise RuntimeError(' | '.join(errors))
