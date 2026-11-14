"""Static hotspot tiles for the raw hotspot CSV download in the app.

The cleaned detections (type 0, low-confidence class removed; see clean.py) are split into
5 x 5 degree tiles per UTC year and written as gzipped CSV, plus an index the app reads to
decide which tiles a selection needs. The tiles are build artefacts: they are not committed
to git (web/public/hotspots/ is ignored) and are published with the site by the deploy
workflow from a release asset.

Output: web/public/hotspots/index.json, web/public/hotspots/<year>/<lat0>_<lon0>.csv.gz
"""
from __future__ import annotations

import gzip
import io
import json
import shutil

import numpy as np
import pandas as pd

import config as C

OUT = C.REPO / "web" / "public" / "hotspots"
TILE_DEG = 5
SAT = {"terra": "Terra", "aqua": "Aqua", "snpp": "S-NPP", "noaa20": "NOAA-20"}
INSTR = {"terra": "MODIS", "aqua": "MODIS", "snpp": "VIIRS", "noaa20": "VIIRS"}
COLUMNS = ["latitude", "longitude", "acq_date", "acq_time_utc", "satellite", "instrument", "confidence",
           "frp_mw", "day_night", "processing"]


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    frames = []
    for plat in SAT:
        for f in sorted((C.INTERIM / "detections" / plat).glob("*.parquet")):
            d = pd.read_parquet(f)
            d["platform"] = plat
            frames.append(d)
    d = pd.concat(frames, ignore_index=True)
    d = d.drop_duplicates(["platform", "latitude", "longitude", "acq_date", "acq_time"])
    d["year"] = d.acq_date.dt.year
    d["lat0"] = (np.floor(d.latitude / TILE_DEG) * TILE_DEG).astype(int)
    d["lon0"] = (np.floor(d.longitude / TILE_DEG) * TILE_DEG).astype(int)
    out = pd.DataFrame({
        "latitude": d.latitude.round(5), "longitude": d.longitude.round(5),
        "acq_date": d.acq_date.dt.strftime("%Y-%m-%d"), "acq_time_utc": d.acq_time.astype(int).map("{:04d}".format),
        "satellite": d.platform.map(SAT), "instrument": d.platform.map(INSTR),
        "confidence": d.confidence.astype(str).str.strip(),
        "frp_mw": d.frp.round(2), "day_night": np.where(d.is_day, "D", "N"),
        "processing": np.where(d.nrt, "near real time", "standard"),
    })
    out[["year", "lat0", "lon0"]] = d[["year", "lat0", "lon0"]]
    index, total = [], 0
    for (y, la, lo), g in out.groupby(["year", "lat0", "lon0"]):
        path = OUT / str(y) / f"{la}_{lo}.csv.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        buf = io.StringIO()
        g[COLUMNS].sort_values(["acq_date", "acq_time_utc"]).to_csv(buf, index=False, header=False)
        data = gzip.compress(buf.getvalue().encode(), 6)
        path.write_bytes(data)
        total += len(data)
        index.append({"y": int(y), "lat0": int(la), "lon0": int(lo), "rows": int(len(g)), "bytes": len(data)})
    (OUT / "index.json").write_text(json.dumps({
        "tile_deg": TILE_DEG, "columns": COLUMNS,
        "filters": "type 0 (presumed vegetation fire), low-confidence class removed; near-real-time rows flagged",
        "tiles": index}, separators=(",", ":")))
    print(f"{len(index)} tiles, {len(out):,} detections, {total/1e6:.1f} MB")


if __name__ == "__main__":
    main()
