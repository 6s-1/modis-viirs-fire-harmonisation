"""Extract one country's CSV per sensor-year from the FIRMS yearly country summaries.

Sources searched:
  * data/zips/<prefix>_<year>_all_countries.zip      (verified, then deleted)
  * <repo root>/<prefix>_<year>_all_countries.zip     (left in place)
  * unzipped folders in the repo root, e.g. modis-3/2002/modis_2002_<Country>.csv (left in place)

Output: data/raw/<sensor>/<sensor>_<year>_<Country>.csv

A zip in data/zips/ is deleted only after its extracted CSV has been verified:
same byte size and CRC-32 as the zip entry, and at least one data row. Use
--keep-zips to keep them. Unfinished browser downloads (*.zip.download) and
corrupt zips are skipped and listed at the end.

Usage:
  python pipeline/extract_country.py --country Canada
"""
from __future__ import annotations

import argparse
import re
import shutil
import zipfile
import zlib
from pathlib import Path

# FIRMS file prefix -> sensor folder name used in this project
SENSORS = {
    "modis": "modis",
    "viirs-snpp": "viirs-snpp",
    "viirs-jpss1": "viirs-noaa20",
}

REPO = Path(__file__).resolve().parents[1]
CSV_RE = re.compile(r"^(modis|viirs-snpp|viirs-jpss1)_(\d{4})_(.+)\.csv$")


def target_path(out_root: Path, prefix: str, year: str, country: str) -> Path:
    sensor = SENSORS[prefix]
    return out_root / sensor / f"{sensor}_{year}_{country}.csv"


def crc32_of(path: Path) -> int:
    crc = 0
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            crc = zlib.crc32(chunk, crc)
    return crc


def has_data_row(path: Path) -> bool:
    with open(path, "rb") as f:
        f.readline()  # header
        return bool(f.readline().strip())


def from_zip(zpath: Path, country: str, out_root: Path, done: dict, problems: list) -> bool:
    """Extract the country CSV from one zip. Returns True if the output is verified."""
    try:
        with zipfile.ZipFile(zpath) as zf:
            members = [m for m in zf.namelist() if m.endswith(f"_{country}.csv")]
            if not members:
                problems.append(f"{zpath.name}: no {country} CSV inside")
                return False
            ok = True
            for m in members:
                mm = CSV_RE.match(Path(m).name)
                if not mm:
                    continue
                prefix, year, _ = mm.groups()
                dest = target_path(out_root, prefix, year, country)
                info = zf.getinfo(m)
                verified = lambda: (dest.exists() and dest.stat().st_size == info.file_size
                                    and crc32_of(dest) == info.CRC and has_data_row(dest))
                if not verified():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    tmp = dest.with_suffix(".part")
                    with zf.open(m) as src, open(tmp, "wb") as dst:
                        shutil.copyfileobj(src, dst, 1 << 20)
                    tmp.replace(dest)
                if verified():
                    done.setdefault((SENSORS[prefix], year), f"zip:{zpath.name}")
                else:
                    problems.append(f"{zpath.name}: extracted CSV failed verification")
                    ok = False
            return ok
    except (zipfile.BadZipFile, EOFError, OSError) as e:
        problems.append(f"{zpath.name}: not a valid zip ({e.__class__.__name__}; incomplete download?)")
        return False


def from_folder(csv: Path, country: str, out_root: Path, done: dict) -> None:
    prefix, year, _ = CSV_RE.match(csv.name).groups()
    key = (SENSORS[prefix], year)
    if key in done:
        return
    dest = target_path(out_root, prefix, year, country)
    if not (dest.exists() and dest.stat().st_size == csv.stat().st_size):
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(csv, dest)
    done[key] = f"folder:{csv.parent.parent.name}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--country", default="Canada", help="Country name as in FIRMS file names (spaces as _)")
    ap.add_argument("--zips", type=Path, default=REPO / "data" / "zips",
                    help="Folder of new downloads; zips here are deleted after verification")
    ap.add_argument("--source", type=Path, default=REPO, help="Folder of older downloads (left in place)")
    ap.add_argument("--out", type=Path, default=REPO / "data" / "raw")
    ap.add_argument("--keep-zips", action="store_true", help="Do not delete verified zips in --zips")
    args = ap.parse_args()

    done: dict[tuple[str, str], str] = {}
    problems: list[str] = []
    deleted: list[str] = []

    if args.zips.is_dir():
        for z in sorted(args.zips.glob("*_all_countries.zip")):
            if z.is_file() and from_zip(z, args.country, args.out, done, problems) and not args.keep_zips:
                z.unlink()
                deleted.append(z.name)

    for z in sorted(args.source.glob("*_all_countries.zip")):
        if z.is_file():
            from_zip(z, args.country, args.out, done, problems)

    for csv in sorted(args.source.glob(f"*/*/*_{args.country}.csv")):
        if CSV_RE.match(csv.name) and csv.parts[-3] != "data":
            from_folder(csv, args.country, args.out, done)

    for folder in {args.source, args.zips}:
        for d in sorted(folder.glob("*.zip.download")):
            problems.append(f"{d.name}: unfinished browser download, skipped")

    print(f"Extracted this run ({args.country}):")
    for sensor in SENSORS.values():
        years = sorted(y for s, y in done if s == sensor)
        print(f"  {sensor:13s} {len(years):2d}: {', '.join(years) or '-'}")
    print(f"Now in {args.out.relative_to(REPO) if args.out.is_relative_to(REPO) else args.out}:")
    for sensor in SENSORS.values():
        years = sorted(p.stem.split("_")[1] for p in (args.out / sensor).glob(f"{sensor}_*_{args.country}.csv"))
        print(f"  {sensor:13s} {len(years):2d}: {', '.join(years) or '-'}")
    if deleted:
        print("Deleted verified zips: " + ", ".join(deleted))
    if problems:
        print("Skipped:")
        for p in problems:
            print("  " + p)


if __name__ == "__main__":
    main()
