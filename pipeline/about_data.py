"""Collect the numbers shown on the app's About page from the pipeline's reports.

Nothing here is typed in by hand: every figure comes from a report written by an earlier
step, so the About page stays in step with the data after a rerun.

Inputs:  reports/experiments/comparison_stage_a.json (experiments.py), comparison_all.csv,
         reports/calibration/adopted_model.json, viirs_agreement.json, zero_cases.json,
         outages.json, reports/nbac_check/nbac_check.json, reports/filter_report.json,
         reports/cell_days_by_year.csv, web/public/harmonised/manifest.json
Outputs: web/public/about/about.json, web/public/about/*.png (figures)
"""
from __future__ import annotations

import json
import shutil

import pandas as pd

import config as C

WEB = C.REPO / "web" / "public" / "about"
R = C.REPORTS


def main() -> None:
    WEB.mkdir(parents=True, exist_ok=True)
    comp = pd.read_csv(R / "experiments" / "comparison_all.csv").set_index("variant")
    stage_a = {r["variant"]: r for r in json.loads((R / "experiments" / "comparison_stage_a.json").read_text())["rows"]}
    adopted = json.loads((R / "calibration" / "adopted_model.json").read_text())
    agree = json.loads((R / "calibration" / "viirs_agreement.json").read_text())
    zero = json.loads((R / "calibration" / "zero_cases.json").read_text())
    outages = json.loads((R / "calibration" / "outages.json").read_text())
    nbac = json.loads((R / "nbac_check" / "nbac_check.json").read_text())
    filt = json.loads((R / "filter_report.json").read_text())
    cdy = pd.read_csv(R / "cell_days_by_year.csv")
    manifest = json.loads((C.REPO / "web" / "public" / "harmonised" / "manifest.json").read_text())

    def row(name, label):
        r = comp.loc[name]
        return {"label": label,
                "loyo": {k: float(r[f"loyo_{k}_wabs"]) for k in ("canada", "prov", "12k", "cell")},
                "back": {k: float(r[f"back_{k}_wabs"]) for k in ("canada", "prov", "12k", "cell")},
                "back_2014": float(r.back_2014), "loyo_2014": float(r.loyo_2014),
                "zero_input_pct": float(r.viirs_share_in_zero_input_cell_months_pct),
                "loyo_canada_range": json.loads(r.loyo_canada_range) if isinstance(r.loyo_canada_range, str) else r.loyo_canada_range}

    years = sorted(int(y) for y in stage_a["table_aqua (current)"]["loyo_year_errors"])
    hidden = [{"year": y,
               "old": stage_a["table_aqua (current)"]["loyo_year_errors"][str(y)] if str(y) in stage_a["table_aqua (current)"]["loyo_year_errors"] else stage_a["table_aqua (current)"]["loyo_year_errors"][y],
               "new": stage_a["union_frp"]["loyo_year_errors"][str(y)] if str(y) in stage_a["union_frp"]["loyo_year_errors"] else stage_a["union_frp"]["loyo_year_errors"][y]}
              for y in years]

    rejected = []
    for name, label in (("loglin_aqua", "Log-linear fit on fire intensity"), ("aqua_size", "NBAC fire-size classes (Aqua)"),
                        ("union_size", "NBAC fire-size classes (union)"), ("union_frp + nfdb_fill", "Fill from reported fires (NFDB)")):
        if name in comp.index:
            rejected.append(row(name, label))

    totals = filt["totals"]
    about = {
        "generated": manifest["generated"],
        "data_end": manifest["months"][-1],
        "detections_kept": filt["kept"],
        "detections_read": int(sum(v["rows"] for v in totals.values())),
        "cells": manifest["binary"]["cells"],
        "comparison": [row("table_aqua (current)", "Previous: VIIRS/Aqua table"),
                       row("union_frp", "Adopted from Aug 2002: Aqua or Terra + fire intensity"),
                       row("terra_chain (current)", "Previous, Terra-only months: Terra to Aqua to VIIRS"),
                       row("terra_frp", "Adopted Nov 2000 to Jul 2002: Terra + fire intensity")],
        "rejected": rejected,
        "hidden_years": hidden,
        "adopted": {k: {"loyo_canada_range": v["loyo_canada_obs_over_pred_range"], "months": v["months"],
                        "frp_edges": v["frp_tercile_edges_mw"]} for k, v in adopted["models"].items()},
        "low_confidence_below_km2": manifest["uncertainty"]["low_confidence_below_km2"],
        "uncertainty_scales": manifest["uncertainty"]["scales"],
        "viirs_agreement": {
            "noaa20_over_snpp": [r["noaa20_over_snpp"] for r in agree["by_year"] if r["year"] <= 2025],
            "pearson_log1p": agree["display_cell_month"]["pearson_log1p"]},
        "zero_cases": {"share_of_cell_months_pct": zero["share_of_cell_months_pct"],
                       "share_of_viirs_pct": zero["share_of_viirs_cell_days_pct"],
                       "at_12k_pct": zero["at_12400km2_share_of_viirs_cell_days_pct"]},
        "outage_days": {k: v["days"] for k, v in outages.items()},
        "nbac": {k: {"est_bias_pct": v["estimated_years_2003_2011"]["bias_pct"],
                     "est_mlr": v["estimated_years_2003_2011"]["median_abs_log_ratio"],
                     "early_bias_pct": (v.get("early_2001_2002") or {}).get("bias_pct")}
                 for k, v in nbac["series"].items()},
        "nbac_canada_annual_error_pct": nbac["canada_annual_error_pct"],
        "viirs_over_modis_2012_2025": round(float(
            cdy[(cdy.platform.isin(["snpp", "noaa20"])) & cdy.year.between(2018, 2025)].cell_days.sum() / 2 /
            cdy[(cdy.platform == "aqua") & cdy.year.between(2018, 2025)].cell_days.sum()), 2),
    }
    (WEB / "about.json").write_text(json.dumps(about, indent=1))
    for f in ("canada_annual_series.png", "nbac_check.png"):
        shutil.copyfile(R / "figures" / f, WEB / f)
    print(json.dumps({k: about[k] for k in ("comparison", "hidden_years")}, indent=0)[:1500])


if __name__ == "__main__":
    main()
