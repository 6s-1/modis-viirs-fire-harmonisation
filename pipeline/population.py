"""Population and place names for the app's summary and exposure list.

Population: WorldPop 2020, 1 km, UN-adjusted, Canada (CC BY 4.0). A modelled estimate of where
people live, not a census count. Each 1 km pixel is assigned to the H3 cell containing its centre.

Outputs (data/processed/):
  population_cell5.parquet   cell5, pop                      people living in each display cell
  population_fire.parquet    cell5, year_mask, pop            people in ~1 km cells (H3 res 8) that had
                                                               at least one fire cell-day; bit k of
                                                               year_mask = fire in year 2000 + k
  places.parquet             name, lat, lon, pop, province   GeoNames places >= 500 people in Canada
"""
from __future__ import annotations

import zipfile

import h3
import numpy as np
import pandas as pd
import rasterio

import config as C

EXT = C.DATA / "external"
OUT = C.DATA / "processed"
WORLDPOP = EXT / "worldpop" / "can_ppp_2020_1km_Aggregated_UNadj.tif"
GEONAMES = EXT / "geonames" / "cities500.zip"
PROVINCE = {"01": "AB", "02": "BC", "03": "MB", "04": "NB", "05": "NL", "07": "NS", "08": "ON", "09": "PE",
            "10": "QC", "11": "SK", "12": "YT", "13": "NT", "14": "NU"}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with rasterio.open(WORLDPOP) as r:
        a = r.read(1)
        rows, cols = np.nonzero(a > 0)
        pop = a[rows, cols].astype("float64")
        xs, ys = rasterio.transform.xy(r.transform, rows, cols)
    lat, lon = np.asarray(ys), np.asarray(xs)
    f = h3.api.basic_int.latlng_to_cell
    c8 = np.fromiter((f(y, x, C.FINE_RES) for y, x in zip(lat, lon)), np.uint64, len(lat))
    p8 = pd.DataFrame({"cell8": c8, "pop": pop}).groupby("cell8").pop.sum()
    par = h3.api.basic_int.cell_to_parent
    c5 = pd.Series({c: par(int(c), C.DISPLAY_RES) for c in p8.index}, dtype="uint64")
    pop5 = p8.groupby(c5.reindex(p8.index).to_numpy()).sum()
    pd.DataFrame({"cell5": pop5.index.astype("uint64"), "pop": pop5.to_numpy()}).to_parquet(OUT / "population_cell5.parquet", index=False)
    print(f"total population {pop.sum():,.0f} in {len(p8):,} ~1 km cells, {len(pop5):,} display cells")

    fire = pd.read_parquet(C.INTERIM / "cell_days_fine.parquet", columns=["cell8", "year"]).drop_duplicates()
    fire["bit"] = (np.uint32(1) << (fire.year.astype("uint32") - np.uint32(2000))).astype("uint32")
    mask = fire.groupby("cell8").bit.agg(lambda b: np.bitwise_or.reduce(b.to_numpy()))
    j = pd.DataFrame({"pop": p8}).join(mask.rename("year_mask"), how="inner")
    j["cell5"] = c5.reindex(j.index).to_numpy()
    rows_ = j.groupby(["cell5", "year_mask"]).pop.sum().reset_index()
    rows_.to_parquet(OUT / "population_fire.parquet", index=False)
    print(f"people in ~1 km cells that had fire at any time: {j['pop'].sum():,.0f} ({len(j):,} cells, {len(rows_):,} rows)")

    with zipfile.ZipFile(GEONAMES) as zf, zf.open("cities500.txt") as fh:
        g = pd.read_csv(fh, sep="\t", header=None, low_memory=False, usecols=[1, 4, 5, 8, 10, 14],
                        names=["name", "lat", "lon", "country", "admin1", "pop"])
    g = g[g.country == "CA"].copy()
    g["province"] = g.admin1.astype(str).str.zfill(2).map(PROVINCE).fillna("")
    g[["name", "lat", "lon", "pop", "province"]].to_parquet(OUT / "places.parquet", index=False)
    print(f"{len(g):,} places in Canada with >= 500 people")


if __name__ == "__main__":
    main()
