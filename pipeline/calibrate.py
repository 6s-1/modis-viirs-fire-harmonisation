"""Step 2: VIIRS reference series, calibration tables, backwards validation.

Inputs (from earlier steps)
  data/interim/cell_days_fine.parquet, daily_counts.parquet, coverage.parquet,
  landcover_cell8.parquet, regions_cell5.parquet

What it does
  1. Availability: a platform is unavailable on a day if it is outside its coverage, or if
     it has zero cell-days in Canada while another platform has >= OUTAGE_MIN (an outage).
  2. VIIRS reference: per ~1 km cell-day, the mean of the available VIIRS platforms
     (S-NPP, NOAA-20). Agreement between the two is reported where both are available.
  3. VIIRS / Aqua ratio table per fire region x land cover x season, fitted on days when
     Aqua and at least one VIIRS platform are available. Thin strata fall back through
     LEVELS until they have >= MIN_DEN Aqua cell-days in >= MIN_YEARS years.
     Day-only and night-only tables are fitted the same way, for comparison.
  4. Terra -> Aqua table on their overlap (TERRA_TRAIN), applied to Nov 2000 - Jul 2002.
  5. Backwards validation: fit on 2019-2025, predict 2012-2014. Leave-one-year-out over
     2012-2025 gives the uncertainty ranges by area size.
  6. Sensitivity to 2023, zero cases, a preview harmonised series and one figure.

Outputs: reports/calibration/*.csv|json, reports/figures/canada_annual_series.png,
         data/interim/harmonised_monthly_preview.parquet
"""
from __future__ import annotations

import json

import h3
import numpy as np
import pandas as pd

import config as C
from regions import PARENT

OUT = C.REPORTS / "calibration"
FIG = C.REPORTS / "figures"
SEASON = {12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
          6: "summer", 7: "summer", 8: "summer", 9: "fall", 10: "fall", 11: "fall"}
SEASONS = ["winter", "spring", "summer", "fall"]
LC = ["forest", "grass_shrub", "cropland", "other"]
LEVELS = [("region", "lc", "season"), ("region", "lc"), ("parent", "lc", "season"), ("parent", "lc"),
          ("lc", "season"), ("lc",), ()]
LEVEL_NAME = {lv: " x ".join(lv) if lv else "all Canada" for lv in LEVELS}
MIN_DEN = 200      # minimum denominator cell-days in a stratum
MIN_YEARS = 3      # ... spread over at least this many training years
OUTAGE_MIN = 50    # other platforms' cell-days that make a zero day an outage
TRAIN_ALL = list(range(2012, 2026))
TRAIN_BACK, TEST_BACK = list(range(2019, 2026)), [2012, 2013, 2014]
TERRA_TRAIN = ((2002, 7), (2007, 12))       # Terra/Aqua overlap used for the Terra table
TERRA_TEST_TRAIN = ((2003, 7), (2007, 12))  # validation of the Terra table: fit here ...
TERRA_TEST = ((2002, 7), (2003, 6))         # ... predict the first overlap year
KEYS = ["cell5", "year", "month", "lc"]


def ym(df):
    return df["year"].astype(int) * 100 + df["month"].astype(int)


def in_window(df, w):
    (y0, m0), (y1, m1) = w
    v = ym(df)
    return (v >= y0 * 100 + m0) & (v <= y1 * 100 + m1)


# ---------------------------------------------------------------- availability
def availability(daily: pd.DataFrame, cov: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    daily = daily.assign(platform=daily.platform.astype(str))
    w = daily.pivot_table(index="date", columns="platform", values="cell_days", fill_value=0)
    dates = pd.date_range("2000-11-01", w.index.max(), freq="D")
    w = w.reindex(dates, fill_value=0).reindex(columns=C.PLATFORMS, fill_value=0)
    covered = cov[cov.coverage != "none"]
    av = pd.DataFrame(index=dates)
    outages = {}
    for p in C.PLATFORMS:
        c = covered[covered.platform == p]
        months = set(zip(c.year, c.month))
        w0, w1 = C.MISSION_WINDOWS[p]
        in_cov = np.array([(d.year, d.month) in months for d in dates])
        in_win = (dates >= pd.Timestamp(w0)) & (dates <= pd.Timestamp(w1 or dates.max()))
        others = w.drop(columns=p).max(axis=1)
        outage = (w[p] == 0) & (others >= OUTAGE_MIN) & in_cov & in_win
        av[p] = in_cov & in_win & ~outage.to_numpy()
        outages[p] = {"days": int(outage.sum()), "other_platform_cell_days_on_those_days": int(others[outage].sum()),
                      "dates": [d.strftime("%Y-%m-%d") for d in dates[outage.to_numpy()]]}
    return av, outages


# ---------------------------------------------------------------- base table
def build_tables(av: pd.DataFrame):
    fine = pd.read_parquet(C.INTERIM / "cell_days_fine.parquet",
                           columns=["cell8", "date", "platform", "day", "night", "year", "month"])
    fine["platform"] = fine["platform"].astype(str)
    lc = pd.read_parquet(C.INTERIM / "landcover_cell8.parquet")
    fine = fine.merge(lc, on="cell8", how="left")
    fine["lc"] = fine["lc"].astype(str).replace("nan", "other")
    uniq, inv = np.unique(fine["cell8"].to_numpy(), return_inverse=True)
    par = np.fromiter((h3.api.basic_int.cell_to_parent(int(c), C.DISPLAY_RES) for c in uniq), np.uint64, len(uniq))
    fine["cell5"] = par[inv]
    fine["year"] = fine["year"].astype(int)
    fine["month"] = fine["month"].astype(int)
    a = av.reindex(fine["date"]).to_numpy()
    col = {p: i for i, p in enumerate(av.columns)}
    for p in C.PLATFORMS:
        fine[f"a_{p}"] = a[:, col[p]]

    parts = []
    # VIIRS reference at cell8-day
    v = fine[fine.platform.isin(["snpp", "noaa20"])]
    v = v.assign(s=v.platform.eq("snpp"), n=v.platform.eq("noaa20"))
    v = v.assign(sd=v.s & v.day, sn=v.s & v.night, nd=v.n & v.day, nn=v.n & v.night)
    g = (v.groupby(["cell8", "date"], sort=False)
          .agg(s=("s", "max"), n=("n", "max"), sd=("sd", "max"), sn=("sn", "max"), nd=("nd", "max"),
               nn=("nn", "max"), cell5=("cell5", "first"), lc=("lc", "first"), year=("year", "first"),
               month=("month", "first"), a_snpp=("a_snpp", "first"), a_noaa20=("a_noaa20", "first"),
               a_aqua=("a_aqua", "first"))
          .reset_index())
    del v
    k = g.a_snpp.astype(int) + g.a_noaa20.astype(int)
    g = g[k > 0].copy()
    k = k[k > 0]
    ref = lambda x, y: (g[x] & g.a_snpp).astype(float) / k + (g[y] & g.a_noaa20).astype(float) / k
    g["vref"] = ref("s", "n")
    g["vref_d"] = ref("sd", "nd")
    g["vref_n"] = ref("sn", "nn")
    cal = g.a_aqua
    both = g.a_snpp & g.a_noaa20
    parts.append(pd.DataFrame({
        **{c: g[c] for c in KEYS},
        "vref": g.vref, "vref_cal": g.vref * cal, "vref_cal_d": g.vref_d * cal, "vref_cal_n": g.vref_n * cal,
        "snpp_both": (g.s & both).astype(float), "noaa20_both": (g.n & both).astype(float),
        "both_detect": (g.s & g.n & both).astype(float), "either_detect": ((g.s | g.n) & both).astype(float),
    }))
    agreement_cells = g.loc[both, ["cell5", "year", "month", "lc", "s", "n"]]
    del g

    # Aqua and Terra
    viirs_av = fine.a_snpp | fine.a_noaa20
    aq = fine[fine.platform.eq("aqua")]
    va = viirs_av[aq.index]
    parts.append(pd.DataFrame({
        **{c: aq[c] for c in KEYS}, "aqua": 1.0,
        "aqua_cal": (va & aq.a_aqua).astype(float),
        "aqua_cal_d": (va & aq.a_aqua & aq.day).astype(float),
        "aqua_cal_n": (va & aq.a_aqua & aq.night).astype(float),
        "aqua_ov": (aq.a_terra & aq.a_aqua).astype(float),
    }))
    te = fine[fine.platform.eq("terra")]
    parts.append(pd.DataFrame({
        **{c: te[c] for c in KEYS}, "terra": 1.0,
        "terra_ov": (te.a_terra & te.a_aqua).astype(float),
    }))
    del fine
    T = pd.concat(parts, ignore_index=True).fillna(0.0).groupby(KEYS, sort=False).sum().reset_index()
    reg = pd.read_parquet(C.INTERIM / "regions_cell5.parquet")[["cell5", "region", "parent", "province"]]
    T = T.merge(reg, on="cell5", how="left")
    T["season"] = T["month"].map(SEASON)
    return T, agreement_cells


# ---------------------------------------------------------------- ratio tables
def universe() -> pd.DataFrame:
    idx = pd.MultiIndex.from_product([sorted(PARENT), LC, SEASONS], names=["region", "lc", "season"])
    u = idx.to_frame(index=False)
    u["parent"] = u["region"].map(PARENT)
    return u


def fit(train: pd.DataFrame, num: str, den: str) -> pd.DataFrame:
    """Ratio num/den per region x lc x season, falling back through LEVELS for thin strata."""
    u = universe()
    u["ratio"] = np.nan
    u["level"] = None
    u["num"] = np.nan
    u["den"] = np.nan
    u["years"] = np.nan
    t = train[train[den] > 0]
    for lv in LEVELS:
        keys = list(lv)
        if keys:
            s = train.groupby(keys)[[num, den]].sum()
            yrs = t.groupby(keys)["year"].nunique().rename("years")
            s = s.join(yrs).fillna({"years": 0}).reset_index()
            m = u[keys].merge(s, on=keys, how="left")
        else:
            m = pd.DataFrame({num: [train[num].sum()] * len(u), den: [train[den].sum()] * len(u),
                              "years": [t["year"].nunique()] * len(u)})
        ok = u["level"].isna().to_numpy() & (m[den].to_numpy() >= MIN_DEN) & (m["years"].to_numpy() >= MIN_YEARS)
        if not keys:
            ok = u["level"].isna().to_numpy()  # last resort: all Canada
        u.loc[ok, "ratio"] = (m[num] / m[den]).to_numpy()[ok]
        u.loc[ok, "num"] = m[num].to_numpy()[ok]
        u.loc[ok, "den"] = m[den].to_numpy()[ok]
        u.loc[ok, "years"] = m["years"].to_numpy()[ok]
        u.loc[ok, "level"] = LEVEL_NAME[lv]
    # own (unmerged) stratum size, for reporting
    own = train.groupby(["region", "lc", "season"])[[den]].sum().rename(columns={den: "own_den"}).reset_index()
    u = u.merge(own, on=["region", "lc", "season"], how="left").fillna({"own_den": 0})
    return u


def apply(df: pd.DataFrame, table: pd.DataFrame, den: str, out: str) -> pd.DataFrame:
    r = df.merge(table[["region", "lc", "season", "ratio"]], on=["region", "lc", "season"], how="left")
    r[out] = r["ratio"] * r[den]
    return r.drop(columns="ratio")


# ---------------------------------------------------------------- evaluation
def add_scales(df: pd.DataFrame) -> pd.DataFrame:
    uniq = df["cell5"].unique()
    p3 = {c: h3.api.basic_int.cell_to_parent(int(c), 3) for c in uniq}
    return df.assign(cell3=df["cell5"].map(p3), canada="Canada")


SCALES = {"display cell (~253 km2)": "cell5", "~12,400 km2 (H3 res 3)": "cell3",
          "province": "province", "all Canada": "canada"}


def evaluate(df: pd.DataFrame, pred: str, obs: str) -> dict:
    res = {}
    for sname, unit in SCALES.items():
        for period, pkeys in {"month": ["year", "month"], "year": ["year"]}.items():
            a = df.groupby([unit] + pkeys)[[pred, obs]].sum()
            a = a[(a[pred] > 0) | (a[obs] > 0)]
            p, o = a[pred].to_numpy(), a[obs].to_numpy()
            r = o[p > 0] / p[p > 0]
            big = o >= 20
            res[f"{sname} | {period}"] = {
                "units": int(len(a)),
                "obs_total": round(float(o.sum()), 1), "pred_total": round(float(p.sum()), 1),
                "bias_pct": round(100 * (p.sum() / o.sum() - 1), 1),
                "weighted_abs_error_pct": round(100 * np.abs(p - o).sum() / o.sum(), 1),
                "median_abs_error_pct_obs_ge_20": (round(float(100 * np.median(np.abs(p[big] - o[big]) / o[big])), 1)
                                                   if big.any() else None),
                "units_obs_ge_20": int(big.sum()),
                "obs_over_pred_q10_q50_q90": [round(float(q), 3) for q in np.quantile(r, [0.1, 0.5, 0.9])] if len(r) else None,
                "units_pred_zero_obs_positive": int(((p == 0) & (o > 0)).sum()),
            }
    return res


def per_stratum_error(df: pd.DataFrame, pred: str, obs: str, table: pd.DataFrame) -> pd.DataFrame:
    s = df.groupby(["region", "lc", "season"])[[pred, obs]].sum().reset_index()
    s = s.merge(table[["region", "lc", "season", "level", "ratio"]], on=["region", "lc", "season"], how="left")
    s["error_pct"] = 100 * (s[pred] / s[obs] - 1)
    return s[(s[obs] > 0) | (s[pred] > 0)].sort_values(obs, ascending=False)


# ---------------------------------------------------------------- main
def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)
    cov = pd.read_parquet(C.INTERIM / "coverage.parquet")
    av, outages = availability(pd.read_parquet(C.INTERIM / "daily_counts.parquet"), cov)
    (OUT / "outages.json").write_text(json.dumps(outages, indent=1))
    print("outage days:", {p: v["days"] for p, v in outages.items()}, flush=True)

    T, agree_cells = build_tables(av)
    T = add_scales(T)
    T.to_parquet(C.INTERIM / "calibration_base.parquet", index=False)
    print(f"base table: {len(T):,} rows", flush=True)

    # ---- (a) S-NPP vs NOAA-20 agreement on days both are available
    ag_year = T[T.year >= 2018].groupby("year")[["snpp_both", "noaa20_both", "both_detect", "either_detect"]].sum()
    ag_lc = T[T.year >= 2018].groupby("lc")[["snpp_both", "noaa20_both", "both_detect", "either_detect"]].sum()
    for a in (ag_year, ag_lc):
        a["noaa20_over_snpp"] = a.noaa20_both / a.snpp_both
        a["same_cell_day_share"] = a.both_detect / a.either_detect
    cm = T[T.year >= 2018].groupby(["cell5", "year", "month"])[["snpp_both", "noaa20_both"]].sum()
    cm = cm[(cm.snpp_both + cm.noaa20_both) > 0]
    big = cm[(cm.snpp_both + cm.noaa20_both) >= 40]
    agreement = {
        "by_year": ag_year.round(3).reset_index().to_dict("records"),
        "by_landcover": ag_lc.round(3).reset_index().to_dict("records"),
        "display_cell_month": {
            "pairs": int(len(cm)),
            "pearson_log1p": round(float(np.corrcoef(np.log1p(cm.snpp_both), np.log1p(cm.noaa20_both))[0, 1]), 3),
            "median_abs_diff_pct_of_mean_when_sum_ge_40": round(float(100 * np.median(
                np.abs(big.snpp_both - big.noaa20_both) / ((big.snpp_both + big.noaa20_both) / 2))), 1),
        },
    }
    (OUT / "viirs_agreement.json").write_text(json.dumps(agreement, indent=1))
    ag_year.round(3).to_csv(OUT / "viirs_agreement_by_year.csv")
    ag_lc.round(3).to_csv(OUT / "viirs_agreement_by_landcover.csv")

    # ---- (c) ratio tables: VIIRS / Aqua
    tr_all = T[T.year.isin(TRAIN_ALL)]
    tab = fit(tr_all, "vref_cal", "aqua_cal")
    tab.to_csv(OUT / "ratio_viirs_aqua.csv", index=False)
    tab_d = fit(tr_all, "vref_cal_d", "aqua_cal_d")
    tab_n = fit(tr_all, "vref_cal_n", "aqua_cal_n")
    dn = tab[["region", "lc", "season"]].assign(
        ratio_day=tab_d.ratio, level_day=tab_d.level, own_aqua_day=tab_d.own_den,
        ratio_night=tab_n.ratio, level_night=tab_n.level, own_aqua_night=tab_n.own_den)
    dn.to_csv(OUT / "ratio_viirs_aqua_day_night.csv", index=False)

    # ---- (d) Terra -> Aqua
    tr_t = T[in_window(T, TERRA_TRAIN)]
    tab_t = fit(tr_t, "aqua_ov", "terra_ov")
    tab_t.to_csv(OUT / "ratio_aqua_terra.csv", index=False)
    tv = fit(T[in_window(T, TERRA_TEST_TRAIN)], "aqua_ov", "terra_ov")
    te = apply(T[in_window(T, TERRA_TEST)], tv, "terra_ov", "pred")
    terra_val = evaluate(te, "pred", "aqua_ov")

    # ---- (e) backwards validation
    tab_b = fit(T[T.year.isin(TRAIN_BACK)], "vref_cal", "aqua_cal")
    tab_b.to_csv(OUT / "ratio_viirs_aqua_train_2019_2025.csv", index=False)
    test = apply(T[T.year.isin(TEST_BACK)], tab_b, "aqua_cal", "pred")
    back = evaluate(test, "pred", "vref_cal")
    back_by_year = test.groupby("year")[["pred", "vref_cal"]].sum()
    back_by_year["error_pct"] = 100 * (back_by_year.pred / back_by_year.vref_cal - 1)
    strat = per_stratum_error(test, "pred", "vref_cal", tab_b)
    strat.round(3).to_csv(OUT / "validation_2012_2014_per_stratum.csv", index=False)
    tab_b_x = fit(T[T.year.isin([y for y in TRAIN_BACK if y != 2023])], "vref_cal", "aqua_cal")
    test_x = apply(T[T.year.isin(TEST_BACK)], tab_b_x, "aqua_cal", "pred")
    back_x = evaluate(test_x, "pred", "vref_cal")

    # leave-one-year-out (for uncertainty ranges)
    loyo = []
    for y in TRAIN_ALL:
        t = fit(T[T.year.isin([x for x in TRAIN_ALL if x != y])], "vref_cal", "aqua_cal")
        loyo.append(apply(T[T.year == y], t, "aqua_cal", "pred"))
    loyo = pd.concat(loyo, ignore_index=True)
    loyo_m = evaluate(loyo, "pred", "vref_cal")
    ly = loyo.groupby("year")[["pred", "vref_cal"]].sum()
    ly["canada_error_pct"] = 100 * (ly.pred / ly.vref_cal - 1)
    lp = loyo.groupby(["year", "parent"])[["pred", "vref_cal"]].sum()
    lp = (100 * (lp.pred / lp.vref_cal - 1)).unstack().add_suffix("_error_pct")
    loyo_years = ly.join(lp).round(1)
    loyo_years.to_csv(OUT / "loyo_errors_by_year.csv")
    obs_over_pred = (ly.vref_cal / ly.pred)
    canada_range = [float(obs_over_pred.min()), float(obs_over_pred.max())]

    # ---- (f) sensitivity to 2023
    tab_x = fit(T[T.year.isin([y for y in TRAIN_ALL if y != 2023])], "vref_cal", "aqua_cal")
    sens = tab[["region", "lc", "season", "ratio", "level"]].rename(columns={"ratio": "ratio_with_2023", "level": "level_with"})
    sens["ratio_without_2023"] = tab_x.ratio
    sens["level_without"] = tab_x.level
    sens["change_pct"] = 100 * (sens.ratio_with_2023 / sens.ratio_without_2023 - 1)
    pre = T[T.year < 2012].groupby(["region", "lc", "season"])["aqua"].sum().rename("aqua_cell_days_2002_2011")
    sens = sens.merge(pre.reset_index(), on=["region", "lc", "season"], how="left").fillna({"aqua_cell_days_2002_2011": 0})
    sens.round(3).to_csv(OUT / "sensitivity_2023.csv", index=False)

    # ---- (g) zero cases at display-cell-month, 2012-2025
    z = T[T.year.isin(TRAIN_ALL)].groupby(["cell5", "year", "month", "season", "parent"])[["aqua_cal", "vref_cal"]].sum().reset_index()
    vpos = z[z.vref_cal > 0]
    zc = vpos[vpos.aqua_cal == 0]
    zero = {
        "display_cell_months_with_viirs": int(len(vpos)),
        "of_which_aqua_zero": int(len(zc)),
        "share_of_cell_months_pct": round(100 * len(zc) / len(vpos), 1),
        "viirs_cell_days_in_them": round(float(zc.vref_cal.sum()), 1),
        "share_of_viirs_cell_days_pct": round(100 * zc.vref_cal.sum() / vpos.vref_cal.sum(), 1),
        "viirs_cell_days_per_case_q50_q90_max": [float(np.quantile(zc.vref_cal, q)) for q in (0.5, 0.9)] + [float(zc.vref_cal.max())],
        "reverse_aqua_positive_viirs_zero": int(((z.aqua_cal > 0) & (z.vref_cal == 0)).sum()),
        "by_season": (zc.groupby("season").vref_cal.sum() / vpos.groupby("season").vref_cal.sum() * 100).round(1).to_dict(),
        "by_parent_region": (zc.groupby("parent").vref_cal.sum() / vpos.groupby("parent").vref_cal.sum() * 100).round(1).to_dict(),
    }
    z3 = T[T.year.isin(TRAIN_ALL)].groupby(["cell3", "year", "month"])[["aqua_cal", "vref_cal"]].sum()
    v3 = z3[z3.vref_cal > 0]
    zero["at_12400km2_share_of_viirs_cell_days_pct"] = round(100 * v3[v3.aqua_cal == 0].vref_cal.sum() / v3.vref_cal.sum(), 1)
    (OUT / "zero_cases.json").write_text(json.dumps(zero, indent=1))

    # ---- preview harmonised series (cell5 x month)
    cw = cov.pivot_table(index=["year", "month"], columns="platform", values="coverage", aggfunc="first")
    cw["viirs_full"] = (cw.get("snpp") == "full") | (cw.get("noaa20") == "full")
    cw["aqua_full"] = cw["aqua"] == "full"
    cw["terra_cov"] = cw["terra"] != "none"
    cw["partial"] = (cw[["terra", "aqua", "snpp", "noaa20"]] == "partial").any(axis=1) & ~cw["viirs_full"] & ~cw["aqua_full"]
    cw["source"] = np.select([cw.viirs_full, cw.aqua_full, cw.terra_cov],
                             ["observed", "estimated_from_aqua", "estimated_from_terra"], "none")
    src = cw[["source", "partial"]].reset_index()
    H = T.merge(src, on=["year", "month"], how="left")
    H = apply(H, tab, "aqua", "est_a")
    H["aqua_eq"] = H.merge(tab_t[["region", "lc", "season", "ratio"]], on=["region", "lc", "season"], how="left")["ratio"].to_numpy() * H["terra"]
    H = apply(H, tab, "aqua_eq", "est_t")
    H["value"] = np.select([H.source.eq("observed"), H.source.eq("estimated_from_aqua"), H.source.eq("estimated_from_terra")],
                           [H.vref, H.est_a, H.est_t], np.nan)
    Hm = (H.groupby(["cell5", "year", "month", "source", "partial"])[["value", "aqua", "terra", "vref"]].sum().reset_index())
    Hm.to_parquet(C.INTERIM / "harmonised_monthly_preview.parquet", index=False)

    annual = (H.groupby("year").agg(aqua=("aqua", "sum"), terra=("terra", "sum"), vref=("vref", "sum"),
                                    harmonised=("value", "sum")))
    srcy = src.groupby("year").source.agg(lambda s: "/".join(sorted(set(s) - {"none"})))
    annual = annual.join(srcy)
    # Canada-wide annual range for estimated years: the full spread of obs/pred over the 14
    # held-out years (leave-one-year-out). Terra-based years add the Terra->Aqua test error
    # in quadrature on the log scale.
    lo_va, hi_va = np.log(canada_range[0]), np.log(canada_range[1])
    e_t = abs(np.log(1 + terra_val["all Canada | year"]["bias_pct"] / 100))
    lo_t, hi_t = -np.sqrt(lo_va ** 2 + e_t ** 2), np.sqrt(hi_va ** 2 + e_t ** 2)
    est = ~annual.source.str.contains("observed")
    terra_y = annual.source.str.contains("terra")
    annual["low"] = np.where(~est, annual.harmonised, annual.harmonised * np.exp(np.where(terra_y, lo_t, lo_va)))
    annual["high"] = np.where(~est, annual.harmonised, annual.harmonised * np.exp(np.where(terra_y, hi_t, hi_va)))
    annual["partial_year"] = annual.index == 2000
    annual.round(1).to_csv(OUT / "canada_annual_series.csv")

    metrics = {
        "settings": {"min_aqua_cell_days_per_stratum": MIN_DEN, "min_years_per_stratum": MIN_YEARS,
                     "outage_rule": f"zero cell-days while another platform has >= {OUTAGE_MIN}",
                     "fallback_levels": [LEVEL_NAME[l] for l in LEVELS],
                     "train_main": [TRAIN_ALL[0], TRAIN_ALL[-1]], "train_back": [TRAIN_BACK[0], TRAIN_BACK[-1]],
                     "test_back": TEST_BACK, "terra_train": TERRA_TRAIN, "terra_test": TERRA_TEST},
        "backwards_validation": back,
        "backwards_validation_by_year": back_by_year.round(1).reset_index().to_dict("records"),
        "backwards_validation_train_without_2023": back_x,
        "leave_one_year_out_2012_2025": loyo_m,
        "leave_one_year_out_canada_obs_over_pred_range": [round(v, 3) for v in canada_range],
        "terra_to_aqua_validation": terra_val,
    }
    (OUT / "validation_metrics.json").write_text(json.dumps(metrics, indent=1))

    # ---- console summary
    pd.set_option("display.width", 200)
    print("\n(a) S-NPP vs NOAA-20 on days both available\n", ag_year.round(3).to_string())
    print(ag_lc.round(3).to_string())
    print(json.dumps(agreement["display_cell_month"]))
    print("\n(c) VIIRS/Aqua table: levels used", tab.level.value_counts().to_dict())
    print("(c) day table levels", tab_d.level.value_counts().to_dict(), "| night table levels", tab_n.level.value_counts().to_dict())
    print("(d) Terra table levels", tab_t.level.value_counts().to_dict())
    print("\n(e) backwards by year\n", back_by_year.round(1).to_string())
    for k, v in back.items():
        print(f"  {k:38s} bias {v['bias_pct']:6.1f}%  wAbsErr {v['weighted_abs_error_pct']:6.1f}%  "
              f"medAbsErr(obs>=20) {v['median_abs_error_pct_obs_ge_20']}%  n>=20 {v['units_obs_ge_20']}  q {v['obs_over_pred_q10_q50_q90']}")
    print("  train without 2023:")
    for k, v in back_x.items():
        print(f"  {k:38s} bias {v['bias_pct']:6.1f}%  wAbsErr {v['weighted_abs_error_pct']:6.1f}%")
    print("\n  LOYO 2012-2025:")
    for k, v in loyo_m.items():
        print(f"  {k:38s} bias {v['bias_pct']:6.1f}%  wAbsErr {v['weighted_abs_error_pct']:6.1f}%  "
              f"medAbsErr(obs>=20) {v['median_abs_error_pct_obs_ge_20']}%  q {v['obs_over_pred_q10_q50_q90']}")
    print("\n  Terra->Aqua validation:")
    for k, v in terra_val.items():
        print(f"  {k:38s} bias {v['bias_pct']:6.1f}%  wAbsErr {v['weighted_abs_error_pct']:6.1f}%  q {v['obs_over_pred_q10_q50_q90']}")
    print("\n(g)", json.dumps(zero))
    print("\nannual\n", annual.round(0).to_string())


if __name__ == "__main__":
    main()
