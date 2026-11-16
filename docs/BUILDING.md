# Building Ember from scratch

Running the app needs none of this: the harmonised export is committed in `web/public/harmonised/`,
so `cd web && npm install && npm run dev` is enough. This page is for rebuilding that export from
the raw NASA files, and for the full list of what Ember uses.

The method itself, with the validation tests and the limits, is in
[HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## Rebuilding the data

Requirements: Python 3.12, Node 22, about 3 GB free disk, internet access (land cover is read from
ESA WorldCover's public cloud bucket).

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
```

### 1. Get the data (not in git)

| Data | Where | Put it in |
|---|---|---|
| FIRMS yearly country summaries: `modis_<year>_all_countries.zip` (2000–2025), `viirs-snpp_<year>_all_countries.zip` (2012–2025), `viirs-jpss1_<year>_all_countries.zip` (2018–2025) | https://firms.modaps.eosdis.nasa.gov/country/ | `data/zips/` |
| FIRMS archive download for Canada for the current year (M-C61, SV-C2, J1V-C2; archive and NRT CSVs) | https://firms.modaps.eosdis.nasa.gov/download/ | `data/raw/modis/2026/`, `data/raw/viirs-snpp/2026/`, `data/raw/viirs-noaa20/2026/` |
| Terrestrial ecozones of Canada | https://sis.agr.gc.ca/cansis/nsdb/ecostrat/zone/ecozone_shp.zip | unzip to `data/external/ecozones/` |
| Natural Earth admin-1, 1:50m | https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_1_states_provinces.zip | unzip to `data/external/ne_admin1/` |
| NBAC per-year zips 2000–2025 (for the check and experiments) | https://cwfis.cfs.nrcan.gc.ca/downloads/nbac/ | `data/external/nbac/` |
| NFDB fire points, text (experiments only) | https://cwfis.cfs.nrcan.gc.ca/downloads/nfdb/fire_pnt/current_version/ | unzip to `data/external/nfdb/txt/` |
| WorldPop 2020 1 km UN-adjusted population, Canada (`can_ppp_2020_1km_Aggregated_UNadj.tif`) | https://data.worldpop.org/GIS/Population/Global_2000_2020_1km_UNadj/2020/CAN/ | `data/external/worldpop/` |
| GeoNames `cities500.zip` (place names) | https://download.geonames.org/export/dump/ | `data/external/geonames/` |

### 2. Run the pipeline

```bash
P=".venv/bin/python pipeline"
$P/extract_country.py --country Canada   # Canada CSV from each zip -> data/raw/<sensor>/ (verified zips in data/zips are deleted)
$P/inspect_raw.py                        # optional: columns, dtypes, row counts
$P/clean.py                              # filters -> data/interim/detections/, reports/filter_report.json
$P/cell_days.py                          # fire cell-days, coverage, monthly totals
$P/landcover.py                          # ESA WorldCover class per fire cell
$P/regions.py                            # ecozone and province per display cell
$P/calibrate.py                          # VIIRS reference, original ratio table, validation, month sources
$P/experiments.py                        # variant comparison (stage A); also builds the base the adopted model uses
$P/nbac_link.py                          # link fire cells to NBAC fires (needs NBAC)
$P/experiments_b.py                      # stage B variants + reports/experiments/comparison_all.csv (needs NBAC, NFDB)
$P/harmonise.py                          # apply the adopted model -> data/processed/harmonised_cell_month.parquet
$P/figures.py                            # reports/figures/canada_annual_series.png
$P/nbac_check.py                         # independent check -> reports/nbac_check/, reports/figures/nbac_check.png
$P/population.py                         # WorldPop people per cell and in fire cells, GeoNames places
$P/export.py                             # static files for the app -> web/public/harmonised/
$P/hotspot_tiles.py                      # hotspot tiles -> web/public/hotspots/ (not in git)
$P/about_data.py                         # numbers and figures for the app -> web/public/about/
```

New data (for example the next year's archive files) are picked up by rerunning from `clean.py`.
The conversion tables stay fitted on 2012–2025 unless `TRAIN_ALL` in `pipeline/calibrate.py` is changed.

### 3. Run the app

```bash
cd web
npm ci
npm run dev        # http://localhost:5173/
npm run build      # static site in web/dist/
```

The app is fully static. The hotspot download reads `web/public/hotspots/`; without it, that button is hidden.

### 4. Live fire Worker (optional)

The live fire layer reads NASA FIRMS near-real-time data through a small Cloudflare Worker in `worker/`,
which keeps the FIRMS map key as a secret. Without it the app hides that layer and everything else works.

```bash
cd worker
npm ci
npx wrangler login
npx wrangler deploy                       # prints the Worker address
npx wrangler secret put FIRMS_MAP_KEY     # paste the key when asked
gh variable set LIVE_URL --body "https://ember-live-proxy.<your-subdomain>.workers.dev"
```

For local testing put `FIRMS_MAP_KEY=...` in `worker/.dev.vars` (not committed), run `npx wrangler dev`,
and start the app with `VITE_LIVE_URL=http://127.0.0.1:8787 npm run dev`.

To point the dev server at the deployed Worker instead, write the address to `web/.env.local`
(not committed) and restart the dev server:

```bash
printf 'VITE_LIVE_URL=%s\n' "$(gh variable get LIVE_URL)" > web/.env.local
```

Without it, live mode shows "Live fire data is unavailable right now." and the dev console says why.
The dev server uses `strictPort`, because the Worker only allows requests from `:5173` and `:4173`;
on another port it would refuse them.

### 5. Deploy

Pushing to `main` builds and deploys to GitHub Pages (`.github/workflows/deploy.yml`). The hotspot
tiles are too large for git, so they are published as an asset on the `hotspot-tiles` release and
added at build time:

```bash
tar -cf hotspots.tar -C web/public hotspots
gh release upload hotspot-tiles hotspots.tar --clobber
```

## Data and tools

Everything Ember uses, with the page or endpoint it is actually taken from.

### NASA data

| What | Used for | Link |
|---|---|---|
| FIRMS archive download (MODIS Collection 6.1, VIIRS 375 m Collection 2) | Every fire detection in the harmonised record, 2000 to present | https://firms.modaps.eosdis.nasa.gov/download/ |
| FIRMS area API (`/api/area/csv/`) | Near-real-time hotspots in live mode, fetched server-side by the Worker | https://firms.modaps.eosdis.nasa.gov/api/area/ |
| FIRMS | The service itself, part of NASA's Earth Science Data and Information System (ESDIS) | https://firms.modaps.eosdis.nasa.gov/ |
| NASA Earthdata: FIRMS | Product documentation and access | https://www.earthdata.nasa.gov/data/tools/firms |

Instruments behind those detections: MODIS on Terra and Aqua, VIIRS on Suomi-NPP, NOAA-20 and
NOAA-21.

### Space agency partner data

| What | Used for | Link |
|---|---|---|
| ESA WorldCover 10 m 2021 v200 | Land cover class (forest, grass and shrub, cropland, other) in the conversion tables; read directly from the public bucket | https://esa-worldcover.org/en |
| ESA WorldCover v200 release | The dataset record and citation | https://zenodo.org/records/7254221 |

### Other data

| What | Used for | Link |
|---|---|---|
| National Burned Area Composite (NBAC), Canadian Forest Service | Independent check against burned area, and fire size and name in the *Why it burned* card | https://cwfis.cfs.nrcan.gc.ca/downloads/nbac/ |
| Canadian National Fire Database (NFDB), fire points | Recorded cause of fires in the *Why it burned* card | https://cwfis.cfs.nrcan.gc.ca/downloads/nfdb/fire_pnt/current_version/ |
| CWFIS Active Fires, from provincial, territorial and Parks Canada agencies | Agency-reported fires near a cell in live mode: name, size, stage of control | https://cwfis.cfs.nrcan.gc.ca/datamart |
| Terrestrial Ecozones of Canada, Agriculture and Agri-Food Canada | The 15 fire regions the conversion tables are fitted per | https://sis.agr.gc.ca/cansis/nsdb/ecostrat/zone/ecozone_shp.zip |
| WorldPop 2020 1 km UN-adjusted, Canada | People living in an area, and the exposure list | https://data.worldpop.org/GIS/Population/Global_2000_2020_1km_UNadj/2020/CAN/ |
| WorldPop | The project itself | https://www.worldpop.org/ |
| GeoNames `cities500` | Place names on the globe | https://download.geonames.org/export/dump/ |
| Natural Earth 1:50 m admin 1 states and provinces | Canada and province boundaries; clipping detections to Canada | https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_1_states_provinces.zip |
| Natural Earth | The project itself | https://www.naturalearthdata.com/ |
| OpenFreeMap (positron style), © OpenMapTiles, data © OpenStreetMap contributors | The base map | https://openfreemap.org/ |

NBAC, NFDB, CWFIS and the ecozones contain information licensed under the
[Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).

### Tools

| What | Used for | Link |
|---|---|---|
| MapLibre GL JS | The globe and every map layer | https://maplibre.org/maplibre-gl-js/docs/ |
| H3 (`h3-js` 4.4.0 in the app, `h3` in the pipeline) | The hexagon grids: resolution 8 for detection, 5 for display | https://h3geo.org/ |
| Vite | Build and dev server for the web app | https://vite.dev/ |
| Cloudflare Workers | The proxy that keeps the FIRMS key off the client | https://developers.cloudflare.com/workers/ |
| GitHub Pages | Hosting the live app | https://pages.github.com/ |
| pandas | Every table in the pipeline | https://pandas.pydata.org/ |
| NumPy | The numeric work behind the conversion tables | https://numpy.org/ |
| GeoPandas | Ecozone, boundary and NBAC geometry | https://geopandas.org/ |
| Rasterio | Reading the WorldCover and WorldPop rasters | https://rasterio.readthedocs.io/ |
| SciPy | Non-negative least squares (`scipy.optimize.nnls`) in the rejected-models experiment | https://scipy.org/ |
| Matplotlib | The validation figures in `reports/figures/`, served by the app | https://matplotlib.org/ |
| IBM Plex Sans and IBM Plex Mono | The app's typefaces, bundled via `@fontsource` (SIL Open Font License 1.1) | https://www.ibm.com/plex/ |
| Claude (Anthropic) | AI coding assistant, used as described under [Use of AI tools](../README.md#use-of-ai-tools) | https://claude.com/product/claude-code |

