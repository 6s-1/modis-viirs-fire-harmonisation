# How Ember works

Ember turns 26 years of satellite fire detections over Canada into one series that can be read
end to end. MODIS (1 km pixels, from November 2000) and VIIRS (375 m pixels, from January 2012)
do not count fire the same way, so their raw numbers cannot simply be laid in a row: the record
would step up about fourfold in 2012. Ember converts everything to **VIIRS-equivalent fire
cell-days** and shows it as a burning calendar for any area of Canada.

This document is written from the code, the pipeline's outputs and its reports — not from the
README or the About page. Every number names the file it comes from, and says whether I reran it
or read it from a report. Where something is not established, it says so rather than guessing.

Written on 15 November 2026 against commit `f840c7c` (branch `docs-ground-truth`, off `main`).

---

## 1. What one number means

The unit is a **fire cell-day**: one ~1 km hexagon (H3 resolution 8, average 0.737 km²) that had
at least one kept fire detection from one satellite on one local solar day. It counts once no
matter how many detections land in it ([pipeline/cell_days.py](../pipeline/cell_days.py)).

Two consequences matter for reading anything in the app:

- It measures **how widespread detected burning was**, not area burned. It is not hectares.
- Detections are a **floor**. Satellites miss fire that is small, brief, under cloud or smoke, or
  between overpasses.

"Local solar day" is UTC acquisition time plus longitude/15 hours. That keeps each overpass on the
calendar day it was actually observed, rather than splitting a night pass across two dates
([cell_days.py](../pipeline/cell_days.py), `platform_cell_days`).

Monthly totals are aggregated to H3 resolution 5 (~253 km²) for display. The reason for hexagons
rather than a degree grid is area stability across Canada's latitude range — H3 res 5 cells vary
197.2–305.1 km² (1.55×) over the cells with fire, while 0.25° cells vary 583.2 km² at 41°N down to
94.2 km² at 83°N (6.19×) ([reports/grid_stats.json](../reports/grid_stats.json)).

---

## 2. Every dataset used

All links were opened on 15 November 2026 and the result is recorded. Links come from the download
URLs in the pipeline code where they exist; only [landcover.py](../pipeline/landcover.py) hard-codes
one (the WorldCover bucket). The rest are the documented download locations in
[README.md](../README.md), since the other inputs are fetched by hand into `data/external/`.

| Dataset | Version / dates | What Ember uses it for | Licence | Official source | Link check |
|---|---|---|---|---|---|
| **NASA FIRMS active fire** — MODIS C6.1 (Terra, Aqua) | Terra Nov 2000–Nov 2026, Aqua Jul 2002–Nov 2026; yearly country summaries 2000–2025 + 2026 archive/NRT | The MODIS input to harmonisation; the only input for 2000–2011 | NASA open data; no restriction on use | https://firms.modaps.eosdis.nasa.gov/country/ and https://firms.modaps.eosdis.nasa.gov/download/ | 200 OK |
| **NASA FIRMS active fire** — VIIRS 375 m C2 (S-NPP, NOAA-20) | S-NPP Jan 2012–2 Nov 2026, NOAA-20 Jan 2018–Nov 2026 | The VIIRS reference series and the target of every conversion table | NASA open data | same as above | 200 OK |
| **NASA FIRMS NRT** — VIIRS NOAA-20 + NOAA-21 | Last 24 h / 48 h / 7 days, live | Live fire layer only. **Not** in the harmonised record | NASA open data (provisional) | https://firms.modaps.eosdis.nasa.gov/ | 200 OK |
| **Terrestrial Ecozones of Canada** | Shapefile dated 1995 framework, files 2003/2008 | The 15 fire regions that stratify every conversion table; also the NBAC check's zones | Open Government Licence – Canada | https://sis.agr.gc.ca/cansis/nsdb/ecostrat/zone/ecozone_shp.zip | 200 OK (direct zip) |
| **ESA WorldCover** | v200, 2021 (one snapshot, all years) | Land-cover class per ~1 km fire cell (forest / grass-shrub / cropland / other) | CC BY 4.0 | https://doi.org/10.5281/zenodo.7254221 → zenodo.org/records/7254221 | 200 OK (2 redirects, expected DOI resolution) |
| **NBAC** (National Burned Area Composite) | Per-year zips 2000–2025, file stamp `20260513` | Independent check only (**never** a model input); fire-size classes in rejected experiments | Open Government Licence – Canada | https://cwfis.cfs.nrcan.gc.ca/downloads/nbac/ | 200 OK |
| **NFDB** (Canadian National Fire Database) fire points | `NFDB_point_20260811.txt` | Rejected experiment only (reported-fire fill). Not in the shipped record | Open Government Licence – Canada | https://cwfis.cfs.nrcan.gc.ca/downloads/nfdb/fire_pnt/current_version/ | 200 OK |
| **Natural Earth** admin-1 | 1:50 m | Province labels for validation; the Canada boundary used to clip live hotspots | Public domain | https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_1_states_provinces.zip | 200 OK (direct zip) |
| **WorldPop** population | 2020, 1 km, UN-adjusted, Canada | "People per cell" layer and the exposure list | CC BY 4.0 | https://data.worldpop.org/GIS/Population/Global_2000_2020_1km_UNadj/2020/CAN/ | 200 OK |
| **GeoNames** `cities500` | Current dump | Place-name search and labels | CC BY 4.0 | https://download.geonames.org/export/dump/ | 200 OK |
| **OpenFreeMap / OpenMapTiles / OSM** | Live `positron` style | Base map tiles | OSM data: ODbL; style: OpenFreeMap | https://tiles.openfreemap.org/styles/positron | 200 OK |

One licence note worth having straight for judges: FIRMS data are **not** under the Open Government
Licence – Canada. Only the NRCan/CWFIS products (NBAC, NFDB) and the AAFC ecozones are. The About
page gets this right; it attaches the OGL statement only to those.

---

## 3. How the harmonisation works, step by step

### Step 1 — Clean the detections
[pipeline/clean.py](../pipeline/clean.py), parameters in [pipeline/config.py](../pipeline/config.py)

- Keep `type == 0` only (presumed vegetation fire), dropping static sources and over-water.
- MODIS: keep `confidence >= 30`, i.e. drop the "low" class, keep nominal and high.
- VIIRS: keep confidence `n` and `h`, drop `l`.
- Drop anything outside its platform's mission window (`MISSION_WINDOWS`).

**Result: 12,546,949 detections kept of 13,775,271 read** ([reports/filter_report.json](../reports/filter_report.json)).
Per platform, kept: Terra 796,407; Aqua 711,760; S-NPP 6,343,132; NOAA-20 4,695,650.

Near-real-time rows arrive with no `type` column, so type is inferred
([pipeline/typeinfer.py](../pipeline/typeinfer.py)): a ~1 km cell whose historical detections were
≥50% type 2 marks new rows there as type 2. 414 such static-source cells were found.

The docstring's accuracy claims had **no report file backing them**, so I verified them directly
against the 2026 archive files (where the true type is known). **Reran** — my script, results:

| | type 2 caught | true type 0 wrongly dropped | type 3 (over water) kept as fire |
|---|---|---|---|
| S-NPP | 92.1% | 0.077% | 2.67% of rows |
| NOAA-20 | 90.0% | 0.046% | 2.91% of rows |
| MODIS | 86.4% | 0.078% | **0.00%** |

This confirms the "~90%", "~0.1%" and "~2.7%" claims. One correction: the docstring says over-water
is "~0.1% for MODIS", but MODIS archive files contain **zero** type-3 rows — MODIS does not assign
that type here, so the right statement is "none for MODIS". Minor, and in Ember's favour.

### Step 2 — Build fire cell-days and coverage
[pipeline/cell_days.py](../pipeline/cell_days.py)

Exact duplicate rows are removed (5 in total across all platforms), and NRT rows that duplicate an
archive date within the same year are dropped (0 in this run) ([grid_stats.json](../reports/grid_stats.json)).

Every platform-month is labelled `full`, `partial` or `none`. This matters because **a missing cell
in a covered month is a real zero, while a `none` month must stay empty** — otherwise absence of a
satellite would read as absence of fire. 24 cell-days whose local-date shift pushed them into an
uncovered month were dropped. The partial months are exactly: Terra Nov–Dec 2000 (first months of
the record), Aqua Jul 2002 (from the 4th), S-NPP Jan 2012 (from the 19th), and the four platforms'
November 2026 tails.

### Step 3 — The VIIRS reference
[pipeline/calibrate.py](../pipeline/calibrate.py), `build_tables`

From 2012 the record *is* VIIRS. Per ~1 km cell-day it is the **mean of the available VIIRS
platforms** — S-NPP alone 2012–2017, then the mean of S-NPP and NOAA-20. Using the mean rather than
a union keeps the series on one scale when the second platform arrives in 2018, which is what stops
a second artificial step at 2018.

A platform counts as unavailable on a day if it is outside coverage, or it recorded zero cell-days
in Canada while another platform recorded ≥50 (`OUTAGE_MIN`) — an outage. Outage days found: Terra
44, Aqua 11, S-NPP 45, NOAA-20 15 ([reports/calibration/outages.json](../reports/calibration/outages.json)).

The two VIIRS platforms agree closely: NOAA-20 ÷ S-NPP by year ranges 0.992–1.038, and log-space
correlation at display-cell-month is 0.897
([viirs_agreement.json](../reports/calibration/viirs_agreement.json)).

### Step 4 — Learn the conversion
[pipeline/experiments.py](../pipeline/experiments.py) (`v_intensity`, `fit_table`), applied by
[pipeline/harmonise.py](../pipeline/harmonise.py)

Fitted on **2012–2025**, on days when Aqua, Terra and at least one VIIRS platform were all
available, so the comparison is like-for-like. The quantity learned is a ratio: VIIRS cell-days per
MODIS cell-day, held separately per stratum.

**The strata are: fire region × land cover × season × FRP tercile.**
- region: the 15 terrestrial ecozones, grouped to `north` / `boreal` / `west` / `south` when thin
  ([pipeline/regions.py](../pipeline/regions.py))
- land cover: forest, grass_shrub, cropland, other ([pipeline/landcover.py](../pipeline/landcover.py))
- season: winter (DJF), spring (MAM), summer (JJA), fall (SON)
- **FRP tercile**: mean fire radiative power per detection, the intensity signal that turned out to
  be the single most valuable addition. The tercile edges are **real parameter values**:
  **69.78 and 133.77 MW** for the Aqua-or-Terra model, **56.2 and 114.33 MW** for the Terra-only
  model ([adopted_model.json](../reports/calibration/adopted_model.json)).

A stratum is only used if it holds **≥200 denominator cell-days** (`MIN_DEN`) spread over
**≥3 training years** (`MIN_YEARS`). Otherwise it falls back through this ladder until it does:

`region×lc×season` → `region×lc` → `parent×lc×season` → `parent×lc` → `lc×season` → `lc` → all Canada

Levels actually used by the adopted model: 150 strata at the finest level, 127 at `region×lc×ic`,
38 at `parent×lc×season×ic`, 29 at `parent×lc×ic`, 39 at `lc×season×ic`, 14 at `lc×ic`. **No
stratum fell all the way back to all-Canada** — worth saying, because it means no part of the map is
being estimated from a single national number.

### Step 5 — Apply it backwards
[pipeline/harmonise.py](../pipeline/harmonise.py)

| Period | Model | MODIS input | Months |
|---|---|---|---|
| Aug 2002 – Jan 2012 | `estimated_from_modis` (`union_frp`) | cell-days seen by Aqua **or** Terra | 114 |
| Nov 2000 – Jul 2002 | `estimated_from_terra` (`terra_frp`) | Terra only (Aqua not yet flying) | 21 |
| Feb 2012 – Nov 2026 | observed | — VIIRS data, unchanged | 174 observed + 4 near-real-time |

Using **Aqua or Terra** rather than Aqua alone is a substantive choice: two morning/afternoon
overpasses catch fire that one misses. Measured effect — the share of VIIRS activity sitting in
cell-months where the MODIS input saw *nothing* falls from **9.5% to 6.9%**
([comparison_all.csv](../reports/experiments/comparison_all.csv)). That activity can still be
counted in totals, but it cannot be placed on the map, so reducing it is a real gain in spatial
honesty.

A fallback to the original VIIRS/Aqua table exists for any estimated month where the model's MODIS
input lacks full coverage. **In this run it was never needed** — `fallback_months` is empty
([adopted_model.json](../reports/calibration/adopted_model.json)).

---

## 4. Where each part shows up in the app

| In the app | Produced by | Notes |
|---|---|---|
| The calendar (months × years, coloured squares) | `harmonised_cell_month.parquet` via [export.py](../pipeline/export.py) | The main view. Estimated months are flagged |
| "Harmonised" vs "Raw sensors" toggle | same export, raw per-platform columns | Raw view deliberately shows the 2012 step |
| "Compared with normal" | browser: month ÷ median of same month in other years | Separate purple–grey–brown scale |
| Likely range on estimated years | `uncertainty.json` → `manifest.json` | q10/q50/q90 of observed÷predicted from leave-one-year-out, interpolated on log(area) |
| "Low confidence" badge | `LOW_CONFIDENCE_BELOW_KM2 = 10_000` in [export.py](../pipeline/export.py) | Shown when <10,000 km² of Canada is in the box |
| "Where fire is changing" layer | [web/src/trend.js](../web/src/trend.js) | Theil–Sen slope + Mann–Kendall, p ≤ threshold, needs ≥ min complete years |
| Season-timing chart | [web/src/compare.js](../web/src/compare.js) | Bars span the middle 80% of each year's cell-days |
| Live fire layer | [worker/src/index.js](../worker/src/index.js) + [web/src/live.js](../web/src/live.js) | NOAA-20 + **NOAA-21** NRT, clipped to Canada, **not harmonised** |
| People / exposure list | [population.py](../pipeline/population.py) | WorldPop 2020; exposure only, explicitly not a priority ranking |
| About page figures and all its numbers | [about_data.py](../pipeline/about_data.py) → `about.json` | Nothing on that page is typed by hand |

NOAA-21 appears **only** in the live layer and is excluded from the harmonised record
(`config.py`: "data/raw/viirs-noaa21/ is stored but not used yet"). The app and About page both say
so. That is the correct and conservative choice, since NOAA-21 has no overlap history in the fitted
tables.

---

## 5. How we know it is right

Three independent lines of evidence. I reran all three; each reproduced exactly.

### 5a. Leave-one-year-out (the headline 5.7%)

Each year 2012–2025 is hidden in turn, the tables are refitted without it, and the model estimates
that year from MODIS alone. **Reran** `harmonise.loyo` on all 190,048 training rows:

| Scale | Weighted abs. error, yearly totals |
|---|---|
| **All Canada** | **5.7%** |
| Province | 8.2% |
| ~12,400 km² | 19.8% |
| Display cell (~253 km²) | 36.0% |
| Canada-wide bias | −0.0% |
| Observed ÷ estimated, across all 14 held-out years | 0.918–1.238 |

**The 5.7% figure you quote is confirmed.** It is specifically the *Canada-wide, annual, weighted
absolute error under leave-one-year-out for the adopted `estimated_from_modis` model*. Quote it with
that scope attached: at a single grid cell the same model is off by about 36%. The error shrinks as
area grows, which is why the app labels small boxes low-confidence.

The Terra-only model (Nov 2000 – Jul 2002) scores 5.5% at Canada-year, range 0.907–1.199.

Per-year errors reveal where the model struggles — 2014 is **−19.2%** and 2018 **−11.2%**, while
most years sit within ±9%.

### 5b. Backwards test (the harder, more honest test)

Fit on 2019–2025 only, then estimate 2012–2014 — a genuine extrapolation backwards across a
7-year gap. **Read from** [validation_metrics.json](../reports/calibration/validation_metrics.json),
and the model-comparison rerun reproduced the same values:

Adopted model: Canada 11.1%, province 14.5%, ~12,400 km² 28.1%, cell 45.1%, with 2014 at −18.5%.
Previous method under the same test: Canada 15.6%, province 20.7%, 2014 at −29.2%.

This test is worse than LOYO across the board, as it should be. If a judge asks which number to
trust, this is the conservative one.

### 5c. Independent check against NBAC burned area (the −1.6%, and "no step at 2012")

NBAC maps hectares actually burned and **is not a model input** — nothing is tuned to it. For each
ecozone, one hectares-per-cell-day ratio is fitted on 2012–2025 and applied unchanged to earlier
years. If the conversion introduced a step at 2012, the estimated years would drift away from NBAC.

**Reran** [nbac_check.py](../pipeline/nbac_check.py) in full (all 26 NBAC years, 11 ecozones above
the 100,000 ha threshold). Output was **byte-identical** to the committed
[nbac_check.json](../reports/nbac_check/nbac_check.json), figure included.

Estimated years 2003–2011:

| Series | Bias | Scatter (median \|log ratio\|) |
|---|---|---|
| **Adopted model** | **−1.6%** | **0.454** |
| Previous table | −1.7% | 0.474 |
| Raw MODIS Aqua (same satellite throughout) | +0.2% | 0.475 |
| Raw MODIS Terra (diagnostic) | −3.3% | 0.489 |

**The −1.6% is confirmed, and so is "no step at 2012"** — with a stronger reading than the About
page claims. The argument is a control: raw Aqua is the *same instrument* before and after 2012, so
whatever error it shows against NBAC is the NBAC relationship's own noise, not a harmonisation
artefact. The adopted model's bias (−1.6%) sits within about 1.8 points of that control (+0.2%),
and its **scatter is slightly tighter than raw Aqua's** (0.454 vs 0.475). A conversion that
introduced a step would show neither.

Precise wording I would recommend to a judge: *"Across 99 ecozone-years of estimated data the
harmonised series is biased −1.6% against independently mapped burned area, against +0.2% for the
same-sensor control — so the conversion adds no detectable step at 2012."* Note the claim is about
**no detectable step**, bounded by the control's own noise; it is not a claim of zero error.

The in-sample fit years are identical for all three series by construction (bias 0.0%, wabs 19.6%),
so only the estimated years carry information.

---

## 6. Why it matters

Canada's fire record splits in two exactly where the policy questions get interesting. Asking
whether 2023 was unprecedented, or whether fire is arriving earlier in the season, requires
comparing years on either side of 2012 — and the raw record cannot do that, because VIIRS finds
about **4.31×** as many fire cell-days as Aqua in the same fires
([about.json](../web/public/about/about.json), computed in [about_data.py](../pipeline/about_data.py)).
Any trend drawn straight through 2012 is measuring a satellite change, not a change in fire.

Ember puts all 26 years on the VIIRS scale, attaches an honest range to every estimated year, and
labels which months are estimated rather than observed — so a user can see when they are looking at
a model output rather than a measurement.

---

## 7. Problems we hit, and methods we rejected

Nine harmonisation variants were tested identically — same common-day mask, same backwards test,
same leave-one-year-out, same four spatial scales
([comparison_all.csv](../reports/experiments/comparison_all.csv)). **Reran** `experiments.py`; all
figures below reproduced exactly. LOYO weighted absolute error:

| Variant | Canada | Province | ~12,400 km² | Cell | 2014 | Verdict |
|---|---|---|---|---|---|---|
| `table_aqua` (previous) | 8.3% | 12.4% | 25.9% | 45.2% | −29.4% | superseded |
| `intensity_dpc` (detections per cell-day) | 7.3% | 11.5% | 24.8% | 44.1% | −27.6% | beaten by FRP |
| `intensity_frp` | 7.2% | 10.4% | 23.9% | 44.2% | −24.9% | beaten by union |
| `loglin_aqua` (Poisson log-linear) | 10.9% | 13.5% | 24.7% | 42.0% | −36.3% | **rejected** |
| `table_terra` | 7.5% | 10.8% | 24.1% | 42.3% | −20.3% | — |
| `table_union` | 7.1% | 10.0% | 22.1% | 37.3% | −23.7% | — |
| `terra_frp` | 5.5% | 8.9% | 21.4% | 40.9% | −16.6% | **adopted, 2000–2002** |
| **`union_frp`** | **5.7%** | **8.2%** | **19.8%** | **36.0%** | **−19.2%** | **adopted, 2002–2012** |
| `terra_chain` (previous, Terra months) | 9.6% | 14.0% | 26.5% | 45.1% | −19.1% | superseded |
| `aqua_size` (NBAC size class) | 10.6% | 14.1% | 27.9% | 47.1% | −28.2% | **rejected** |
| `union_size` | 9.2% | 11.8% | 23.9% | 38.9% | −22.9% | **rejected** |
| `union_size_frp` | 7.4% | 9.8% | 20.7% | 36.4% | −18.9% | **rejected** |
| `union_frp + nfdb_fill` | 6.2% | 8.9% | 20.5% | 35.9% | −20.3% | **rejected** |

**Rejected, and why:**

- **Log-linear Poisson fit on fire intensity.** Worst Canada-level error of any variant (10.9%),
  LOYO bias −10.9%, and an observed÷predicted range of 1.005–1.569 that never brackets 1 — it
  systematically under-predicts. It won slightly at single-cell scale (42.0%), which is a good
  reminder that picking a model on one scale alone would have chosen wrong.
- **NBAC fire-size classes as an extra stratum.** Added a predictor that *does not exist* for the
  years being estimated without NBAC coverage, and still lost: `aqua_size` is worse than plain
  `table_aqua` at every scale. `union_size_frp` (7.4%) stayed behind `union_frp` (5.7%). Splitting
  the data further thinned the strata faster than the extra signal paid for.
- **Filling from reported fires (NFDB).** This was the attempt to solve the real problem that
  activity in cell-months where MODIS saw nothing can be counted but not located. It worked, but
  barely: of that zero-input activity it placed only **2.3%** in the right cell-month, while
  Canada-level error got worse (6.2% vs 5.7%). Not worth the extra dependency and complexity for
  2.3%.
- **A WorldCover water mask to catch over-water NRT detections.** Rejected because it dropped
  ~3.5% of true fires on lakeshores ([typeinfer.py](../pipeline/typeinfer.py)) — worse than the
  ~2.7% problem it fixed.

**Problems hit along the way, visible in the code:**

- **Coverage vs zero.** A missing cell had to mean "no fire" in a covered month and "unknown" in an
  uncovered one. Getting this wrong would have read satellite absence as fire absence. Handled by
  the explicit `full`/`partial`/`none` coverage table, with `none` months forced empty.
- **The local-date shift.** Converting UTC to local solar date pushes some 1 January detections into
  31 December of a year with no data. 24 such cell-days were dropped rather than silently kept.
- **Satellite outages.** A platform reporting zero while others report plenty is an outage, not a
  quiet day; counting it would have diluted the VIIRS mean. Hence the `OUTAGE_MIN = 50` rule and 115
  outage days masked in total.
- **NRT rows have no `type` column**, so vegetation fire could not be filtered the normal way —
  solved with the static-source-cell inference in §3, and its residual ~2.7% over-water error is
  disclosed on the About page.
- **Thin strata.** The finest stratification is too thin in much of the north, which forced the
  seven-level fallback ladder rather than a single fixed stratification.

---

## 8. Honest limits, with sizes

1. **Extreme northern fire years are underestimated.** 2014 comes in at **−19.2%** for all of
   Canada when hidden ([adopted_model.json](../reports/calibration/adopted_model.json)); 2018 at
   −11.2%. Very large, long-burning northern fires yield more VIIRS detections per MODIS detection
   than the tables expect. This is the single largest known weakness.
2. **2001 and 2002 are low against burned area.** Against NBAC: **−11.6%** (2001) and **−36.1%**
   (2002); for the whole 2001–2002 window the bias is **−31.4%**. Raw Terra shows the same gap
   (−22.4%, −31.9%; −30.1% overall), so it is **not** caused by the conversion — but those two
   years should be read with care regardless ([nbac_check.json](../reports/nbac_check/nbac_check.json)).
3. **Small areas are uncertain.** Yearly estimates are off by about **36.0%** at one ~253 km² cell
   and **19.8%** at ~12,400 km². Below 10,000 km² of Canada in the box, estimated years are badged
   low confidence.
4. **Detected fire is a floor.** **9.6%** of VIIRS cell-days fall in display-cell-months where Aqua
   saw nothing (68.5% of such cell-months, but they are small — median 1.0 cell-day). At ~12,400 km²
   this drops to **3.1%** ([zero_cases.json](../reports/calibration/zero_cases.json)). Totals
   include this activity; the map cannot place it for years before 2012.
5. **Near-real-time months are provisional.** Data end 14 November 2026 (S-NPP ends 2 November
   2026). NRT files do not flag industrial or over-water detections, so ~2.7–2.9% of VIIRS NRT rows
   may not be vegetation fire (my rerun, §3).
6. **Land cover is one 2021 snapshot** applied to all 26 years, so areas that burned and regrew
   before 2021 may be classed as grass-shrub rather than forest.
7. **Canada only.** The tables are fitted to Canadian ecozones and do not transfer.
8. **2000 and 2026 are partial years** (Nov–Dec 2000; to 14 Nov 2026) and are flagged as such.
9. **Population is modelled, and six years old** — WorldPop 2020, not a census count.
10. **Not established:** no formal uncertainty is propagated for the Terra→Aqua step into
    individual cell values (only the Canada-wide annual range combines it, added in quadrature on
    the log scale in [calibrate.py](../pipeline/calibrate.py)); and no sensitivity test exists for
    the choice of `MIN_DEN = 200` / `MIN_YEARS = 3`. The 2023 sensitivity test *was* done —
    refitting without 2023 moves the backwards Canada error only from 15.6% to 14.1%, so the record
    does not hinge on that one extreme year.

---

## 9. Statements in the app the code does not fully support

I checked the About page and the app's visible copy line by line against the pipeline. The page is
unusually disciplined — every figure is generated by [about_data.py](../pipeline/about_data.py) from
a report, so there are no invented numbers. Four wording issues, all small, none affecting a
headline result:

1. **`viirs_over_modis_2012_2025` is computed over 2018–2025, not 2012–2025.**
   In [about_data.py](../pipeline/about_data.py) the key filters `cdy.year.between(2018, 2025)`.
   The name is wrong, not the number — the restriction to 2018+ is deliberate and *more* correct,
   since it averages both VIIRS platforms. **Verified both ways:** 4.31 as computed; 4.39 for
   S-NPP ÷ Aqua over 2012–2025. The displayed "about 4.31 times" is sound. Rename the key.
2. **"S-NPP ${outage} days, NOAA-20 ${outage}" is described as "days when one satellite was out of
   service".** The code's rule is a *proxy* for outage — zero cell-days in Canada while another
   platform has ≥50 ([calibrate.py](../pipeline/calibrate.py), `availability`). That will also catch
   a genuine no-fire day during a quiet season. Defensible, but it is an inferred outage, not a
   published service record. Worth saying "days treated as outages" if a judge presses.
3. **`typeinfer.py` says over-water detections are "~0.1% for MODIS".** Measured: **0.00%** — MODIS
   archive files contain no type-3 rows at all (my rerun, §3). The About page's "about 3% of VIIRS
   detections" is correct (2.67–2.91%).
4. **The Newfoundland and Labrador emergency link is dead** — see §10. This is the only
   user-facing error I found that could matter in an emergency, and the only one I would fix before
   judging.

I found **no** case of the app claiming accuracy the validation does not show. The About page
consistently reports the *weaker* of the available numbers (it leads with LOYO and also shows the
harder backwards test), labels estimated months, and states the 2014 and 2001–2002 weaknesses
outright. The "no step at 2012" claim is properly hedged as "matches NBAC about as well as raw Aqua
does", which is exactly what the data support.

---

## 10. External link check

Every external link in the app and on the About page, opened 15 November 2026.

**Broken — needs fixing:**

| Link | Where | What happens | Fix |
|---|---|---|---|
| `https://www.gov.nl.ca/ffa/wildfires/` | About → Evacuation and emergency information, Newfoundland and Labrador | **301 → "Department Websites Have Changed"** notice. The old Department of Fisheries, Forestry and Aquaculture was split up; the page is retired and carries no wildfire information | **`https://www.gov.nl.ca/fal/wildfiremanagement/`** — verified 200 OK, titled "Wildfire Management – Forestry, Agriculture and Lands", carries the wildfire reporting number, active wildfires, fire bans |

**Redirects, all benign and to the right organisation:**

| Link | Redirects to | Verdict |
|---|---|---|
| `https://www.alberta.ca/alberta-emergency-alert` | `…alberta-emergency-alert.aspx` | Same page, same org. Fine |
| `https://novascotia.ca/alerts/` | `https://emergencyinfo.novascotia.ca/` | Province's dedicated emergency site. Correct org, arguably better destination |
| `https://doi.org/10.5281/zenodo.7254221` | `https://zenodo.org/records/7254221` | Normal DOI resolution to the WorldCover v200 record. Correct |

**Blocked to automated checks but working for real users** — both return HTTP 403 with
`cf-mitigated: challenge` and a Cloudflare "Just a moment..." interstitial. This is bot protection,
**not** a broken link:

- `https://yukon.ca/` (Yukon)
- `https://www.gov.nu.ca/` (Nunavut)

I could not read either page's content through any automated client, so I cannot confirm from here
that they are the best *wildfire-specific* destinations — both are territorial homepages rather than
dedicated emergency pages, unlike the other provinces' links. **Not established:** whether a more
specific Yukon or Nunavut emergency page exists. Worth one manual browser check.

**All remaining links: 200 OK, correct organisation, no unexpected redirect** — EmergencyInfoBC,
Saskatchewan Public Safety Agency, Manitoba EMO, Ontario forest fires, Québec sécurité civile,
SOPFEU, New Brunswick emergency preparedness, PEI emergency management, NWT MACA emergency
management, Alert Ready, Open Government Licence – Canada, CWFIS, the GitHub repository,
OpenFreeMap positron style, both FIRMS pages, the ecozone zip, the Natural Earth zip, the NBAC and
NFDB download directories, the WorldPop directory, the GeoNames dump directory, the ESA WorldCover
S3 bucket (tested with a real tile), and worldpop.org.

No link pointed at the wrong organisation.

---

## 11. Tools used

Python 3.12.13 with pandas 3.1.1, numpy 2.5.4, h3 4.5.0, geopandas 1.2.0, rasterio 1.5.2,
scipy 1.18.1 (NNLS, in the rejected NFDB variant only), matplotlib 3.11.2, pyarrow/pyogrio/shapely/pyproj.

Web: Node 22.16.0, Vite 8.3.5, MapLibre GL JS 5.24.0, h3-js 4.4.0, IBM Plex fonts. Live-fire proxy:
Cloudflare Worker via Wrangler 4.156.0, which keeps the FIRMS map key server-side. Deploy: GitHub
Actions to GitHub Pages. Storage: Parquet (zstd) for intermediates, a packed binary plus JSON
manifest for the app.

No machine-learning framework is used anywhere. Every model is a stratified ratio table or a small
regression, so each number in the app can be traced to a specific stratum and a specific count —
which is why the rejected log-linear variant was no loss.

---

## 12. The ten hardest questions a remote-sensing judge could ask

**1. A ratio of cell-days is not a physical quantity. Why should VIIRS÷MODIS cell-days be stable
enough to extrapolate 12 years backwards?**
It should not be assumed stable, which is why it is stratified by the things that drive the
difference — land cover, season, region and fire intensity (FRP tercile) — and then tested by
hiding years. The honest answer is empirical: under leave-one-year-out the Canada-annual error is
5.7% with −0.0% bias, and against independently mapped burned area the estimated years are biased
−1.6% versus +0.2% for a same-sensor control. The ratio is not claimed to be physically invariant;
it is claimed to be *predictively stable at large scale*, and it fails measurably at small scale
(36% at one cell).

**2. Your validation trains and tests on 2012–2025, all VIIRS-era. The target period is
2000–2011, which was a different fire climate. Isn't this circular?**
It is the central limitation and partly unavoidable — no VIIRS data exist before 2012. Two things
reduce the circularity. The backwards test extrapolates across a real 7-year gap (fit 2019–2025,
predict 2012–2014) and gives 11.1% at Canada level, which is the number I would defend as
conservative. And the NBAC check compares the estimated years against ground-truth burned area
that was never used in fitting, covering 2003–2011 — genuinely outside the training period.

**3. MODIS Terra's orbit drifted and its sensor degraded over 26 years. Where is that in your
model?**
It is not explicitly modelled, and that is a real gap. Three mitigations: Terra and Aqua are kept
as separate platforms throughout and never pooled as "MODIS"; the Aqua-or-Terra union means no
single platform's drift dominates after Aug 2002; and the NBAC check includes raw Terra as a
diagnostic series, which would reveal a drift large enough to distort the result. The residual
risk sits in Nov 2000 – Jul 2002, where Terra is the only input — and that is exactly the window
where the NBAC check shows the largest disagreement (−31.4%). I would not defend 2001–2002 as
strongly as the rest of the record.

**4. Cell-days saturate. A 100,000 ha fire and a 1,000 ha fire in the same cell on the same day
both count as one. Doesn't that destroy the signal in extreme years?**
Yes, and it shows up precisely where predicted: 2014 is −19.2% and the largest fires are the worst
case, because a long-burning northern fire produces more VIIRS detections per MODIS detection than
the tables expect. Saturation is why FRP tercile was added — intensity partially recovers what the
binary count throws away, and it is the single biggest improvement in the comparison (Canada error
7.2% vs 8.3% from intensity alone; 5.7% combined with the union). Cell-days were chosen over
detection counts deliberately, because raw counts are far more sensitive to pixel size and scan
geometry.

**5. You use ESA WorldCover 2021 for the whole record. Fire changes land cover. Isn't the
stratification contaminated?**
Yes, and it is disclosed as a limit. A cell that burned in 2003 and regrew may be classed
grass-shrub in 2021 rather than the forest it was. The effect is bounded by the land-cover
stratification being only one of four axes, and by the fallback ladder merging thin classes. No
time-varying land cover product covers 2000–2026 at this resolution, so the alternative was a
coarser or older single snapshot. **Not established:** the size of this contamination — I would not
claim a number for it.

**6. Why H3 hexagons rather than a sinusoidal or equal-area grid matched to the MODIS product?**
Area stability with a single global indexing scheme. Over the cells with fire, H3 res 5 varies
1.55× in area (197–305 km²) against 6.19× for 0.25° cells across Canada's latitude span — and
Canada reaches 83°N, where degree cells collapse. H3 also gives free hierarchical aggregation, used
for the ~12,400 km² validation scale (res 3) and for the ~1 km detection grid (res 8). The cost is
that hexagons do not align with MODIS or VIIRS pixel grids, so a single pixel can contribute to
neighbouring cells — acceptable because the unit is per-cell presence, not a radiometric quantity.

**7. Your VIIRS reference is the *mean* of S-NPP and NOAA-20. Why not the union, and what happens
at the 2018 NOAA-20 boundary?**
The mean, because the union would step up when the second platform arrives in 2018, reintroducing
exactly the discontinuity the project exists to remove. The mean keeps one platform-equivalent
scale across the whole VIIRS era. The boundary is safe because the two platforms agree closely:
NOAA-20÷S-NPP is 0.992–1.038 by year, with log-space correlation 0.897 at cell-month. Days when one
platform is unavailable use the other alone, which the agreement figures show is a small
perturbation.

**8. How do you know your error bars are calibrated rather than just plausible-looking?**
They are empirical quantiles, not parametric assumptions: the q10/q50/q90 of observed÷predicted
across 14 held-out years, computed separately at each of four spatial scales and both monthly and
annual periods, then interpolated on log(area) for intermediate box sizes
([export.py](../pipeline/export.py)). For the Canada-annual case the *full* held-out range
(0.918–1.238) is used instead of q10–q90, specifically so hard years like 2014 fall inside the band
rather than outside it. The known weakness: with only 14 held-out years, the tails are thinly
sampled, so the extremes are better read as "the worst we saw" than as true 10th/90th percentiles.

**9. Confidence filtering differs between the instruments — numeric ≥30 for MODIS, categorical
n/h for VIIRS. Doesn't that bias the ratio you are fitting?**
It would if the thresholds were tuned, but both are the product-documented low-confidence class and
nothing was swept. More importantly, any residual mismatch is *absorbed into the ratio itself*: the
tables learn whatever relationship exists between the filtered MODIS series and the filtered VIIRS
series, so a consistent filtering difference is calibrated away rather than propagated. The risk is
if the mismatch varies by stratum — which is partly why stratification is by region, cover, season
and intensity rather than applied nationally. VIIRS low confidence is also only ever assigned to
daytime pixels, which is documented in [config.py](../pipeline/config.py).

**10. 9.6% of VIIRS activity is in places and months where MODIS saw nothing. You put that in the
totals but cannot map it. Isn't the spatial product misleading for pre-2012 years?**
It is a genuine asymmetry and it is stated as a limit. Three qualifications. The unmappable share
falls to 3.1% at ~12,400 km², so it is mostly a fine-scale problem. It is mostly small events —
median 1.0 cell-day per case, concentrated in winter (57.4%) and the southern region (53.7%), i.e.
not the large northern fires that dominate totals. And reducing it drove the choice of the
Aqua-or-Terra union, which cut it from 9.5% to 6.9%. We also tested placing it from reported fires
(NFDB) and rejected that: it located only 2.3% of it while making Canada-level error worse. For
pre-2012 years the map should be read as "where MODIS could see fire", with the totals carrying the
rest.

---

## Reproducing anything here

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cd pipeline
../.venv/bin/python nbac_check.py     # §5c, the -1.6% and the no-step check
../.venv/bin/python experiments.py    # §7, the full variant comparison
```

The three reruns in this document used the committed intermediates in `data/interim/`. The NBAC
rerun reproduced [nbac_check.json](../reports/nbac_check/nbac_check.json) byte-for-byte, figure
included; the experiments rerun reproduced every row of
[comparison_all.csv](../reports/experiments/comparison_all.csv); the leave-one-year-out rerun
reproduced 5.7% / 0.918–1.238 and the −19.2% for 2014. Rerunning from the raw FIRMS CSVs requires
re-downloading the inputs in §2.
