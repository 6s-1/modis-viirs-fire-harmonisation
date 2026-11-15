"""Step 10: the compact "Why it burned" export.

Writes one shard per ecozone to web/public/why/, loaded only when the card opens:
  why/<zone>.json   per display cell: NFDB cause shares and largest fires, NBAC hectares by
                    year (and by month where the fire's start date gives one), land cover shares
  why/index.json    which zone each display cell belongs to, and the shard sizes

Display only: nothing here feeds the harmonisation model.
"""
from __future__ import annotations

import json
import unicodedata
from collections import defaultdict

import h3
import numpy as np
import pandas as pd

import config as C

OUT = C.REPO / "web" / "public" / "why"
NFDB = C.DATA / "external" / "nfdb" / "txt" / "NFDB_point_20260811.txt"

CAUSE = {"H": "human", "N": "lightning", "U": "unknown"}


def slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in s).strip("-")


def display_cell(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    f = h3.api.basic_int.latlng_to_cell  # integer cells, as the rest of the pipeline uses
    return np.fromiter((f(float(a), float(b), C.DISPLAY_RES) for a, b in zip(lat, lon)),
                       dtype=np.uint64, count=len(lat))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    regions = pd.read_parquet(C.INTERIM / "regions_cell5.parquet")  # cell5 -> region, province
    zone_of = dict(zip(regions.cell5, regions.region))

    # ---- NFDB: cause shares and the largest fires, per display cell and year
    nf = pd.read_csv(NFDB, encoding="latin-1", low_memory=False)
    nf = nf[(nf.YEAR >= 2000) & (nf.LATITUDE.notna()) & (nf.LONGITUDE.notna())]
    nf["cell5"] = display_cell(nf.LATITUDE.to_numpy(), nf.LONGITUDE.to_numpy())
    nf["cause"] = np.where(nf.PRESCRIBED.astype(str).str.upper().isin(["Y", "YES", "1", "TRUE"]),
                           "prescribed", nf.CAUSE.map(CAUSE).fillna("unknown"))
    # the last year each agency has reported, so the card can say when recent years are thin
    agency_last = nf.groupby("SRC_AGENCY").YEAR.max().to_dict()

    # ---- NBAC, per display cell and year.
    # fire_ha in nbac_cell8_year is the size of the WHOLE fire a ~1 km cell belongs to, not the
    # area burned inside that cell, so summing it would count one fire once per cell it touched.
    # The card reports the largest fire that reached the display cell that year, which is what
    # the number honestly supports.
    nb = pd.read_parquet(C.INTERIM / "nbac_cell8_year.parquet")
    nb["cell5"] = np.fromiter((h3.api.basic_int.cell_to_parent(int(c), C.DISPLAY_RES) for c in nb.cell8),
                              dtype=np.uint64, count=len(nb))
    nbac = nb.groupby(["cell5", "year"], as_index=False).fire_ha.max()

    # ---- land cover shares per display cell, from the fine cells that ever had fire
    lc = pd.read_parquet(C.INTERIM / "landcover_cell8.parquet")
    lc["cell5"] = np.fromiter((h3.api.basic_int.cell_to_parent(int(c), C.DISPLAY_RES) for c in lc.cell8),
                              dtype=np.uint64, count=len(lc))
    lc_share = (lc.groupby(["cell5", "lc"]).size().rename("n").reset_index())

    cells = sorted(set(zone_of) | set(nfdb_cells(nf)) | set(nbac.cell5) | set(lc_share.cell5))
    shards: dict[str, dict] = defaultdict(dict)

    nf_by_cell = {k: v for k, v in nf.groupby("cell5")}
    nbac_by_cell = {k: v for k, v in nbac.groupby("cell5")}
    lc_by_cell = {k: v for k, v in lc_share.groupby("cell5")}

    for cell in cells:
        rec: dict = {}
        fires = nf_by_cell.get(cell)
        if fires is not None and len(fires):
            counts = fires.cause.value_counts()
            rec["cause"] = {k: int(v) for k, v in counts.items()}
            rec["agency"] = sorted(fires.SRC_AGENCY.dropna().unique().tolist())
            big = fires.nlargest(3, "SIZE_HA")[["YEAR", "MONTH", "DAY", "SIZE_HA", "FIRENAME"]]
            rec["big"] = [
                {"y": int(r.YEAR), "m": int(r.MONTH) if r.MONTH > 0 else None,
                 "d": int(r.DAY) if r.DAY > 0 else None, "ha": round(float(r.SIZE_HA), 1),
                 "name": (str(r.FIRENAME).strip() or None) if pd.notna(r.FIRENAME) else None}
                for r in big.itertuples() if pd.notna(r.SIZE_HA)
            ]
            # hectares by month where NFDB gives a start month, else by year
            per = fires.dropna(subset=["SIZE_HA"])
            rec["nfdb_ha_year"] = {str(int(y)): round(float(v), 1)
                                   for y, v in per.groupby("YEAR").SIZE_HA.sum().items()}
        area = nbac_by_cell.get(cell)
        if area is not None and len(area):
            rec["nbac_largest_ha"] = {str(int(r.year)): round(float(r.fire_ha), 1) for r in area.itertuples()}
        cov = lc_by_cell.get(cell)
        if cov is not None and len(cov):
            tot = int(cov.n.sum())
            rec["lc"] = {str(r.lc): round(float(r.n) / tot, 3) for r in cov.itertuples()}
        if not rec:
            continue
        zone = zone_of.get(cell)
        shards[slug(zone) if zone else "other"][str(int(cell))] = rec

    index = {"zones": {}, "cause_codes": list(CAUSE.values()) + ["prescribed"],
             "agency_last_year": {k: int(v) for k, v in agency_last.items()},
             "note": "display only: NFDB causes and fire sizes, NBAC burned area, ESA WorldCover land cover"}
    total = 0
    for zone, payload in sorted(shards.items()):
        path = OUT / f"{zone}.json"
        path.write_text(json.dumps(payload, separators=(",", ":")))
        size = path.stat().st_size
        total += size
        index["zones"][zone] = {"cells": len(payload), "bytes": size}
    # No cell -> shard map: the browser already knows each cell's ecozone from the main export,
    # so it slugs the name itself. Cells with no ecozone fall back to the "other" shard.
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"why export: {len(shards)} shards, {sum(len(p) for p in shards.values()):,} cells, "
          f"{total / 1e6:.2f} MB + index {(OUT / 'index.json').stat().st_size / 1e6:.2f} MB")


def nfdb_cells(nf: pd.DataFrame):
    return nf.cell5.unique()


if __name__ == "__main__":
    main()
