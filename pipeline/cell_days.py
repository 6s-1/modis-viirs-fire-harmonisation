"""Step 1b: turn cleaned detections into fire cell-days and monthly display-grid totals.

Definitions
  fine cell   H3 resolution 8 cell (~0.74 km2), the shared ~1 km grid for both instruments.
  day         local solar date = UTC acquisition time + longitude / 15 h. This keeps each
              overpass (e.g. Terra ~22:30 local) on the calendar day it was observed.
  cell-day    a fine cell with >= 1 kept detection from one platform on one local day.
              Counted once regardless of how many detections fall in it. Day and night
              are recorded as separate flags, so day-only and night-only counts exist too.

Coverage
  Each platform-month is "full", "partial" or "none" (config.MISSION_WINDOWS, the years
  present in data/raw, and config.FORCED_PARTIAL). A missing cell in a full or partial
  month means zero cell-days; a "none" month has no observation and must stay empty.

Outputs
  data/interim/cell_days_fine.parquet       cell8, date, platform, day, night, n_det, frp_sum, quality, year, month
  data/interim/cell_days_monthly.parquet    cell5, year, month, platform, cell_days, cell_days_day,
                                            cell_days_night, n_det, nrt_cell_days, coverage
  data/interim/coverage.parquet             platform, year, month, coverage, days_covered, reason
  data/interim/daily_counts.parquet         platform, date, cell_days (all Canada)
  reports/cell_days_by_year.csv             per platform-year summary
  reports/canada_monthly_by_platform.csv    Canada-wide monthly cell-days (empty where no coverage)
  reports/grid_stats.json                   cell-area spread of H3 vs 0.25 degree over the data
"""
from __future__ import annotations

import calendar
import json
from datetime import date

import h3
import numpy as np
import pandas as pd

import config as C

DET = C.INTERIM / "detections"


def to_cells(lat: np.ndarray, lon: np.ndarray, res: int) -> np.ndarray:
    f = h3.api.basic_int.latlng_to_cell
    return np.fromiter((f(a, b, res) for a, b in zip(lat, lon)), dtype=np.uint64, count=len(lat))


def to_parent(cells: np.ndarray, res: int) -> np.ndarray:
    f = h3.api.basic_int.cell_to_parent
    uniq, inv = np.unique(cells, return_inverse=True)
    parents = np.fromiter((f(int(c), res) for c in uniq), dtype=np.uint64, count=len(uniq))
    return parents[inv]


def build_coverage(info: dict) -> pd.DataFrame:
    """One row per platform-month from Jan 2000 to the last month with data.

    info[platform] = {"years": set of UTC years present, "std_end": date|None, "nrt_end": date|None}
    A standard-processing yearly file covers the whole year, even if the last fire falls before
    31 Dec. Near-real-time data only covers up to its last acquisition date.
    """
    last_date = {p: max(d for d in (v["std_end"], v["nrt_end"]) if d is not None) for p, v in info.items()}
    end_all = max(last_date.values())
    rows = []
    for plat in C.PLATFORMS:
        w0, w1_cfg = C.MISSION_WINDOWS[plat]
        w1 = min(w1_cfg or last_date.get(plat, w0), last_date.get(plat, w0))
        yrs = info.get(plat, {}).get("years", set())
        for y in range(2000, end_all.year + 1):
            for m in range(1, 13):
                m0 = date(y, m, 1)
                m1 = date(y, m, calendar.monthrange(y, m)[1])
                if m0 > end_all:
                    break
                lo, hi = max(m0, w0), min(m1, w1)
                in_mission = w0 <= m1 and m0 <= (w1_cfg or end_all)
                if y not in yrs:
                    status, days = "none", 0
                    reason = "no data file for this year" if in_mission else "outside mission"
                elif lo > hi:
                    status, days, reason = "none", 0, "outside mission"
                else:
                    days = (hi - lo).days + 1
                    full = days == (m1 - m0).days + 1
                    status, reason = ("full", "") if full else ("partial", f"observed {lo}..{hi}")
                if (plat, y, m) in C.FORCED_PARTIAL and status != "none":
                    status, reason = "partial", C.FORCED_PARTIAL[(plat, y, m)]
                rows.append((plat, y, m, status, days, reason))
    return pd.DataFrame(rows, columns=["platform", "year", "month", "coverage", "days_covered", "reason"])


def grid_stats(cells5: np.ndarray, lat_min: float, lat_max: float) -> dict:
    uniq = np.unique(cells5)
    areas = np.array([h3.cell_area(h3.int_to_str(int(c)), unit="km^2") for c in uniq])
    lat_lo, lat_hi = float(np.floor(lat_min)), float(np.ceil(lat_max))

    def deg_area(lat):  # 0.25 x 0.25 degree cell area on a sphere, km2
        r = 6371.0088
        return (np.radians(0.25) * r) * (np.radians(0.25) * r * np.cos(np.radians(lat)))
    return {
        "h3_res5_cells_with_fire": int(len(uniq)),
        "h3_res5_area_km2": {"min": round(float(areas.min()), 1), "median": round(float(np.median(areas)), 1),
                              "max": round(float(areas.max()), 1),
                              "max_over_min": round(float(areas.max() / areas.min()), 2)},
        "deg025_area_km2": {"at_lat": [lat_lo, lat_hi],
                             "values": [round(float(deg_area(lat_lo)), 1), round(float(deg_area(lat_hi)), 1)],
                             "max_over_min": round(float(deg_area(lat_lo) / deg_area(lat_hi)), 2)},
        "h3_res8_avg_area_km2": round(h3.average_hexagon_area(C.FINE_RES, unit="km^2"), 3),
    }


def platform_cell_days(plat: str) -> tuple[pd.DataFrame, dict, int]:
    files = sorted((DET / plat).glob("*.parquet"))
    det = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    n_raw = len(det)
    det = det.drop_duplicates(["latitude", "longitude", "acq_date", "acq_time"])
    n_dup = n_raw - len(det)
    info = {
        "years": set(det["acq_date"].dt.year.unique().tolist()),
        "std_end": (date(int(det.loc[~det.nrt, "acq_date"].max().year), 12, 31) if (~det.nrt).any() else None),
        "nrt_end": (det.loc[det.nrt, "acq_date"].max().date() if det.nrt.any() else None),
        "detections": len(det), "lat_min": float(det.latitude.min()), "lat_max": float(det.latitude.max()),
    }
    hhmm = det["acq_time"].astype("int32")
    local = (det["acq_date"] + pd.to_timedelta(hhmm // 100, "h") + pd.to_timedelta(hhmm % 100, "min")
             + pd.to_timedelta(det["longitude"] / 15.0, "h"))
    keyed = pd.DataFrame({
        "cell8": to_cells(det["latitude"].to_numpy(), det["longitude"].to_numpy(), C.FINE_RES),
        "date": local.dt.normalize(),
        "day": det["is_day"].to_numpy(),
        "night": ~det["is_day"].to_numpy(),
        "nrt": det["nrt"].to_numpy(),
        "frp": det["frp"].to_numpy(),
    })
    del det, local
    fine = (keyed.groupby(["cell8", "date"], sort=False)
                 .agg(day=("day", "max"), night=("night", "max"), n_det=("day", "size"),
                      frp_sum=("frp", "sum"), nrt=("nrt", "max"))
                 .reset_index())
    fine["platform"] = plat
    fine["n_det"] = fine["n_det"].astype("int32")
    fine["frp_sum"] = fine["frp_sum"].astype("float32")
    return fine, info, n_dup


def main() -> None:
    parts, info, dups = [], {}, {}
    for plat in C.PLATFORMS:
        if not (DET / plat).is_dir():
            continue
        fine_p, info[plat], dups[plat] = platform_cell_days(plat)
        parts.append(fine_p)
        print(f"  {plat}: {info[plat]['detections']:,} detections -> {len(fine_p):,} cell-days "
              f"({dups[plat]} duplicates dropped)", flush=True)
    fine = pd.concat(parts, ignore_index=True)
    del parts
    fine["platform"] = fine["platform"].astype("category")
    fine["quality"] = pd.Categorical(np.where(fine.pop("nrt"), "nrt", "standard"))
    fine["year"] = fine["date"].dt.year.astype("int16")
    fine["month"] = fine["date"].dt.month.astype("int8")

    cov = build_coverage(info)
    # Drop cell-days whose local date falls in a month with no coverage (the local-date shift
    # can push a 1 January UTC detection into 31 December of a year with no data).
    key = cov[["platform", "year", "month", "coverage"]].astype({"year": "int16", "month": "int8"})
    fine = fine.merge(key, on=["platform", "year", "month"], how="left")
    outside = fine["coverage"].isna() | fine["coverage"].eq("none")
    n_outside = int(outside.sum())
    fine = fine.loc[~outside].drop(columns="coverage").reset_index(drop=True)
    fine["platform"] = fine["platform"].astype("category")
    fine.to_parquet(C.INTERIM / "cell_days_fine.parquet", index=False, compression="zstd")

    fine["cell5"] = to_parent(fine["cell8"].to_numpy(), C.DISPLAY_RES)
    fine["is_nrt"] = fine["quality"].eq("nrt")
    monthly = (fine.groupby(["cell5", "year", "month", "platform"], observed=True)
                  .agg(cell_days=("day", "size"), cell_days_day=("day", "sum"), cell_days_night=("night", "sum"),
                       n_det=("n_det", "sum"), nrt_cell_days=("is_nrt", "sum"))
                  .reset_index())
    monthly = monthly.merge(key, on=["platform", "year", "month"])
    monthly.to_parquet(C.INTERIM / "cell_days_monthly.parquet", index=False, compression="zstd")
    cov.to_parquet(C.INTERIM / "coverage.parquet", index=False)

    daily = fine.groupby(["platform", "date"], observed=True).size().rename("cell_days").reset_index()
    daily.to_parquet(C.INTERIM / "daily_counts.parquet", index=False)

    # Canada-wide monthly series per platform: 0 in covered months without fire, empty where no coverage.
    tot = fine.groupby(["platform", "year", "month"], observed=True).size().rename("cell_days").reset_index()
    tot["platform"] = tot["platform"].astype(str)
    series = cov.merge(tot.astype({"year": int, "month": int}), on=["platform", "year", "month"], how="left")
    series["cell_days"] = np.where(series["coverage"].eq("none"), np.nan, series["cell_days"].fillna(0))
    series.to_csv(C.REPORTS / "canada_monthly_by_platform.csv", index=False)

    # Per platform-year summary.
    fy = (fine.groupby(["platform", "year"], observed=True)
              .agg(cell_days=("day", "size"), day_cell_days=("day", "sum"), night_cell_days=("night", "sum"),
                   nrt_cell_days=("is_nrt", "sum"), detections=("n_det", "sum")))
    fy.index = fy.index.set_levels([fy.index.levels[0].astype(str), fy.index.levels[1].astype(int)])
    cy = cov.pivot_table(index=["platform", "year"], columns="coverage", values="month", aggfunc="count",
                         fill_value=0).reindex(columns=["full", "partial", "none"], fill_value=0)
    cy.columns = [f"months_{c}" for c in cy.columns]
    summary = cy.join(fy, how="left").reset_index()
    summary = summary[(summary.months_full + summary.months_partial) > 0].copy()
    num = ["cell_days", "day_cell_days", "night_cell_days", "nrt_cell_days", "detections"]
    summary[num] = summary[num].fillna(0).astype(int)
    summary["detections_per_cell_day"] = (summary.detections / summary.cell_days).round(2)
    summary.to_csv(C.REPORTS / "cell_days_by_year.csv", index=False)

    stats = grid_stats(monthly["cell5"].to_numpy(), min(v["lat_min"] for v in info.values()),
                       max(v["lat_max"] for v in info.values()))
    stats["cell_days_dropped_outside_coverage"] = n_outside
    stats["duplicates_dropped"] = {k: int(v) for k, v in dups.items()}
    (C.REPORTS / "grid_stats.json").write_text(json.dumps(stats, indent=1))

    print(f"fine cell-days: {len(fine):,}   monthly rows (res {C.DISPLAY_RES}): {len(monthly):,}   "
          f"dropped outside coverage: {n_outside}")
    wide = summary.pivot(index="year", columns="platform", values="cell_days").reindex(columns=C.PLATFORMS)
    print("\nfire cell-days per platform per year (blank = no data):")
    print(wide.to_string(float_format=lambda v: f"{v:,.0f}", na_rep=""))
    print("\npartial months:")
    print(cov[cov.coverage == "partial"].to_string(index=False))
    gaps = cov[cov.reason.eq("no data file for this year")].groupby("platform")["year"].unique()
    print("\nno-coverage years inside a mission window:")
    print(gaps.to_string() if len(gaps) else "  none")


if __name__ == "__main__":
    main()
