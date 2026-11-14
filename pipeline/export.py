"""Step 3: export the harmonised table and uncertainty tables as compact static files.

Inputs:  data/processed/harmonised_cell_month.parquet, reports/calibration/month_sources.csv,
         reports/calibration/adopted_model.json, data/interim/regions_cell5.parquet
Outputs: data/processed/uncertainty.json
         web/public/harmonised/manifest.json   months, sources, regions, uncertainty, layout
         web/public/harmonised/harmonised.bin  little-endian typed arrays (layout in manifest)

harmonised.bin sections (each starts on a 4-byte boundary):
  cells   N x (uint32 h3_hi, uint32 h3_lo), float32 lat, float32 lon, uint8 region, uint8 province
  rows    R x uint16 cell index, uint16 month index, float32 cell-days   (sorted by cell, month)
The browser selects cells by centre, sums rows per month, and applies the uncertainty
factors for the selection's area. Months absent from manifest.months have no data.
"""
from __future__ import annotations

import json
from datetime import date

import geopandas as gpd
import numpy as np
import pandas as pd

import config as C
from regions import EQUAL_AREA

PROCESSED = C.DATA / "processed"
WEB = C.REPO / "web" / "public" / "harmonised"
LOW_CONFIDENCE_BELOW_KM2 = 10_000
SCALE_KEYS = {"cell": "display cell (~253 km2)", "cell3": "~12,400 km2 (H3 res 3)",
              "province": "province", "canada": "all Canada"}


def scale_areas() -> dict:
    """Nominal area (km2) of each validation scale, used to interpolate by selection area."""
    import h3
    prov = gpd.read_file(C.DATA / "external" / "ne_admin1" / "ne_50m_admin_1_states_provinces.shp")
    prov = prov[prov.admin == "Canada"].to_crs(EQUAL_AREA)
    a = prov.geometry.area / 1e6
    return {"cell": round(h3.average_hexagon_area(C.DISPLAY_RES, unit="km^2"), 1),
            "cell3": round(h3.average_hexagon_area(3, unit="km^2"), 1),
            "province": round(float(a.median()), 0),
            "canada": round(float(a.sum()), 0)}


def uncertainty(adopted: dict, areas: dict) -> dict:
    """obs/pred factors (q10, q50, q90) per scale and period for each estimated source, from
    leave-one-year-out over 2012-2025 of the adopted models (harmonise.py). For the Canada-wide
    annual scale the full held-out range (min, max) is used, so years like 2014 are inside it."""
    out = {"method": "obs/pred quantiles over held-out years (leave-one-year-out, 2012-2025) of the adopted "
                     "models. Range = value x q10 .. value x q90. Interpolate on log(area) between scales.",
           "scales": [], "low_confidence_below_km2": LOW_CONFIDENCE_BELOW_KM2,
           "loyo_year_error_pct": {k: v["loyo_year_error_pct"] for k, v in adopted["models"].items()}}
    for key, name in SCALE_KEYS.items():
        row = {"scale": key, "area_km2": areas[key]}
        for period in ("month", "year"):
            row[period] = {}
            for src, m in adopted["models"].items():
                q = m["loyo"][f"{name} | {period}"]["obs_over_pred_q10_q50_q90"]
                if key == "canada" and period == "year":
                    r = m["loyo_canada_obs_over_pred_range"]
                    q = [r[0], q[1], r[1]]
                row[period][src] = [round(v, 3) for v in q]
                row[period][f"{src}_weighted_abs_error_pct"] = m["loyo"][f"{name} | {period}"]["weighted_abs_error_pct"]
        out["scales"].append(row)
    return out


def main() -> None:
    H = pd.read_parquet(PROCESSED / "harmonised_cell_month.parquet")
    src = pd.read_csv(C.REPORTS / "calibration" / "month_sources.csv")
    adopted = json.loads((C.REPORTS / "calibration" / "adopted_model.json").read_text())
    reg = pd.read_parquet(C.INTERIM / "regions_cell5.parquet")

    src = src.sort_values(["year", "month"]).reset_index(drop=True)
    src["idx"] = np.arange(len(src))
    cells = np.sort(H.cell5.unique())
    if len(cells) > 65535 or len(src) > 65535:
        raise ValueError("indices exceed uint16")
    reg = reg.set_index("cell5").reindex(cells)
    regions = sorted(reg.region.dropna().unique())
    provinces = sorted(reg.province.dropna().unique())

    H = H.merge(src[["year", "month", "idx"]], on=["year", "month"])
    cidx = pd.Series(np.arange(len(cells)), index=cells)
    H["cidx"] = cidx.reindex(H.cell5.to_numpy()).to_numpy()
    H = H.sort_values(["cidx", "idx"])

    sections, offset, layout = [], 0, {}

    def add(name, arr):
        nonlocal offset
        b = np.ascontiguousarray(arr).tobytes()
        layout[name] = {"offset": offset, "length": int(len(arr)), "dtype": str(arr.dtype)}
        pad = (-len(b)) % 4
        sections.append(b + b"\0" * pad)
        offset += len(b) + pad

    add("cell_hi", (cells >> np.uint64(32)).astype("<u4"))
    add("cell_lo", (cells & np.uint64(0xFFFFFFFF)).astype("<u4"))
    add("cell_lat", reg.lat.to_numpy().astype("<f4"))
    add("cell_lon", reg.lon.to_numpy().astype("<f4"))
    add("cell_region", reg.region.map({r: i for i, r in enumerate(regions)}).fillna(255).to_numpy().astype("u1"))
    add("cell_province", reg.province.map({p: i for i, p in enumerate(provinces)}).fillna(255).to_numpy().astype("u1"))
    add("row_cell", H.cidx.to_numpy().astype("<u2"))
    add("row_month", H.idx.to_numpy().astype("<u2"))
    add("row_value", H.cell_days.to_numpy().astype("<f4"))

    areas = scale_areas()
    unc = uncertainty(adopted, areas)
    PROCESSED.mkdir(parents=True, exist_ok=True)
    (PROCESSED / "uncertainty.json").write_text(json.dumps(unc, indent=1))

    day_cols = [c for c in src.columns if c.startswith("days_")]
    months = [{"y": int(r.year), "m": int(r.month), "source": r.source, "partial": bool(r.partial),
               "days": {c[5:]: int(getattr(r, c)) for c in day_cols if pd.notna(getattr(r, c)) and getattr(r, c) > 0}}
              for r in src.itertuples(index=False)]
    manifest = {
        "title": "Harmonised MODIS-VIIRS fire cell-days, Canada",
        "unit": "fire cell-days (VIIRS-equivalent): ~1 km cells with at least one detection on a day",
        "grid": {"type": "h3", "resolution": C.DISPLAY_RES, "cell_area_km2": areas["cell"]},
        "generated": date.today().isoformat(),
        "country": C.COUNTRY,
        "calibration_years": [2012, 2025],
        "sources": {
            "observed": "VIIRS (mean of S-NPP and NOAA-20 where both available)",
            "near_real_time": "VIIRS, includes near-real-time processing (not yet final)",
            "estimated_from_modis": "estimated from MODIS (Aqua or Terra cell-days) with a VIIRS ratio table by "
                                    "region, land cover, season and fire intensity (FRP tercile)",
            "estimated_from_terra": "estimated from MODIS Terra with a VIIRS/Terra ratio table by region, land cover, "
                                    "season and fire intensity (FRP tercile); Aqua not yet available",
        },
        "months": months,
        "regions": regions,
        "provinces": provinces,
        "uncertainty": unc,
        "binary": {"file": "harmonised.bin", "cells": int(len(cells)), "rows": int(len(H)), "layout": layout},
    }
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "harmonised.bin").write_bytes(b"".join(sections))
    (WEB / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    import gzip
    for f in ("harmonised.bin", "manifest.json"):
        raw = (WEB / f).read_bytes()
        print(f"{f}: {len(raw)/1e6:.2f} MB ({len(gzip.compress(raw, 9))/1e6:.2f} MB gzipped)")
    print(f"cells {len(cells):,}, rows {len(H):,}, months {len(src)} ({src.year.min()}-{src.month.iloc[0]:02d} .. "
          f"{src.year.max()}-{src.month.iloc[-1]:02d})")
    print("scale areas km2:", areas)


if __name__ == "__main__":
    main()
