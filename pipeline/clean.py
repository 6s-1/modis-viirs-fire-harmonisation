"""Step 1a: read every raw CSV, keep vegetation-fire detections, apply the confidence filter.

Reads every *.csv under data/raw/<sensor>/ (recursively), so new yearly files and the
2026 archive downloads in data/raw/<sensor>/2026/ are picked up without code changes.
Files are processed one at a time to keep memory low.

Output:
  data/interim/detections/<platform>/<file stem>.parquet   kept detections, one file per input CSV
  reports/filter_report.json                               rows kept and dropped per platform-year
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pandas as pd

import config as C

COLS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence",
        "version", "frp", "daynight", "type"]
OUT = C.INTERIM / "detections"


def read_one(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, usecols=lambda c: c in COLS,
                     dtype={"satellite": str, "confidence": str, "version": str, "daynight": str,
                            "type": "int8", "acq_time": "int16", "frp": "float32"})
    missing = set(COLS) - set(df.columns)
    if missing:
        raise ValueError(f"{path}: missing columns {sorted(missing)}")
    unknown = set(df["satellite"].unique()) - set(C.SATELLITE_CODES)
    if unknown:
        raise ValueError(f"{path}: unknown satellite codes {sorted(unknown)}; add them to config.SATELLITE_CODES")
    df["platform"] = df["satellite"].map(C.SATELLITE_CODES)
    in_nrt_folder = any(p.isdigit() and int(p) >= 2026 for p in path.relative_to(C.RAW).parts[:-1])
    df["nrt"] = df["version"].str.contains("NRT", case=False, na=False) | in_nrt_folder
    df["acq_date"] = pd.to_datetime(df["acq_date"])
    return df


def confidence_ok(df: pd.DataFrame) -> np.ndarray:
    modis = df["platform"].map(C.INSTRUMENT).eq("modis").to_numpy()
    conf = df["confidence"].astype(str).str.strip().str.lower()
    modis_num = pd.to_numeric(conf.where(modis), errors="coerce")
    return np.where(modis, modis_num >= C.MODIS_MIN_CONFIDENCE, conf.isin(C.VIIRS_KEEP_CONFIDENCE))


def main() -> None:
    files = sorted(p for d in C.SENSOR_DIRS for p in (C.RAW / d).rglob("*.csv"))
    if not files:
        raise SystemExit(f"No CSV files under {C.RAW}")
    if OUT.exists():
        shutil.rmtree(OUT)
    old = C.INTERIM / "detections.parquet"
    if old.exists():
        old.unlink()

    by_year = []
    kept_total = 0
    for f in files:
        df = read_one(f)
        is_type0 = df["type"].eq(C.KEEP_TYPE).to_numpy()
        is_conf = confidence_ok(df)
        start = pd.to_datetime(df["platform"].map(lambda p: C.MISSION_WINDOWS[p][0]))
        end = pd.to_datetime(df["platform"].map(lambda p: C.MISSION_WINDOWS[p][1] or pd.Timestamp.max.date()))
        in_window = ((df["acq_date"] >= start) & (df["acq_date"] <= end)).to_numpy()
        keep = is_type0 & is_conf & in_window
        year = df["acq_date"].dt.year.to_numpy()
        for plat in df["platform"].unique():
            pm = (df["platform"] == plat).to_numpy()
            for y in np.unique(year[pm]):
                m = pm & (year == y)
                by_year.append({
                    "platform": plat, "year": int(y), "file": str(f.relative_to(C.RAW)), "rows": int(m.sum()),
                    "dropped_type": int((m & ~is_type0).sum()),
                    "dropped_confidence": int((m & is_type0 & ~is_conf).sum()),
                    "dropped_window": int((m & is_type0 & is_conf & ~in_window).sum()),
                })
        out = df.loc[keep, ["platform", "latitude", "longitude", "acq_date", "acq_time", "daynight", "frp", "nrt"]]
        out = out.assign(is_day=out.pop("daynight").eq("D"))
        for plat, g in out.groupby("platform"):
            dest = OUT / plat / f"{f.stem}.parquet"
            dest.parent.mkdir(parents=True, exist_ok=True)
            g.drop(columns="platform").to_parquet(dest, index=False, compression="zstd")
        kept_total += len(out)
        del df, out

    rows = pd.DataFrame(by_year)
    tot = rows.groupby("platform")[["rows", "dropped_type", "dropped_confidence", "dropped_window"]].sum()
    tot["kept"] = tot["rows"] - tot.drop(columns="rows").sum(axis=1)
    report = {
        "filters": {
            "type": f"keep type == {C.KEEP_TYPE} (presumed vegetation fire)",
            "modis_confidence": f"keep confidence >= {C.MODIS_MIN_CONFIDENCE} (nominal and high; drops the low class)",
            "viirs_confidence": "keep n and h (drops l; l is only assigned to daytime detections)",
            "mission_window": "drop detections outside each platform's record window (config.MISSION_WINDOWS)",
            "duplicates": "exact repeats are removed when cell-days are built (cell_days.py)",
        },
        "totals": {p: {k: int(v) for k, v in r.items()} for p, r in tot.iterrows()},
        "kept": int(kept_total),
        "by_platform_year": by_year,
    }
    C.REPORTS.mkdir(exist_ok=True)
    (C.REPORTS / "filter_report.json").write_text(json.dumps(report, indent=1))

    print(f"Read {len(files)} files. Kept {kept_total:,} detections.")
    t = tot.copy()
    t["pct_type"] = 100 * t.dropped_type / t.rows
    t["pct_conf"] = 100 * t.dropped_confidence / (t.rows - t.dropped_type)
    print(t.round(1).to_string())


if __name__ == "__main__":
    main()
