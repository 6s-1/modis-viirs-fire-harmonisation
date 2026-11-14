"""Independent check against NBAC burned area (not a model input; nothing is tuned to it).

For each ecozone, annual NBAC burned area is related to annual fire cell-days with one ratio
(hectares per cell-day), fitted on the observed years 2012-2025. The same ratio is then applied
to the estimated years and compared with NBAC. Done for three series:
  raw MODIS Aqua     same sensor in both periods: shows how stable the NBAC relation itself is
  old table          VIIRS/Aqua ratio table (calibrate.py)
  adopted model      union + FRP class from Aug 2002, Terra + FRP class before (harmonise.py)
A harmonised series that is consistent across the 2012 switch should show a bias and scatter in
the estimated years similar to raw Aqua's.

Evaluation years: 2003-2011 (first full Aqua year onward, so all three series cover the same
years); 2001-2002 reported separately for the two harmonised series (2000 has Nov-Dec only).
NBAC area is assigned to an ecozone by each polygon's representative point. Prescribed burns are
excluded. Ecozones with < MIN_HA burned in 2012-2025 are left out (too little signal).

Outputs: reports/nbac_check/nbac_check.json, nbac_check_ecozone_year.csv,
         reports/figures/nbac_check.png
"""
from __future__ import annotations

import json

import geopandas as gpd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import config as C
import nbac_link
from regions import PARENT

OUT = C.REPORTS / "nbac_check"
MIN_HA = 100_000
FIT = range(2012, 2026)
EVAL = range(2003, 2012)
EARLY = range(2001, 2003)  # 2000 has Nov-Dec cell-days only, NBAC is the full year


def nbac_by_ecozone() -> pd.DataFrame:
    eco = gpd.read_file(C.DATA / "external" / "ecozones" / "ecozones.shp")
    eco["region"] = (eco["ZONE_NAME"].str.strip().str.replace("PLain", "Plain").str.replace(r"\s+", " ", regex=True)
                     .replace({"MixedWood Plain": "Mixedwood Plain"}))
    eco = eco.dissolve("region").reset_index()[["region", "geometry"]]
    rows = []
    for y in range(2000, 2026):
        g = nbac_link.read_year(y)
        if g is None:
            continue
        # read_year gives fire size per polygon; use the polygon's own area here
        shp = next((nbac_link.NBAC / f"x{y}").rglob("*.shp"))
        p = gpd.read_file(shp, columns=["ADJ_HA", "PRESCRIBED"])
        p = p[p["PRESCRIBED"].isna() | ~p["PRESCRIBED"].astype(str).str.strip().str.lower().isin(["pb", "yes", "y", "1", "true"])]
        pts = gpd.GeoDataFrame({"ha": p["ADJ_HA"].to_numpy()}, geometry=p.geometry.representative_point(), crs=p.crs)
        j = gpd.sjoin(pts, eco.to_crs(p.crs), how="left", predicate="within")
        s = j.groupby("region").ha.sum()
        rows += [{"region": r, "year": y, "nbac_ha": float(v)} for r, v in s.items()]
        rows.append({"region": "_unassigned", "year": y, "nbac_ha": float(j[j.region.isna()].ha.sum())})
    return pd.DataFrame(rows)


def series() -> pd.DataFrame:
    reg = pd.read_parquet(C.INTERIM / "regions_cell5.parquet")[["cell5", "region"]]
    new = pd.read_parquet(C.DATA / "processed" / "harmonised_cell_month.parquet")
    old = pd.read_parquet(C.DATA / "processed" / "harmonised_cell_month_table.parquet")
    base = pd.read_parquet(C.INTERIM / "calibration_base.parquet", columns=["cell5", "year", "aqua", "terra"])
    out = []
    for name, df, col in (("raw MODIS Aqua", base, "aqua"), ("old table", old, "cell_days"),
                          ("adopted model", new, "cell_days"), ("raw MODIS Terra (diagnostic)", base, "terra")):
        s = df.merge(reg, on="cell5").groupby(["region", "year"])[col].sum().rename("cd").reset_index()
        out.append(s.assign(series=name))
    return pd.concat(out, ignore_index=True)


def evaluate(d: pd.DataFrame, years) -> dict:
    e = d[d.year.isin(years) & d.pred.notna()]
    if e.empty:
        return {}
    ok = (e.nbac_ha > 0) & (e.pred > 0)
    lr = np.log(e.pred[ok] / e.nbac_ha[ok])
    canada = e.groupby("year")[["pred", "nbac_ha"]].sum()
    return {
        "bias_pct": round(float(100 * (e.pred.sum() / e.nbac_ha.sum() - 1)), 1),
        "weighted_abs_error_pct": round(float(100 * (e.pred - e.nbac_ha).abs().sum() / e.nbac_ha.sum()), 1),
        "median_abs_log_ratio": round(float(np.median(np.abs(lr))), 3),
        "ecozone_years": int(len(e)),
        "canada_annual_abs_error_pct_median": round(float(100 * np.median(np.abs(canada.pred / canada.nbac_ha - 1))), 1),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    nb = nbac_by_ecozone()
    s = series()
    d = s.merge(nb, on=["region", "year"], how="outer").fillna({"cd": 0.0, "nbac_ha": 0.0})
    d = d[d.series.notna()]
    fit_ha = nb[nb.year.isin(FIT)].groupby("region").nbac_ha.sum()
    zones = [z for z, v in fit_ha.items() if v >= MIN_HA and z in PARENT]
    d = d[d.region.isin(zones)]
    k = (d[d.year.isin(FIT)].groupby(["series", "region"]).apply(
        lambda g: g.nbac_ha.sum() / g.cd.sum() if g.cd.sum() > 0 else np.nan, include_groups=False).rename("ha_per_cd"))
    d = d.merge(k.reset_index(), on=["series", "region"], how="left")
    d["pred"] = d.ha_per_cd * d.cd
    d.loc[(d.series == "raw MODIS Aqua") & (d.year < 2003), "pred"] = np.nan  # Aqua starts Jul 2002
    d.to_csv(OUT / "nbac_check_ecozone_year.csv", index=False)

    res = {"ecozones": zones, "fit_years": [FIT.start, FIT.stop - 1], "eval_years": [EVAL.start, EVAL.stop - 1],
           "unassigned_share_pct": round(float(100 * nb[nb.region == "_unassigned"].nbac_ha.sum() / nb.nbac_ha.sum()), 2),
           "series": {}}
    for name, g in d.groupby("series"):
        res["series"][name] = {"fit_years_in_sample": evaluate(g, FIT), "estimated_years_2003_2011": evaluate(g, EVAL),
                               "early_2001_2002": evaluate(g, EARLY)}
    can = d[d.year.between(2001, 2011) & d.pred.notna()].groupby(["series", "year"])[["pred", "nbac_ha"]].sum()
    res["canada_annual_error_pct"] = {s_: {int(y): round(float(100 * (r.pred / r.nbac_ha - 1)), 1) for (ss, y), r in can.iterrows() if ss == s_}
                                      for s_ in can.index.get_level_values(0).unique()}
    (OUT / "nbac_check.json").write_text(json.dumps(res, indent=1))

    # figure: three panels, predicted vs NBAC burned area per ecozone-year (log-log)
    INK2, GRID, SURFACE = "#52514e", "#e4e3df", "#fcfcfb"
    order = ["raw MODIS Aqua", "old table", "adopted model"]
    fig, axes = plt.subplots(1, 3, figsize=(12, 4.3), dpi=150, sharex=True, sharey=True, facecolor=SURFACE)
    lo, hi = 1e2, d[["pred", "nbac_ha"]].max().max() * 1.5
    for ax, name in zip(axes, order):
        g = d[d.series == name]
        ax.set_facecolor(SURFACE)
        ax.plot([lo, hi], [lo, hi], color=INK2, lw=0.8, ls=(0, (4, 3)))
        f = g[g.year.isin(FIT) & (g.pred > 0) & (g.nbac_ha > 0)]
        e = g[g.year.isin(EVAL) & (g.pred > 0) & (g.nbac_ha > 0)]
        ax.scatter(f.nbac_ha, f.pred, s=14, color="#b8b7b1", lw=0, label="2012–2025 (fit years)")
        ax.scatter(e.nbac_ha, e.pred, s=22, facecolor="none", edgecolor="#2a78d6", lw=1.3, label="2003–2011 (estimated years)")
        m = res["series"][name]["estimated_years_2003_2011"]
        ax.set_title(f"{name}\n2003–2011: bias {m['bias_pct']:+.0f}%, median |log ratio| {m['median_abs_log_ratio']:.2f}",
                     fontsize=9.5, loc="left")
        ax.set_xscale("log"); ax.set_yscale("log"); ax.set_xlim(lo, hi); ax.set_ylim(lo, hi)
        ax.grid(color=GRID, lw=0.6)
        for sp in ("top", "right"):
            ax.spines[sp].set_visible(False)
        ax.set_xlabel("NBAC burned area (ha)", color=INK2, fontsize=9)
    axes[0].set_ylabel("Burned area implied by cell-days (ha)", color=INK2, fontsize=9)
    axes[0].legend(frameon=False, fontsize=8, loc="upper left")
    fig.suptitle("Independent check against NBAC: one ha-per-cell-day ratio per ecozone, fitted on 2012–2025",
                 x=0.01, ha="left", fontsize=11)
    fig.tight_layout()
    fig.savefig(C.REPORTS / "figures" / "nbac_check.png", facecolor=SURFACE)
    print(json.dumps(res["series"], indent=1))
    print("ecozones used:", zones, "| NBAC area not in any ecozone: %s%%" % res["unassigned_share_pct"])


if __name__ == "__main__":
    main()
