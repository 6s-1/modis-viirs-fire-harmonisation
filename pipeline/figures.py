"""Figure: raw Aqua, raw VIIRS and the harmonised series for all Canada, by year.

Reads reports/calibration/canada_annual_series.csv (written by calibrate.py) and writes
reports/figures/canada_annual_series.png.
"""
from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

import config as C

INK, INK2, GRID, SURFACE = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"
HARM, AQUA, VIIRS = "#2a78d6", "#eb6834", "#1baf7a"


def main() -> None:
    a = pd.read_csv(C.REPORTS / "calibration" / "canada_annual_series.csv", index_col="year")
    a = a[a.index <= 2025]  # complete years only
    est = a[~a.source.str.contains("observed")]
    vi = a[a.vref > 0]

    plt.rcParams.update({"font.family": "sans-serif", "font.size": 10, "axes.edgecolor": GRID,
                         "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2})
    fig, ax = plt.subplots(figsize=(10, 5.2), dpi=160, facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)

    ax.fill_between(est.index, est.low / 1e3, est.high / 1e3, color=HARM, alpha=0.15, linewidth=0,
                    label="Range for estimated years")
    ax.plot(a.index, a.harmonised / 1e3, color=HARM, linewidth=2.4, zorder=3, label="Harmonised (VIIRS-equivalent)")
    ax.plot(est.index, est.harmonised / 1e3, linestyle="none", marker="o", markersize=6, markerfacecolor=SURFACE,
            markeredgecolor=HARM, markeredgewidth=2, zorder=4, label="Estimated year")
    obs = a[a.source.str.contains("observed")]
    ax.plot(obs.index, obs.harmonised / 1e3, linestyle="none", marker="o", markersize=6, color=HARM,
            markeredgecolor=SURFACE, markeredgewidth=1.5, zorder=4, label="Observed year")
    ax.plot(vi.index, vi.vref / 1e3, color=VIIRS, linewidth=1.6, linestyle=(0, (3, 3)), zorder=5,
            label="Raw VIIRS (S-NPP / NOAA-20 mean)")
    aq = a[a.aqua > 0]
    ax.plot(aq.index, aq.aqua / 1e3, color=AQUA, linewidth=2, zorder=2, label="Raw MODIS Aqua")

    # direct labels
    last = a.index.max()
    ax.annotate("Harmonised", (last, a.harmonised[last] / 1e3), xytext=(8, 6), textcoords="offset points",
                color=INK, fontsize=9)
    ax.annotate("Raw Aqua", (last, a.aqua[last] / 1e3), xytext=(8, -3), textcoords="offset points", color=INK, fontsize=9)
    ax.annotate("Raw VIIRS (dashed, equals harmonised from 2012)", (2014, vi.vref[2014] / 1e3), xytext=(-10, 30),
                textcoords="offset points", color=INK, fontsize=9, ha="center",
                arrowprops=dict(arrowstyle="-", color=INK2, lw=0.6))
    ax.annotate("2000: Nov–Dec only", (2000, a.harmonised[2000] / 1e3), xytext=(4, 18), textcoords="offset points",
                color=INK2, fontsize=8, arrowprops=dict(arrowstyle="-", color=INK2, lw=0.6))
    ax.axvspan(1999.5, 2011.5, color=INK2, alpha=0.04, linewidth=0)
    ax.text(2005.5, ax.get_ylim()[1] * 0.97, "Estimated from MODIS (before 2012)", ha="center", va="top",
            color=INK2, fontsize=9)

    ax.set_xlim(1999.5, 2026.2)
    ax.set_xticks(range(2000, 2026, 5))
    ax.set_ylabel("Fire cell-days per year (thousands)")
    ax.set_title("Canada: fire cell-days per year, raw sensors and harmonised series, 2000–2025",
                 loc="left", color=INK, fontsize=12)
    ax.legend(frameon=False, loc="upper left", bbox_to_anchor=(0, 0.92), fontsize=8.5, labelcolor=INK2)
    fig.text(0.01, 0.01, "Cell-day = a ~1 km grid cell with at least one fire detection on a day. "
             "Range = spread of errors over 14 held-out years (2012–2025).", color=INK2, fontsize=7.5)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    out = C.REPORTS / "figures" / "canada_annual_series.png"
    fig.savefig(out, facecolor=SURFACE)
    print(out)


if __name__ == "__main__":
    main()
