"""Step 2a: land-cover class for every ~1 km fire cell, from ESA WorldCover 2021 (v200).

WorldCover is a 10 m product in 3 x 3 degree Cloud-Optimised GeoTIFF tiles on a public
bucket. We read the built-in 1/32 overview (~300 m pixels) of each tile that contains
fire cells, reduce each pixel to four classes, and give each H3 res 8 cell the majority
class of the 3 x 3 overview pixels around its centre (~0.9 km window, about one cell).
Water is kept apart while sampling: a cell whose majority is water (typically a lakeshore
fire) takes the most common land class in the 3 x 3 window, then in a 7 x 7 window
(~2 km). Only if both windows are all water does it stay "other".

Class reduction (WorldCover code -> class)
  10 tree cover                                   -> forest
  20 shrubland, 30 grassland, 90 herbaceous
     wetland, 100 moss and lichen                 -> grass_shrub   (low, burnable vegetation)
  40 cropland                                     -> cropland
  50 built-up, 60 bare/sparse, 70 snow/ice,
     95 mangroves, no tile (sea)                  -> other
  80 water                                        -> nearest land class (see above)

Output: data/interim/landcover_cell8.parquet  (cell8, lc)
"""
from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor

import h3
import numpy as np
import pandas as pd
import rasterio
from rasterio.errors import RasterioIOError

import config as C

URL = ("/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
       "ESA_WorldCover_10m_2021_v200_{tile}_Map.tif")
OVERVIEW_LEVEL = 4  # 0-based index into overviews [2, 4, 8, 16, 32, 64] -> factor 32
CLASSES = ["forest", "grass_shrub", "cropland", "other"]
WATER = 4
LUT = np.full(256, 3, dtype=np.uint8)
LUT[80] = WATER
LUT[10] = 0
LUT[[20, 30, 90, 100]] = 1
LUT[40] = 2
GDAL_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                GDAL_HTTP_MAX_RETRY="4", GDAL_HTTP_RETRY_DELAY="2")


def tile_name(lat: float, lon: float) -> str:
    la = int(math.floor(lat / 3) * 3)
    lo = int(math.floor(lon / 3) * 3)
    return f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"


def classify_tile(tile: str, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    try:
        with rasterio.Env(**GDAL_ENV), rasterio.open(URL.format(tile=tile), overview_level=OVERVIEW_LEVEL) as r:
            grp = LUT[r.read(1)]
            rows, cols = rasterio.transform.rowcol(r.transform, lon, lat)
    except RasterioIOError:
        return np.full(len(lat), 3, dtype=np.uint8)  # no tile: open water / sea
    rows, cols = np.asarray(rows), np.asarray(cols)
    h, w = grp.shape
    n = len(lat)

    def window_counts(r: int) -> np.ndarray:
        counts = np.zeros((n, 5), dtype=np.int16)
        for dr in range(-r, r + 1):
            for dc in range(-r, r + 1):
                rr = np.clip(rows + dr, 0, h - 1)
                cc = np.clip(cols + dc, 0, w - 1)
                np.add.at(counts, (np.arange(n), grp[rr, cc]), 1)
        return counts

    c3 = window_counts(1)
    out = c3.argmax(axis=1)  # ties go to the lower code (forest first)
    water = out == WATER
    land3 = c3[:, :4]  # forest, grass_shrub, cropland, other land
    has_land3 = land3.sum(axis=1) > 0
    out = np.where(water & has_land3, land3.argmax(axis=1), out)
    still = water & ~has_land3
    if still.any():
        land7 = window_counts(3)[:, :4]
        has_land7 = land7.sum(axis=1) > 0
        out = np.where(still & has_land7, land7.argmax(axis=1), out)
        out = np.where(still & ~has_land7, 3, out)
    return out.astype(np.uint8)


def main() -> None:
    cells = pd.read_parquet(C.INTERIM / "cell_days_fine.parquet", columns=["cell8"])["cell8"].unique()
    f = h3.api.basic_int.cell_to_latlng
    ll = np.array([f(int(c)) for c in cells])
    df = pd.DataFrame({"cell8": cells, "lat": ll[:, 0], "lon": ll[:, 1]})
    df["tile"] = [tile_name(a, b) for a, b in zip(df.lat, df.lon)]
    groups = list(df.groupby("tile").indices.items())
    print(f"{len(df):,} fire cells in {len(groups)} WorldCover tiles", flush=True)

    out = np.zeros(len(df), dtype=np.uint8)

    def work(item):
        tile, idx = item
        return idx, classify_tile(tile, df.lat.to_numpy()[idx], df.lon.to_numpy()[idx])

    done = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for idx, cls in ex.map(work, groups):
            out[idx] = cls
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(groups)} tiles", flush=True)

    res = pd.DataFrame({"cell8": df.cell8.to_numpy(),
                        "lc": pd.Categorical.from_codes(out, categories=CLASSES)})
    res.to_parquet(C.INTERIM / "landcover_cell8.parquet", index=False)
    print(res.lc.value_counts().to_string())


if __name__ == "__main__":
    main()
