"""Step 2b: fire region, parent group and province for every display cell (H3 res 5).

Fire regions = the 15 terrestrial ecozones of Canada (Ecological Stratification Working
Group, AAFC). Ecozones combine climate, landform and vegetation, which are what set fire
regimes, and they are the national standard frame for reporting fire statistics. Thin
strata are merged into a parent group of neighbouring, similar ecozones:

  north      Arctic Cordillera, Northern Arctic, Southern Arctic, Taiga Plain,
             Taiga Shield, Taiga Cordillera, Hudson Plain
  boreal     Boreal Shield, Boreal Plain, Boreal Cordillera
  west       Montane Cordillera, Pacific Maritime
  south      Prairie, Mixedwood Plain, Atlantic Maritime

Provinces and territories (Natural Earth 1:50m admin-1) are used only for validation at
province scale. A cell is assigned by its centre; centres off the polygons (coast, large
lakes) take the nearest polygon.

Output: data/interim/regions_cell5.parquet (cell5, region, parent, province, lat, lon)
"""
from __future__ import annotations

import geopandas as gpd
import h3
import numpy as np
import pandas as pd

import config as C

EXT = C.DATA / "external"
PARENT = {
    "Arctic Cordillera": "north", "Northern Arctic": "north", "Southern Arctic": "north",
    "Taiga Plain": "north", "Taiga Shield": "north", "Taiga Cordillera": "north", "Hudson Plain": "north",
    "Boreal Shield": "boreal", "Boreal Plain": "boreal", "Boreal Cordillera": "boreal",
    "Montane Cordillera": "west", "Pacific Maritime": "west",
    "Prairie": "south", "Mixedwood Plain": "south", "Atlantic Maritime": "south",
}
EQUAL_AREA = "EPSG:3978"  # Canada Atlas Lambert


def assign(points: gpd.GeoDataFrame, polys: gpd.GeoDataFrame, col: str) -> pd.Series:
    j = gpd.sjoin(points, polys[[col, "geometry"]], how="left", predicate="within")
    j = j[~j.index.duplicated()]
    miss = j[col].isna()
    if miss.any():
        near = gpd.sjoin_nearest(points[miss].to_crs(EQUAL_AREA), polys[[col, "geometry"]].to_crs(EQUAL_AREA),
                                 how="left")
        near = near[~near.index.duplicated()]
        j.loc[miss, col] = near[col]
    return j[col]


def main() -> None:
    cells = np.unique(pd.read_parquet(C.INTERIM / "cell_days_monthly.parquet", columns=["cell5"])["cell5"])
    f = h3.api.basic_int.cell_to_latlng
    ll = np.array([f(int(c)) for c in cells])
    pts = gpd.GeoDataFrame({"cell5": cells, "lat": ll[:, 0], "lon": ll[:, 1]},
                           geometry=gpd.points_from_xy(ll[:, 1], ll[:, 0]), crs="EPSG:4326")

    eco = gpd.read_file(EXT / "ecozones" / "ecozones.shp").to_crs("EPSG:4326")
    eco["region"] = eco["ZONE_NAME"].str.strip().str.replace("PLain", "Plain").str.replace(r"\s+", " ", regex=True)
    eco["region"] = eco["region"].replace({"MixedWood Plain": "Mixedwood Plain", "Mixedwood Plains": "Mixedwood Plain", "Hudson Plains": "Hudson Plain",
                                           "Prairies": "Prairie", "Taiga Plains": "Taiga Plain"})
    unknown = set(eco["region"]) - set(PARENT)
    if unknown:
        raise ValueError(f"ecozone names not in PARENT: {sorted(unknown)}")
    eco = eco.dissolve("region").reset_index()

    prov = gpd.read_file(EXT / "ne_admin1" / "ne_50m_admin_1_states_provinces.shp")
    prov = prov[prov["admin"] == "Canada"].rename(columns={"name": "province"}).to_crs("EPSG:4326")

    pts["region"] = assign(pts, eco, "region")
    pts["parent"] = pts["region"].map(PARENT)
    pts["province"] = assign(pts, prov, "province")
    out = pd.DataFrame(pts.drop(columns="geometry"))
    out.to_parquet(C.INTERIM / "regions_cell5.parquet", index=False)
    print(out.groupby(["parent", "region"]).size().to_string())
    print(out.province.value_counts().to_string())


if __name__ == "__main__":
    main()
