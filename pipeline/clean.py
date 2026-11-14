"""Step 1a: read every raw CSV, keep vegetation-fire detections, apply the confidence filter.

Reads every *.csv under data/raw/<sensor>/ (recursively), so new yearly files and the
2026 archive downloads in data/raw/<sensor>/2026/ are picked up without code changes.
Files are processed one at a time to keep memory low.

Near-real-time rows are those whose `version` contains "NRT". FIRMS NRT files have no
`type` column; their type is inferred from location (typeinfer.py). Files in a year
folder (e.g. 2026/) are marked `recent`, which cell_days.py uses to set the data end date.

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
import typeinfer

COLS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence",
        "version", "frp", "daynight", "type"]
REQUIRED = set(COLS) - {"type"}
OUT = C.INTERIM / "detections"


def is_recent(path: Path) -> bool:
    return any(p.isdigit() for p in path.relative_to(C.RAW).parts[1:-1])


def read_one(path: Path, static: pd.DataFrame | None = None) -> pd.DataFrame:
    df = pd.read_csv(path, usecols=lambda c: c in COLS,
                     dtype={"satellite": str, "confidence": str, "version": str, "daynight": str,
                            "acq_time": "int16", "frp": "float32"})
    df["type_inferred"] = "type" not in df.columns
    if "type" not in df.columns:
        if static is None:
            raise ValueError(f"{path}: no type column and no static-source table")
        df["type"] = typeinfer.infer_type(df, static)
    df["type"] = df["type"].astype("int8")
    missing = REQUIRED - set(df.columns)
    if missing:
        raise ValueError(f"{path}: missing columns {sorted(missing)}")
    unknown = set(df["satellite"].unique()) - set(C.SATELLITE_CODES)
    if unknown:
        raise ValueError(f"{path}: unknown satellite codes {sorted(unknown)}; add them to config.SATELLITE_CODES")
    df["platform"] = df["satellite"].map(C.SATELLITE_CODES)
    df["nrt"] = df["version"].str.contains("NRT", case=False, na=False)
    df["recent"] = is_recent(path)
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

    # Static-source cells from every file that carries a type column (standard record).
    typed = []
    for f in files:
        head = pd.read_csv(f, nrows=0).columns
        if "type" in head:
            typed.append(pd.read_csv(f, usecols=["latitude", "longitude", "type"]))
    static = typeinfer.build_static_cells(typed)
    del typed

    by_year = []
    kept_total = 0
    for f in files:
        df = read_one(f, static)
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
                    "nrt_rows": int((m & df["nrt"].to_numpy()).sum()),
                    "type_inferred": bool(df["type_inferred"].iloc[0]),
                    "dropped_type": int((m & ~is_type0).sum()),
                    "dropped_confidence": int((m & is_type0 & ~is_conf).sum()),
                    "dropped_window": int((m & is_type0 & is_conf & ~in_window).sum()),
                })
        out = df.loc[keep, ["platform", "latitude", "longitude", "acq_date", "acq_time", "daynight", "frp", "nrt",
                            "recent", "confidence"]]
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
            "nrt_type": "NRT rows have no type column; type 2 inferred from static-source cells (typeinfer.py)",
            "archive_vs_nrt": "NRT rows on or before a platform's last archive date in the same year are dropped (cell_days.py)",
        },
        "totals": {p: {k: int(v) for k, v in r.items()} for p, r in tot.iterrows()},
        "kept": int(kept_total),
        "static_source_cells": int(len(static)),
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
