"""Stage B experiments: NBAC fire size classes and NFDB reported-fire fill.

Same tests and metrics as experiments.py (backwards 2019-2025 -> 2012-2014, leave-one-year-out).

  *_size          extra stratum: NBAC size class of the fire each ~1 km cell-day falls in
                  ("no NBAC fire", <1k, 1k-10k, 10k-100k, 100k+ ha)
  *_nfdb_fill     two-part model. Cell-months where the MODIS input saw fire: ratio table.
                  Cell-months where it saw nothing: VIIRS cell-days per reported NFDB fire by
                  size class (non-negative least squares on training years), placed at the
                  reported fire's display cell. Zero-input VIIRS activity that reported fires do
                  not explain is spread back proportionally per parent region x season, so large-
                  area totals behave as before.

NFDB (National Fire Database fire points, CWFIS, Open Government Licence - Canada).
Outputs: reports/experiments/comparison_stage_b.csv|json, comparison_all.csv (stage A + B)
"""
from __future__ import annotations

import json

import h3
import numpy as np
import pandas as pd
from scipy.optimize import nnls

import calibrate as K
import config as C
import experiments as X

NFDB_FILE = next((C.DATA / "external" / "nfdb" / "txt").glob("NFDB_point_*.txt"))
NFDB_BINS = [1, 10, 100, 1_000]
NFDB_LABELS = ["<1 ha", "1-10 ha", "10-100 ha", "100-1k ha", "1k+ ha"]
AGENCY = {"AB": "Alberta", "BC": "British Columbia", "MB": "Manitoba", "NB": "New Brunswick",
          "NL": "Newfoundland and Labrador", "NS": "Nova Scotia", "NT": "Northwest Territories",
          "NU": "Nunavut", "ON": "Ontario", "PE": "Prince Edward Island", "QC": "Québec",
          "SK": "Saskatchewan", "YT": "Yukon"}
CM = ["cell5", "year", "month"]
RATES: list = []


def nfdb_counts() -> pd.DataFrame:
    d = pd.read_csv(NFDB_FILE, encoding="utf-8-sig", low_memory=False,
                    usecols=["SRC_AGENCY", "LATITUDE", "LONGITUDE", "YEAR", "MONTH", "SIZE_HA", "PRESCRIBED"])
    d = d[d.YEAR.between(2000, 2025) & d.MONTH.between(1, 12)]
    d = d[~d.PRESCRIBED.astype(str).str.strip().str.upper().isin(["PB", "1", "YES", "Y"])]
    d = d[d.LATITUDE.between(40, 85) & d.LONGITUDE.between(-142, -50)]
    f = h3.api.basic_int.latlng_to_cell
    d["cell5"] = np.fromiter((f(a, b, C.DISPLAY_RES) for a, b in zip(d.LATITUDE, d.LONGITUDE)), np.uint64, len(d))
    d["k"] = np.array(NFDB_LABELS, dtype=object)[np.digitize(d.SIZE_HA.fillna(0), NFDB_BINS)]
    n = d.groupby(["cell5", "YEAR", "MONTH", "k"]).size().unstack("k", fill_value=0).reindex(columns=NFDB_LABELS, fill_value=0)
    n.index = n.index.set_names(CM)
    n = n.reset_index().astype({"year": int, "month": int})
    agency = d.groupby("cell5").SRC_AGENCY.agg(lambda s: s.mode().iloc[0]).map(AGENCY)
    n["province_nfdb"] = n.cell5.map(agency)
    return n


def v_extra(den: str, key: str):
    def run(train, test):
        tab, lv = X.fit_table(train, "v", den, key)
        return X.apply_table(test, tab, lv, den, "v", train, key)
    return run


def add_union_frp_class(train, test):
    col = lambda df, c: sum(df[x] for x in c.split("+"))
    feat = lambda df: col(df, "a_frp+t_frp") / col(df, "a_det+t_det").replace(0, np.nan)
    edges = X.tercile_edges(train, feat(train), train.u_cd)
    return (train.assign(ic=np.digitize(feat(train).fillna(0), edges)),
            test.assign(ic=np.digitize(feat(test).fillna(0), edges)))


def v_union_size_frp(train, test):
    tr, te = add_union_frp_class(train, test)
    tr = tr.assign(sk=tr.sc + "|" + tr.ic.astype(str))
    te = te.assign(sk=te.sc + "|" + te.ic.astype(str))
    tab, lv = X.fit_table(tr, "v", "u_cd", "sk")
    return X.apply_table(te, tab, lv, "u_cd", "v", tr, "sk")


def v_fill(base_fn, den: str, fires: pd.DataFrame, regions: pd.DataFrame):
    def run(train, test):
        def cm_table(df):
            t = df.groupby(CM)[["v", den]].sum().reset_index()
            yrs = df.year.unique()
            f = fires[fires.year.isin(yrs)]
            t = t.merge(f, on=CM, how="outer").fillna({c: 0 for c in ["v", den] + NFDB_LABELS})
            return t
        tr_cm, te_cm = cm_table(train), cm_table(test)
        # part 1: ratio model fitted on cell-months where the MODIS input saw fire
        pos_tr = train.merge(tr_cm.loc[tr_cm[den] > 0, CM], on=CM)
        p_tr = base_fn(pos_tr, pos_tr)
        p_te = base_fn(pos_tr, test)
        # part 2: VIIRS cell-days per reported fire in zero-input cell-months
        z = tr_cm[tr_cm[den] == 0]
        beta, _ = nnls(z[NFDB_LABELS].to_numpy(float), z.v.to_numpy(float))
        RATES.append(dict(zip(NFDB_LABELS, np.round(beta, 3).tolist())))
        # remainder spread back per parent x season
        reg = regions.set_index("cell5")
        z = z.assign(fill=z[NFDB_LABELS].to_numpy(float) @ beta, parent=z.cell5.map(reg.parent),
                     season=z.month.map(K.SEASON))
        rem = z.groupby(["parent", "season"]).apply(lambda g: g.v.sum() - g.fill.sum(), include_groups=False)
        base = pos_tr.assign(p=p_tr).groupby(["parent", "season"]).p.sum()
        rho = (rem / base).clip(lower=-0.5).fillna(0)
        rho_all = (z.v.sum() - z.fill.sum()) / p_tr.sum()
        r = test[["parent", "season"]].merge(rho.rename("rho").reset_index(), on=["parent", "season"], how="left")["rho"]
        pred = p_te * (1 + r.fillna(rho_all).to_numpy())
        tz = te_cm[te_cm[den] == 0].copy()
        tz["pred"] = tz[NFDB_LABELS].to_numpy(float) @ beta
        tz = tz[tz.pred > 0]
        extra = tz[CM + ["pred", "province_nfdb"]].merge(regions[["cell5", "province"]], on="cell5", how="left")
        extra["province"] = extra["province"].fillna(extra.pop("province_nfdb"))
        extra = X.K.add_scales(extra)
        return pred, extra
    return run


def main() -> None:
    X.OUT.mkdir(parents=True, exist_ok=True)
    E = X.load_or_build(with_size=True)
    E = E[E.year.isin(K.TRAIN_ALL)].reset_index(drop=True)
    print(f"base rows {len(E):,}; size classes: " +
          ", ".join(f"{k} {100*v:.0f}%" for k, v in (E.groupby('sc').v.sum() / E.v.sum()).items()) + " of VIIRS", flush=True)
    fires = nfdb_counts()
    regions = pd.read_parquet(C.INTERIM / "regions_cell5.parquet")
    union_frp = X.v_intensity("frp", "u_cd", "a_det+t_det", "a_frp+t_frp")
    variants = [
        ("table_aqua (current)", X.v_table("a_cd"), "a_cd"),
        ("union_frp (stage A)", union_frp, "u_cd"),
        ("aqua_size", v_extra("a_cd", "sc"), "a_cd"),
        ("union_size", v_extra("u_cd", "sc"), "u_cd"),
        ("union_size_frp", v_union_size_frp, "u_cd"),
        ("table_aqua + nfdb_fill", v_fill(X.v_table("a_cd"), "a_cd", fires, regions), "a_cd"),
        ("union_frp + nfdb_fill", v_fill(union_frp, "u_cd", fires, regions), "u_cd"),
    ]
    rows = []
    for n, f, c in variants:
        RATES.clear()
        r = X.run_variant(n, f, E, c)
        if RATES:
            r["nfdb_rates_mean"] = {k: round(float(np.mean([x[k] for x in RATES])), 3) for k in NFDB_LABELS}
            print(f"     NFDB VIIRS cell-days per reported fire in zero-input cell-months: {r['nfdb_rates_mean']}")
        rows.append(r)
    pd.DataFrame(rows).drop(columns=["loyo_year_errors"]).to_csv(X.OUT / "comparison_stage_b.csv", index=False)
    (X.OUT / "comparison_stage_b.json").write_text(json.dumps(rows, indent=1, default=str))
    # combined table: stage A (experiments.py) then stage B, one row per variant
    a = json.loads((X.OUT / "comparison_stage_a.json").read_text())["rows"]
    seen, combined = set(), []
    for r in a + rows:
        name = r["variant"].replace(" (stage A)", "")
        if name not in seen:
            seen.add(name)
            combined.append({**r, "variant": name})
    pd.DataFrame(combined).drop(columns=["loyo_year_errors", "nfdb_rates_mean"], errors="ignore").to_csv(
        X.OUT / "comparison_all.csv", index=False)


if __name__ == "__main__":
    main()
