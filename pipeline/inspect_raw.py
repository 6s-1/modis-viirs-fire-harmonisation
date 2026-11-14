"""Print columns, dtypes, row counts and key value distributions for the raw sensor files.

Usage:
  python pipeline/inspect_raw.py                 # one sample file per sensor + row counts for all
  python pipeline/inspect_raw.py --year 2019     # choose the sample year
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
RAW = REPO / "data" / "raw"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2019")
    ap.add_argument("--country", default="Canada")
    args = ap.parse_args()

    for sensor_dir in sorted(p for p in RAW.iterdir() if p.is_dir()):
        sensor = sensor_dir.name
        f = sensor_dir / f"{sensor}_{args.year}_{args.country}.csv"
        print("=" * 78)
        print(f"{sensor}  sample file: {f.name}")
        if f.exists():
            df = pd.read_csv(f)
            print(f"rows: {len(df):,}   columns: {df.shape[1]}")
            print(df.dtypes.to_string())
            print("\nhead(3):")
            print(df.head(3).to_string())
            for col in ("type", "satellite", "daynight", "instrument", "version"):
                if col in df.columns:
                    print(f"\n{col} counts:\n{df[col].value_counts(dropna=False).to_string()}")
            if "confidence" in df.columns:
                c = df["confidence"]
                if pd.api.types.is_numeric_dtype(c):
                    print("\nconfidence (numeric) describe:\n" + c.describe().to_string())
                else:
                    print("\nconfidence counts:\n" + c.value_counts(dropna=False).to_string())
            print(f"\nlat range {df.latitude.min():.2f}..{df.latitude.max():.2f}  "
                  f"lon range {df.longitude.min():.2f}..{df.longitude.max():.2f}  "
                  f"dates {df.acq_date.min()}..{df.acq_date.max()}")
        else:
            print("  (sample year not present)")

        print("\nrow counts, all years:")
        for csv in sorted(sensor_dir.glob(f"{sensor}_*_{args.country}.csv")):
            n = sum(1 for _ in open(csv, "rb")) - 1
            print(f"  {csv.stem.split('_')[1]}: {n:>10,}")


if __name__ == "__main__":
    main()
