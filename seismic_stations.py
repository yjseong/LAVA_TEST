"""Hi-net stations behind the graphs of the Seismic page.

Graph titles name the station ("RSAM — V.SKA2"), not the volcano, so it is clear which station a curve comes from.
The table is the `seismic_station` / `infra_station` of each volcano in server_scripts/load_5volcano.py - keep the two
in sync when the loader's stations change (and note the change date below).

  * RSAM, SSAM, band amplitude, FI and DSAR come from the seismic station.
  * Peak pressure comes from the infrasound station (the same sensor name for some volcanoes).

Station changes inside the data (RSAM / SSAM / band / infra CSVs mix the old and the new station from that moment on,
with a level shift):
  * Asosan        RSAM / SSAM / band: V.ASO2 -> V.ASOA from 2026-10-14 23:00 UTC
  * Sakurajima    RSAM / SSAM / band / infra: V.SFT2 -> V.SKA2 from 2026-10-16
The titles show the CURRENT station.
"""

SEISMIC_STATION = {
    "Asosan": "V.ASOA",
    "Kirishimayama": "V.KIRA",
    "Sakurajima": "V.SKA2",
    "Kuchinoerabujima": "V.KEHT",
    "Ontakesan": "V.ONTA",
}

INFRA_STATION = {
    "Asosan": "V.ASO2",
    "Kirishimayama": "V.KIAM",
    "Sakurajima": "V.SKA2",
    "Kuchinoerabujima": "V.KEHT",
    "Ontakesan": "V.ONTA",
}


def seismic_station(volcano):
    """Station of the seismic curves (the volcano's name if it is not in the table)."""
    return SEISMIC_STATION.get(volcano, volcano)


def infra_station(volcano):
    """Station of the infrasound (peak pressure) curve."""
    return INFRA_STATION.get(volcano, volcano)
