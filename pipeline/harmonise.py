"""Step 2c: apply the adopted model to the years without VIIRS.

Adopted after the out-of-sample comparison in reports/experiments/comparison_all.csv:
  Aug 2002 - Jan 2012   union_frp: VIIRS / (Aqua or Terra cell-days) ratio per
                        region x land cover x season x FRP tercile (mean FRP per detection)
  Nov 2000 - Jul 2002   terra_frp: VIIRS / Terra cell-days ratio per
                        region x land cover x season x FRP tercile (Terra only in those months)
  fallback              the original VIIRS / Aqua table (calibrate.py), used for any estimated
                        month in which the model's MODIS input does not have full coverage
Tables are fitted on 2012-2025 on days when Aqua, Terra and at least one VIIRS platform were
available. Observed and near-real-time months are VIIRS data and are not changed.

Inputs:  data/interim/experiments_base.parquet (experiments.py), calibrate.py outputs
Outputs: data/processed/harmonised_cell_month.parquet (replaces estimated months)
         data/processed/harmonised_cell_month_table.parquet (calibrate.py version, kept for checks)
         reports/calibration/month_sources.csv (source names updated)
         reports/calibration/adopted_model.json (tables' FRP edges, LOYO metrics by scale)
         reports/calibration/canada_annual_series.csv
"""
from __future__ import annotations

import json
import shutil

import numpy as np
import pandas as pd

import calibrate as K
import config as C
import experiments as X

PROCESSED = C.DATA / "processed"
OUT = C.REPORTS / "calibration"
MODELS = {
    "estimated_from_modis": {"den": "u_cd", "det": ("a_det", "t_det"), "frp": ("a_frp", "t_frp"),
                             "den_all": "u_all", "det_all": ("a_det_all", "t_det_all"), "frp_all": ("a_frp_all", "t_frp_all")},
    "estimated_from_terra": {"den": "t_cd", "det": ("t_det",), "frp": ("t_frp",),
                             "den_all": "t_all", "det_all": ("t_det_all",), "frp_all": ("t_frp_all",)},
}


def feature(df, det, frp):
    d = sum(df[c] for c in det)
    f = sum(df[c] for c in frp)
    return f / d.where(d > 0)


def fit(train: pd.DataFrame, m: dict):
    x = feature(train, m["det"], m["frp"])
    edges = X.tercile_edges(train, x, train[m["den"]])
    tr = train.assign(ic=np.digitize(x.fillna(0), edges))
    tab, lv = X.fit_table(tr, "v", m["den"], "ic")
    return edges, tab, lv, tr


def predict(df: pd.DataFrame, edges, tab, lv, tr, m: dict, use_all: bool) -> np.ndarray:
    den = m["den_all"] if use_all else m["den"]
    x = feature(df, m["det_all"] if use_all else m["det"], m["frp_all"] if use_all else m["frp"])
    d = df.assign(ic=np.digitize(x.fillna(0), edges), _den=df[den])
    return X.apply_table(d, tab, lv, "_den", "v", tr.assign(_den=tr[m["den"]]), "ic")


def loyo(E: pd.DataFrame, m: dict) -> tuple[dict, list]:
    parts = []
    for y in K.TRAIN_ALL:
        edges, tab, lv, tr = fit(E[E.year.isin([x for x in K.TRAIN_ALL if x != y])], m)
        te = E[E.year == y].copy()
        te["pred"] = predict(te, edges, tab, lv, tr, m, use_all=False)
        parts.append(te)
    df = pd.concat(parts, ignore_index=True)
    yr = df.groupby("year")[["pred", "v"]].sum()
    r = yr.v / yr.pred
    return K.evaluate(df, "pred", "v"), [round(float(r.min()), 3), round(float(r.max()), 3)], \
        {int(k): round(float(100 * (p / v - 1)), 1) for k, p, v in zip(yr.index, yr.pred, yr.v)}


def main() -> None:
    E = X.load_or_build()
    train = E[E.year.isin(K.TRAIN_ALL)]
    src = pd.read_csv(OUT / "month_sources.csv")
    src["source"] = src["source"].replace({"estimated_from_aqua": "estimated_from_modis"})
    cov = pd.read_parquet(C.INTERIM / "coverage.parquet").pivot_table(
        index=["year", "month"], columns="platform", values="coverage", aggfunc="first").reset_index()
    src = src.merge(cov[["year", "month", "aqua", "terra"]], on=["year", "month"], how="left")
    # model needs full coverage of its MODIS input; otherwise fall back to the Aqua table
    needs_terra = src.source.isin(["estimated_from_modis", "estimated_from_terra"])
    fallback = needs_terra & ~src.terra.eq("full") & ~(src.source.eq("estimated_from_terra") & src.terra.eq("partial"))
    src["model"] = np.where(fallback, "fallback_aqua_table", np.where(needs_terra, src.source, ""))
    src.drop(columns=["aqua", "terra"]).to_csv(OUT / "month_sources.csv", index=False)

    table_path = PROCESSED / "harmonised_cell_month.parquet"
    keep = PROCESSED / "harmonised_cell_month_table.parquet"
    shutil.copyfile(table_path, keep)
    H_old = pd.read_parquet(keep)

    report = {"fit_years": [K.TRAIN_ALL[0], K.TRAIN_ALL[-1]], "models": {}}
    est_parts = []
    for name, m in MODELS.items():
        edges, tab, lv, tr = fit(train, m)
        months = src.loc[src.model.eq(name), ["year", "month"]]
        rows = E.merge(months, on=["year", "month"])
        rows = rows.assign(cell_days=predict(rows, edges, tab, lv, tr, m, use_all=True))
        est_parts.append(rows.groupby(["cell5", "year", "month"]).cell_days.sum().reset_index())
        ev, rng, per_year = loyo(train, m)
        tab.to_csv(OUT / f"ratio_{name}.csv", index=False)
        report["models"][name] = {"frp_tercile_edges_mw": [round(float(e), 2) for e in edges],
                                  "loyo": ev, "loyo_canada_obs_over_pred_range": rng, "loyo_year_error_pct": per_year,
                                  "levels_used": tab.level.value_counts().to_dict(),
                                  "months": int(len(months))}
        print(f"{name}: {len(months)} months, LOYO Canada-year range {rng}, "
              f"12k-year wAbsErr {ev['~12,400 km2 (H3 res 3) | year']['weighted_abs_error_pct']}%")

    est = pd.concat(est_parts, ignore_index=True)
    est = est[est.cell_days > 0].merge(src[["year", "month", "source", "partial"]], on=["year", "month"])
    replaced = src.loc[src.model.isin(list(MODELS)), ["year", "month"]]
    keep_rows = H_old.merge(replaced.assign(_r=1), on=["year", "month"], how="left")
    keep_rows = keep_rows[keep_rows._r.isna()].drop(columns="_r")
    keep_rows["source"] = keep_rows["source"].replace({"estimated_from_aqua": "estimated_from_modis"})
    H = pd.concat([keep_rows[["cell5", "year", "month", "source", "partial", "cell_days"]], est], ignore_index=True)
    H = H.sort_values(["cell5", "year", "month"]).reset_index(drop=True)
    H.to_parquet(table_path, index=False)
    report["fallback_months"] = src.loc[src.model.eq("fallback_aqua_table"), ["year", "month"]].to_dict("records")
    (OUT / "adopted_model.json").write_text(json.dumps(report, indent=1))

    # Canada annual series with ranges (full LOYO range for the Canada-wide annual scale)
    a = H.groupby("year").cell_days.sum().rename("harmonised").to_frame()
    old = H_old.groupby("year").cell_days.sum().rename("old_table")
    base = pd.read_csv(OUT / "canada_annual_series.csv", index_col="year")[["aqua", "terra", "vref"]]
    a = a.join(old).join(base)
    srcy = src.groupby("year").source.agg(lambda s: "/".join(sorted(set(s))))
    a = a.join(srcy)
    lo, hi = np.ones(len(a)), np.ones(len(a))
    for name in MODELS:
        r = report["models"][name]["loyo_canada_obs_over_pred_range"]
        sel = a.source.str.contains(name).to_numpy() & ~a.source.str.contains("observed").to_numpy()
        lo = np.where(sel, np.minimum(lo, r[0]), lo)
        hi = np.where(sel, np.maximum(hi, r[1]), hi)
    a["low"], a["high"] = a.harmonised * lo, a.harmonised * hi
    a["partial_year"] = a.index.isin([2000, a.index.max()])
    a.round(1).to_csv(OUT / "canada_annual_series.csv")
    print(a.loc[:2012, ["aqua", "terra", "old_table", "harmonised", "low", "high", "source"]].round(0).to_string())
    print("fallback months:", report["fallback_months"])


if __name__ == "__main__":
    main()
