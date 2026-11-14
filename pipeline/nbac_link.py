"""Link fire cells to NBAC burned-area polygons, per year, to get the size of the fire.

NBAC (National Burned Area Composite, CWFIS, Open Government Licence - Canada): one zip per
year in data/external/nbac/. Fire size = sum of ADJ_HA over polygons sharing NFIREID;
prescribed burns are excluded. A ~1 km cell (H3 res 8) is linked to a fire if its centre is
within LINK_M metres of that year's polygon (detections at fire edges sit just outside); if
several fires match, the largest is kept.

Output: data/interim/nbac_cell8_year.parquet (cell8, year, fire_ha)
"""
from __future__ import annotations

import zipfile

import geopandas as gpd
import h3
import numpy as np
import pandas as pd

import config as C

NBAC = C.DATA / "external" / "nbac"
LINK_M = 1000


def read_year(y: int) -> gpd.GeoDataFrame | None:
    zs = sorted(NBAC.glob(f"NBAC_{y}_*.zip"))
    if not zs:
        return None
    d = NBAC / f"x{y}"
    if not list(d.glob("*.shp")):
        with zipfile.ZipFile(zs[-1]) as zf:
            for m in zf.namelist():
                if m.endswith((".shp", ".shx", ".dbf", ".prj", ".cpg")):
                    zf.extract(m, d)
    shp = next(d.rglob("*.shp"))
    g = gpd.read_file(shp, columns=["NFIREID", "ADJ_HA", "PRESCRIBED"])
    g = g[g["PRESCRIBED"].isna() | ~g["PRESCRIBED"].astype(str).str.strip().str.lower().isin(["pb", "yes", "y", "1", "true"])]
    size = g.groupby("NFIREID")["ADJ_HA"].sum()
    g["fire_ha"] = g["NFIREID"].map(size)
    return g[["fire_ha", "geometry"]]


def main() -> None:
    fine = pd.read_parquet(C.INTERIM / "cell_days_fine.parquet", columns=["cell8", "year"])
    cy = fine.drop_duplicates().reset_index(drop=True)
    del fine
    out = []
    for y in sorted(cy.year.unique()):
        g = read_year(int(y))
        if g is None:
            print(f"{y}: no NBAC file", flush=True)
            continue
        cells = cy.loc[cy.year == y, "cell8"].to_numpy()
        ll = np.array([h3.api.basic_int.cell_to_latlng(int(c)) for c in cells])
        pts = gpd.GeoDataFrame({"cell8": cells}, geometry=gpd.points_from_xy(ll[:, 1], ll[:, 0]), crs="EPSG:4326").to_crs(g.crs)
        j = gpd.sjoin(pts, g, how="inner", predicate="dwithin", distance=LINK_M)
        best = j.groupby("cell8")["fire_ha"].max().reset_index()
        best["year"] = int(y)
        out.append(best)
        print(f"{y}: {len(g):,} polygons, {len(best):,}/{len(cells):,} fire cells linked ({100*len(best)/len(cells):.0f}%)", flush=True)
    res = pd.concat(out, ignore_index=True)
    res.to_parquet(C.INTERIM / "nbac_cell8_year.parquet", index=False)


if __name__ == "__main__":
    main()
