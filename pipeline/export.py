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
import h3
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


RAW_PLATFORMS = ["terra", "aqua", "snpp", "noaa20", "viirs"]


def canada_cells() -> np.ndarray:
    """H3 display cells whose centre lies in Canada (land and lakes, Natural Earth 1:50m)."""
    prov = gpd.read_file(C.DATA / "external" / "ne_admin1" / "ne_50m_admin_1_states_provinces.shp")
    g = prov[prov.admin == "Canada"].to_crs("EPSG:4326").dissolve().geometry.iloc[0]
    out = set()
    for poly in getattr(g, "geoms", [g]):
        out |= {h3.str_to_int(c) for c in h3.geo_to_cells(poly.__geo_interface__, C.DISPLAY_RES)}
    return np.array(sorted(out), dtype=np.uint64)


def raw_rows(src: pd.DataFrame, cidx: pd.Series) -> pd.DataFrame:
    """Each sensor's own cell-days per cell and month, no conversion (Raw view in the app).
    'viirs' is the VIIRS reference (mean of the available S-NPP and NOAA-20)."""
    m = pd.read_parquet(C.INTERIM / "cell_days_monthly.parquet", columns=["cell5", "year", "month", "platform", "cell_days"])
    m["platform"] = m.platform.astype(str)
    v = (pd.read_parquet(C.INTERIM / "calibration_base.parquet", columns=["cell5", "year", "month", "vref"])
           .groupby(["cell5", "year", "month"]).vref.sum().rename("cell_days").reset_index().assign(platform="viirs"))
    r = pd.concat([m, v[v.cell_days > 0]], ignore_index=True)
    r = r.merge(src[["year", "month", "idx"]], on=["year", "month"])
    r = r[r.cell5.isin(cidx.index)]
    r["cidx"] = cidx.reindex(r.cell5.to_numpy()).to_numpy()
    r["pcode"] = r.platform.map({p: i for i, p in enumerate(RAW_PLATFORMS)})
    return r.rename(columns={"cell_days": "value"}).sort_values(["cidx", "idx", "pcode"])


def same_days(src: pd.DataFrame, H: pd.DataFrame) -> tuple[dict | None, pd.DataFrame]:
    """Cell-days for days 1..N of the latest month in every earlier year, when that month is
    partial (e.g. 1-14 Nov). Observed years: VIIRS reference for those days. Estimated years:
    the month's harmonised value x the share of the MODIS input's cell-days on days 1..N."""
    import calibrate as K
    import h3
    last = src.iloc[-1]
    if not bool(last.partial):
        return None, pd.DataFrame(columns=["cell5", "year", "value"])
    n_days = int(max(v for c, v in last.items() if c.startswith("days_") and pd.notna(v)))
    M, Y = int(last.month), int(last.year)
    fine = pd.read_parquet(C.INTERIM / "cell_days_fine.parquet", columns=["cell8", "date", "platform", "year", "month"])
    fine = fine[(fine.month == M) & (fine.year < Y)].copy()
    fine["platform"] = fine.platform.astype(str)
    uniq, inv = np.unique(fine.cell8.to_numpy(), return_inverse=True)
    par = np.fromiter((h3.api.basic_int.cell_to_parent(int(c), C.DISPLAY_RES) for c in uniq), np.uint64, len(uniq))
    fine["cell5"] = par[inv]
    fine["early"] = fine.date.dt.day <= n_days
    cov = pd.read_parquet(C.INTERIM / "coverage.parquet")
    av, _ = K.availability(pd.read_parquet(C.INTERIM / "daily_counts.parquet"), cov)
    srcm = src[src.month == M].set_index("year").source
    out = []
    for y, g in fine.groupby("year"):
        source = srcm.get(y)
        if source in ("observed", "near_real_time"):
            v = g[g.early & g.platform.isin(["snpp", "noaa20"])]
            w = v.groupby(["cell8", "date", "cell5"]).platform.agg(lambda s: set(s)).reset_index()
            a = av.reindex(w.date)
            k = a.snpp.to_numpy().astype(int) + a.noaa20.to_numpy().astype(int)
            ref = np.array([((("snpp" in p) and sa) + (("noaa20" in p) and na)) / kk if kk else 0.0
                            for p, sa, na, kk in zip(w.platform, a.snpp.to_numpy(), a.noaa20.to_numpy(), k)])
            val = pd.Series(ref, index=w.cell5).groupby(level=0).sum()
        elif source in ("estimated_from_modis", "estimated_from_terra"):
            plats = ["aqua", "terra"] if source == "estimated_from_modis" else ["terra"]
            m = g[g.platform.isin(plats)].drop_duplicates(["cell8", "date"])
            frac = m.groupby("cell5").early.mean()
            hv = H[(H.year == y) & (H.month == M)].set_index("cell5").cell_days
            val = (hv * frac.reindex(hv.index).fillna(0))
        else:
            continue
        val = val[val > 0]
        out.append(pd.DataFrame({"cell5": val.index.to_numpy(), "year": int(y), "value": val.to_numpy()}))
    info = {"year": Y, "month": M, "days": n_days, "years": sorted(int(y) for y in srcm.index if y < Y)}
    return info, pd.concat(out, ignore_index=True)


def main() -> None:
    H = pd.read_parquet(PROCESSED / "harmonised_cell_month.parquet")
    src = pd.read_csv(C.REPORTS / "calibration" / "month_sources.csv")
    adopted = json.loads((C.REPORTS / "calibration" / "adopted_model.json").read_text())
    reg = pd.read_parquet(C.INTERIM / "regions_cell5.parquet")

    src = src.sort_values(["year", "month"]).reset_index(drop=True)
    src["idx"] = np.arange(len(src))
    canada = canada_cells()
    cells = np.sort(np.union1d(H.cell5.unique(), canada))
    if len(cells) > 65535 or len(src) > 65535:
        raise ValueError("indices exceed uint16")
    reg = reg.set_index("cell5").reindex(cells)
    missing = reg.lat.isna().to_numpy()
    ll = np.array([h3.api.basic_int.cell_to_latlng(int(c)) for c in cells[missing]]).reshape(-1, 2)
    reg.loc[missing, "lat"], reg.loc[missing, "lon"] = ll[:, 0], ll[:, 1]
    area = np.array([h3.cell_area(h3.int_to_str(int(c)), unit="km^2") for c in cells])
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
    add("cell_area", area.astype("<f4"))
    add("cell_canada", np.isin(cells, canada).astype("u1"))
    add("row_cell", H.cidx.to_numpy().astype("<u2"))
    add("row_month", H.idx.to_numpy().astype("<u2"))
    add("row_value", H.cell_days.to_numpy().astype("<f4"))
    raw = raw_rows(src, cidx)
    add("raw_cell", raw.cidx.to_numpy().astype("<u2"))
    add("raw_month", raw.idx.to_numpy().astype("<u2"))
    add("raw_platform", raw.pcode.to_numpy().astype("u1"))
    add("raw_value", raw.value.to_numpy().astype("<f4"))
    sd_info, sd = same_days(src, H)
    sd = sd[sd.cell5.isin(cidx.index)]
    add("sd_cell", cidx.reindex(sd.cell5.to_numpy()).to_numpy().astype("<u2"))
    add("sd_year", sd.year.to_numpy().astype("<u2"))
    add("sd_value", sd.value.to_numpy().astype("<f4"))

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
        "same_days": sd_info,
        "raw_platforms": RAW_PLATFORMS,
        "canada_cells_source": "Natural Earth 1:50m admin-1 (Canada), H3 res 5 cells whose centre is inside",
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
