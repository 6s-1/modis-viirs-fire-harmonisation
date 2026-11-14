"""Harmonisation upgrade experiments, compared against the current ratio table.

Every variant is fitted and tested on the same data:
  * common day mask: Aqua, Terra and at least one VIIRS platform available
  * backwards test: fit 2019-2025, predict 2012-2014
  * leave-one-year-out (LOYO) over 2012-2025
Errors are reported at display cell, ~12,400 km2, province and Canada scale.

Variants (all explainable: extra strata in the table or a small log-linear fit)
  table_aqua         current method: VIIRS/Aqua ratio per region x land cover x season
  intensity_dpc      + Aqua detections per cell-day class (terciles) as an extra stratum
  intensity_frp      + Aqua mean FRP per detection class (terciles) as an extra stratum
  loglin_aqua        table_aqua x exp(b . [log detections per cell-day, log mean FRP]),
                     Poisson fit with the table as offset
  table_terra        VIIRS/Terra ratio table (Terra as the only MODIS input)
  table_union        VIIRS/(Aqua or Terra) ratio table, union of MODIS cell-days
  ... plus NBAC/NFDB variants when those inputs exist (experiments_nbac.py)

Outputs: reports/experiments/comparison.csv, comparison.json
"""
from __future__ import annotations

import json

import h3
import numpy as np
import pandas as pd

import calibrate as K
import config as C

OUT = C.REPORTS / "experiments"
BASE = ["region", "lc", "season"]
FALLBACK = [("region", "lc", "season"), ("region", "lc"), ("parent", "lc", "season"), ("parent", "lc"),
            ("lc", "season"), ("lc",), ()]
KEYS = ["cell5", "year", "month", "lc"]


# ------------------------------------------------------------------ base table
SIZE_BINS = [1_000, 10_000, 100_000]
SIZE_LABELS = ["<1k ha", "1k-10k ha", "10k-100k ha", "100k+ ha"]


def size_class(ha: pd.Series) -> pd.Series:
    lab = pd.Series(np.array(SIZE_LABELS, dtype=object)[np.digitize(ha.fillna(0), SIZE_BINS)], index=ha.index)
    return lab.where(ha.notna(), "no NBAC fire")


def build(av: pd.DataFrame, sc: pd.DataFrame | None = None) -> pd.DataFrame:
    fine = pd.read_parquet(C.INTERIM / "cell_days_fine.parquet",
                           columns=["cell8", "date", "platform", "n_det", "frp_sum", "year", "month"])
    fine["platform"] = fine["platform"].astype(str)
    lc = pd.read_parquet(C.INTERIM / "landcover_cell8.parquet")
    fine = fine.merge(lc, on="cell8", how="left")
    fine["lc"] = fine["lc"].astype(object).where(fine["lc"].notna(), "other").astype(str)
    keys = KEYS + (["sc"] if sc is not None else [])
    if sc is not None:
        fine = fine.merge(sc, on=["cell8", "year"], how="left")
        fine["sc"] = size_class(fine.pop("fire_ha"))
    uniq, inv = np.unique(fine["cell8"].to_numpy(), return_inverse=True)
    par = np.fromiter((h3.api.basic_int.cell_to_parent(int(c), C.DISPLAY_RES) for c in uniq), np.uint64, len(uniq))
    fine["cell5"] = par[inv]
    a = av.reindex(fine["date"]).to_numpy()
    col = {p: i for i, p in enumerate(av.columns)}
    m_vt = a[:, col["aqua"]] & a[:, col["terra"]] & (a[:, col["snpp"]] | a[:, col["noaa20"]])
    m_at = a[:, col["aqua"]] & a[:, col["terra"]]
    snpp_av, n20_av = a[:, col["snpp"]], a[:, col["noaa20"]]
    fine = fine.assign(m_vt=m_vt, m_at=m_at, a_s=snpp_av, a_n=n20_av)

    p = fine.platform
    flag = lambda name: (p == name).astype("float32")
    fine = fine.assign(
        is_a=flag("aqua"), is_t=flag("terra"), is_s=flag("snpp"), is_n=flag("noaa20"),
        a_det=np.where(p == "aqua", fine.n_det, 0), a_frp=np.where(p == "aqua", fine.frp_sum, 0),
        t_det=np.where(p == "terra", fine.n_det, 0), t_frp=np.where(p == "terra", fine.frp_sum, 0))
    g = (fine.groupby(["cell8", "date"], sort=False)
             .agg(**({"sc": ("sc", "first")} if sc is not None else {}),
                  cell5=("cell5", "first"), lc=("lc", "first"), year=("year", "first"), month=("month", "first"),
                  m_vt=("m_vt", "first"), m_at=("m_at", "first"), a_s=("a_s", "first"), a_n=("a_n", "first"),
                  a=("is_a", "max"), t=("is_t", "max"), s=("is_s", "max"), n=("is_n", "max"),
                  a_det=("a_det", "sum"), a_frp=("a_frp", "sum"), t_det=("t_det", "sum"), t_frp=("t_frp", "sum"))
             .reset_index(drop=True))
    del fine
    k = g.a_s.astype(int) + g.a_n.astype(int)
    vref = np.where(k > 0, (g.s * g.a_s + g.n * g.a_n) / k.clip(lower=1), 0.0)
    mv = g.m_vt.to_numpy() & (k > 0).to_numpy()
    ma = g.m_at.to_numpy()
    E = pd.DataFrame({
        **{c: g[c] for c in keys},
        "v": vref * mv,
        "a_cd": g.a * mv, "a_det": g.a_det * mv, "a_frp": g.a_frp * mv,
        "t_cd": g.t * mv, "t_det": g.t_det * mv, "t_frp": g.t_frp * mv,
        "u_cd": np.maximum(g.a, g.t) * mv,
        "a_ov": g.a * ma, "t_ov": g.t * ma,            # Terra/Aqua overlap (any year)
        # unmasked inputs, used to apply a fitted model in years without VIIRS
        "a_all": g.a, "t_all": g.t, "u_all": np.maximum(g.a, g.t),
        "a_det_all": g.a_det, "a_frp_all": g.a_frp, "t_det_all": g.t_det, "t_frp_all": g.t_frp,
    })
    E = E.groupby(keys, sort=False).sum().reset_index()
    reg = pd.read_parquet(C.INTERIM / "regions_cell5.parquet")[["cell5", "region", "parent", "province"]]
    E = E.merge(reg, on="cell5", how="left")
    E["season"] = E["month"].map(K.SEASON)
    return K.add_scales(E)


# ------------------------------------------------------------------ generic table fit
def levels_with(extra: str | None):
    if not extra:
        return FALLBACK
    return [lv + (extra,) for lv in FALLBACK[:-1]] + [(extra,)] + FALLBACK


def fit_table(train: pd.DataFrame, num: str, den: str, extra: str | None = None) -> tuple[pd.DataFrame, list]:
    keys = BASE + ([extra] if extra else [])
    levels = levels_with(extra)
    u = train[keys + ["parent"]].drop_duplicates(keys).reset_index(drop=True)
    u["ratio"] = np.nan
    u["level"] = None
    t = train[train[den] > 0]
    for lv in levels:
        lv = list(lv)
        if lv:
            s = train.groupby(lv)[[num, den]].sum().join(t.groupby(lv)["year"].nunique().rename("years")).reset_index()
            m = u[lv].merge(s, on=lv, how="left")
        else:
            m = pd.DataFrame({num: [train[num].sum()] * len(u), den: [train[den].sum()] * len(u),
                              "years": [t.year.nunique()] * len(u)})
        ok = u.level.isna().to_numpy() & (m[den].to_numpy() >= K.MIN_DEN) & (m["years"].to_numpy() >= K.MIN_YEARS)
        if not lv:
            ok = u.level.isna().to_numpy()
        u.loc[ok, "ratio"] = (m[num] / m[den]).to_numpy()[ok]
        u.loc[ok, "level"] = " x ".join(lv) or "all"
    return u, levels


def apply_table(df: pd.DataFrame, table: pd.DataFrame, levels: list, den: str, num: str, train: pd.DataFrame,
                extra: str | None = None) -> np.ndarray:
    """Predict num = ratio x den. Strata unseen in training fall back through `levels`."""
    keys = BASE + ([extra] if extra else [])
    r = df[keys + ["parent"]].merge(table[keys + ["ratio"]], on=keys, how="left")["ratio"].to_numpy(dtype=float, copy=True)
    miss = np.isnan(r)
    if miss.any():
        for lv in levels:
            lv = list(lv)
            if not miss.any():
                break
            if lv:
                s = train.groupby(lv)[[num, den]].sum()
                s = s[s[den] >= K.MIN_DEN]
                rr = df.loc[miss, lv].merge((s[num] / s[den]).rename("r").reset_index(), on=lv, how="left")["r"].to_numpy()
            else:
                rr = np.full(miss.sum(), train[num].sum() / train[den].sum())
            fill = ~np.isnan(rr)
            idx = np.where(miss)[0][fill]
            r[idx] = rr[fill]
            miss = np.isnan(r)
    return r * df[den].to_numpy()


# ------------------------------------------------------------------ variants
def tercile_edges(train: pd.DataFrame, x: pd.Series, w: pd.Series) -> np.ndarray:
    ok = (w > 0) & np.isfinite(x)
    xs, ws = x[ok].to_numpy(), w[ok].to_numpy()
    o = np.argsort(xs)
    cw = np.cumsum(ws[o]) / ws.sum()
    return np.array([xs[o][np.searchsorted(cw, q)] for q in (1 / 3, 2 / 3)])


def v_table(den: str):
    def run(train, test):
        tab, lv = fit_table(train, "v", den)
        return apply_table(test, tab, lv, den, "v", train)
    return run


def v_intensity(kind: str, den: str = "a_cd", det: str = "a_det", frp: str = "a_frp"):
    """Extra stratum: tercile of detections per cell-day (dpc) or mean FRP per detection (frp).
    det/frp may be '+'-joined column names, summed (e.g. Aqua + Terra)."""
    col = lambda df, c: sum(df[x] for x in c.split("+"))

    def feat(df):
        with np.errstate(divide="ignore", invalid="ignore"):
            return (col(df, det) / df[den]) if kind == "dpc" else (col(df, frp) / col(df, det))

    def run(train, test):
        edges = tercile_edges(train, feat(train), train[den])
        tr = train.assign(ic=np.digitize(feat(train).fillna(0), edges))
        te = test.assign(ic=np.digitize(feat(test).fillna(0), edges))
        tab, lv = fit_table(tr, "v", den, "ic")
        return apply_table(te, tab, lv, den, "v", tr, "ic")
    return run


def poisson_fit(X: np.ndarray, y: np.ndarray, offset: np.ndarray, iters: int = 50) -> np.ndarray:
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        eta = offset + X @ b
        mu = np.exp(eta)
        W = mu
        z = (eta - offset) + (y - mu) / mu
        XtW = X.T * W
        b_new = np.linalg.solve(XtW @ X + 1e-9 * np.eye(len(b)), XtW @ z)
        if np.max(np.abs(b_new - b)) < 1e-8:
            b = b_new
            break
        b = b_new
    return b


LOGLIN_COEF = []


def v_loglin(train, test):
    tab, lv = fit_table(train, "v", "a_cd")
    base_tr = apply_table(train, tab, lv, "a_cd", "v", train)
    base_te = apply_table(test, tab, lv, "a_cd", "v", train)

    def X(df):
        with np.errstate(divide="ignore", invalid="ignore"):
            dpc = np.log((df.a_det / df.a_cd).to_numpy())
            frp = np.log((df.a_frp / df.a_det).clip(lower=0.1).to_numpy())
        return np.column_stack([np.ones(len(df)), dpc, frp])
    ok = (train.a_cd > 0).to_numpy() & (base_tr > 0)
    Xtr = X(train)[ok]
    mu_x = np.average(Xtr[:, 1:], axis=0, weights=train.a_cd.to_numpy()[ok])
    Xtr[:, 1:] -= mu_x
    b = poisson_fit(Xtr, train.v.to_numpy()[ok], np.log(base_tr[ok]))
    LOGLIN_COEF.append(b.tolist())
    Xte = X(test)
    Xte[:, 1:] -= mu_x
    pred = base_te * np.exp(np.nan_to_num(Xte @ b, nan=0.0, posinf=0.0, neginf=0.0))
    return np.where(test.a_cd.to_numpy() > 0, pred, 0.0)


def v_terra_chain(train, test, overlap: pd.DataFrame):
    """Terra-only input, current method: Terra->Aqua (2002-07..2007-12 overlap) then VIIRS/Aqua."""
    ta, lv_ta = fit_table(overlap, "a_ov", "t_ov")
    aq_eq = apply_table(test.assign(t_ov=test.t_cd), ta, lv_ta, "t_ov", "a_ov", overlap)
    va, lv_va = fit_table(train, "v", "a_cd")
    return apply_table(test.assign(a_cd=aq_eq), va, lv_va, "a_cd", "v", train)


# ------------------------------------------------------------------ evaluation
def summarise(name: str, test_back: pd.DataFrame, loyo: pd.DataFrame, input_col: str) -> dict:
    out = {"variant": name}
    for label, df in (("back", test_back), ("loyo", loyo)):
        ev = K.evaluate(df, "pred", "v")
        for key, short in (("display cell (~253 km2) | year", "cell"), ("~12,400 km2 (H3 res 3) | year", "12k"),
                           ("province | year", "prov"), ("all Canada | year", "canada"),
                           ("display cell (~253 km2) | month", "cell_month")):
            out[f"{label}_{short}_wabs"] = ev[key]["weighted_abs_error_pct"]
        out[f"{label}_bias"] = ev["all Canada | year"]["bias_pct"]
        y = df.groupby("year")[["pred", "v"]].sum()
        out[f"{label}_2014"] = round(float(100 * (y.loc[2014, "pred"] / y.loc[2014, "v"] - 1)), 1)
        if label == "loyo":
            r = y.v / y.pred
            out["loyo_canada_range"] = [round(float(r.min()), 3), round(float(r.max()), 3)]
            out["loyo_year_errors"] = {int(k): round(float(100 * (v - 1)), 1) for k, v in (y.pred / y.v).items()}
    cm = loyo.groupby(["cell5", "year", "month"])[["v", input_col, "pred"]].sum()
    zero = cm[input_col] == 0
    out["viirs_share_in_zero_input_cell_months_pct"] = round(float(100 * cm.loc[zero, "v"].sum() / cm.v.sum()), 1)
    # of that zero-input activity, how much is now placed in the right cell-month (min of pred, obs)
    out["zero_input_viirs_located_pct"] = round(float(100 * np.minimum(cm.loc[zero, "pred"], cm.loc[zero, "v"]).sum()
                                                     / max(cm.loc[zero, "v"].sum(), 1e-9)), 1)
    return out


def with_pred(fn, train, test):
    """fn returns predictions for test rows, or (predictions, extra rows with a 'pred' column)."""
    res = fn(train, test)
    if isinstance(res, tuple):
        pred, extra = res
        test["pred"] = pred
        extra = extra.assign(v=0.0)
        return pd.concat([test, extra], ignore_index=True).fillna({c: 0.0 for c in test.columns if test[c].dtype.kind == "f"})
    test["pred"] = res
    return test


def run_variant(name, fn, E, input_col):
    back_train = E[E.year.isin(K.TRAIN_BACK)]
    back_test = with_pred(fn, back_train, E[E.year.isin(K.TEST_BACK)].copy())
    parts = []
    for y in K.TRAIN_ALL:
        tr = E[E.year.isin([x for x in K.TRAIN_ALL if x != y])]
        parts.append(with_pred(fn, tr, E[E.year == y].copy()))
    loyo = pd.concat(parts, ignore_index=True)
    res = summarise(name, back_test, loyo, input_col)
    print(f"  {name:22s} back: canada {res['back_canada_wabs']:5.1f} prov {res['back_prov_wabs']:5.1f} "
          f"12k {res['back_12k_wabs']:5.1f} cell {res['back_cell_wabs']:5.1f} 2014 {res['back_2014']:6.1f} | "
          f"loyo: canada {res['loyo_canada_wabs']:5.1f} prov {res['loyo_prov_wabs']:5.1f} 12k {res['loyo_12k_wabs']:5.1f} "
          f"cell {res['loyo_cell_wabs']:5.1f} 2014 {res['loyo_2014']:6.1f} range {res['loyo_canada_range']} "
          f"zero-input {res['viirs_share_in_zero_input_cell_months_pct']}% (located {res['zero_input_viirs_located_pct']}%)", flush=True)
    return res


def load_or_build(with_size: bool = False) -> pd.DataFrame:
    path = C.INTERIM / ("experiments_base_nbac.parquet" if with_size else "experiments_base.parquet")
    if path.exists():
        return pd.read_parquet(path)
    cov = pd.read_parquet(C.INTERIM / "coverage.parquet")
    av, _ = K.availability(pd.read_parquet(C.INTERIM / "daily_counts.parquet"), cov)
    E = build(av, pd.read_parquet(C.INTERIM / "nbac_cell8_year.parquet") if with_size else None)
    E.to_parquet(path, index=False)
    return E


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    E = load_or_build()
    overlap = E[K.in_window(E, K.TERRA_TRAIN)]
    E = E[E.year.isin(K.TRAIN_ALL)].reset_index(drop=True)
    print(f"base rows {len(E):,}", flush=True)
    variants = [
        ("table_aqua (current)", v_table("a_cd"), "a_cd"),
        ("intensity_dpc", v_intensity("dpc"), "a_cd"),
        ("intensity_frp", v_intensity("frp"), "a_cd"),
        ("loglin_aqua", v_loglin, "a_cd"),
        ("table_terra", v_table("t_cd"), "t_cd"),
        ("table_union", v_table("u_cd"), "u_cd"),
        ("terra_frp", v_intensity("frp", "t_cd", "t_det", "t_frp"), "t_cd"),
        ("union_frp", v_intensity("frp", "u_cd", "a_det+t_det", "a_frp+t_frp"), "u_cd"),
        ("terra_chain (current)", lambda tr, te: v_terra_chain(tr, te, overlap), "t_cd"),
    ]
    rows = [run_variant(n, f, E, c) for n, f, c in variants]
    if LOGLIN_COEF:
        b = np.array(LOGLIN_COEF)
        print(f"  loglin coefficients (intercept, log det/cell-day, log mean FRP): mean {b.mean(0).round(3)}, "
              f"min {b.min(0).round(3)}, max {b.max(0).round(3)}")
    df = pd.DataFrame(rows)
    df.drop(columns=["loyo_year_errors"]).to_csv(OUT / "comparison_stage_a.csv", index=False)
    (OUT / "comparison_stage_a.json").write_text(json.dumps({"rows": rows, "loglin_coef": LOGLIN_COEF}, indent=1))


if __name__ == "__main__":
    main()
