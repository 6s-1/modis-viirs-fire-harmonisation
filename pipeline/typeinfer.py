"""Infer the FIRMS `type` for near-real-time rows, which come without that column.

FIRMS types: 0 presumed vegetation fire, 2 other static land source, 3 offshore / over
water (in Canada mostly large lakes). For rows without a type:
  type 2  if the ~1 km cell (H3 res 8) had >= STATIC_SHARE of its historical detections
          flagged type 2 in the standard record (gas flares, industry, ...)
  type 0  otherwise
Checked on the 2026 archive files, where the true type is known: this catches ~90% of
type 2 and removes ~0.1% of true type 0 rows, but cannot find type 3, so ~2.7% of VIIRS
NRT rows (~0.1% for MODIS) are over-water detections kept as fires. A WorldCover water
mask at ~300 m was tried and rejected: it dropped ~3.5% of true fires on lakeshores.
"""
from __future__ import annotations

import h3
import numpy as np
import pandas as pd

import config as C

STATIC_SHARE = 0.5
STATIC_FILE = C.INTERIM / "static_source_cells.parquet"


def cells8(lat, lon) -> np.ndarray:
    f = h3.api.basic_int.latlng_to_cell
    return np.fromiter((f(a, b, C.FINE_RES) for a, b in zip(lat, lon)), np.uint64, len(lat))


def build_static_cells(frames: list[pd.DataFrame]) -> pd.DataFrame:
    """frames: per-file DataFrames with latitude, longitude, type (standard record only)."""
    parts = []
    for d in frames:
        parts.append(pd.DataFrame({"cell8": cells8(d.latitude.to_numpy(), d.longitude.to_numpy()),
                                   "t2": d["type"].eq(2).to_numpy()}).groupby("cell8").t2.agg(["size", "sum"]))
    s = pd.concat(parts).groupby(level=0).sum()
    s["share"] = s["sum"] / s["size"]
    out = s[s.share >= STATIC_SHARE].reset_index()[["cell8", "size", "sum", "share"]]
    out.to_parquet(STATIC_FILE, index=False)
    return out


def infer_type(df: pd.DataFrame, static: pd.DataFrame) -> np.ndarray:
    c = cells8(df.latitude.to_numpy(), df.longitude.to_numpy())
    return np.where(np.isin(c, static["cell8"].to_numpy()), 2, 0).astype("int8")
