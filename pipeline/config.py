"""Shared settings for the harmonisation pipeline."""
from __future__ import annotations

from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "data"
RAW = DATA / "raw"
INTERIM = DATA / "interim"
REPORTS = REPO / "reports"

COUNTRY = "Canada"

# Raw sensor folders under data/raw/. Every *.csv below each folder is read,
# including the yearly summaries and anything added later under <sensor>/2026/.
SENSOR_DIRS = ["modis", "viirs-snpp", "viirs-noaa20"]

# FIRMS `satellite` codes -> platform id used in this project.
# Terra and Aqua are kept apart; so are S-NPP and NOAA-20.
SATELLITE_CODES = {
    "Terra": "terra", "T": "terra",
    "Aqua": "aqua", "A": "aqua",
    "N": "snpp", "NPP": "snpp", "Suomi NPP": "snpp",
    "N20": "noaa20", "J1": "noaa20", "1": "noaa20", "NOAA-20": "noaa20",
}
PLATFORMS = ["terra", "aqua", "snpp", "noaa20"]
INSTRUMENT = {"terra": "modis", "aqua": "modis", "snpp": "viirs", "noaa20": "viirs"}

# Period each platform contributes to the FIRMS record (inclusive, UTC dates).
# None as end = still operating; the end is then the last date present in the data.
MISSION_WINDOWS = {
    "terra": (date(2000, 11, 1), None),
    "aqua": (date(2002, 7, 4), None),     # Aqua start used for the Terra-to-Aqua table
    "snpp": (date(2012, 1, 19), date(2026, 11, 2)),  # S-NPP record ends 2 Nov 2026
    "noaa20": (date(2018, 1, 1), None),
}

# Months always flagged partial regardless of mission-window arithmetic, with the reason.
FORCED_PARTIAL = {
    ("terra", 2000, 11): "first months of the MODIS record (Terra only)",
    ("terra", 2000, 12): "first months of the MODIS record (Terra only)",
}

# Detection filters. Type 0 = presumed vegetation fire.
KEEP_TYPE = 0
# MODIS C6.1 confidence is 0-100: low < 30, nominal 30-79, high >= 80.
MODIS_MIN_CONFIDENCE = 30
# VIIRS 375 m confidence is l / n / h. Drop low; it is only ever assigned to daytime pixels
# (sun glint and low temperature anomaly cases).
VIIRS_KEEP_CONFIDENCE = {"n", "h", "nominal", "high"}

# Grids (H3).
FINE_RES = 8      # ~0.74 km2 average area, ~0.9 km across: the shared ~1 km detection grid
DISPLAY_RES = 5   # ~253 km2 average area: the display / aggregation grid
