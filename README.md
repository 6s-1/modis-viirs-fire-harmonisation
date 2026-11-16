# Ember

**Ember joins 26 years of NASA MODIS and VIIRS fire detections into one comparable record for
Canada, so any season can be read against the 25 before it.**
It is a burning activity calendar for any area of the country, from November 2000 to today.

**Live app: https://6s-1.github.io/modis-viirs-fire-harmonisation/**

NASA Space Apps 2026 challenge: *Harmonization of MODIS and VIIRS Hot Spots*. Team Sitara OPS.

![The Ember dashboard: a globe of Canada covered in fire grid cells, with the selection panel and the month-by-year burning calendar beside it.](docs/img/dashboard.png)

## The problem, and what Ember does about it

MODIS (Terra and Aqua, from 2000) has 1 km pixels; VIIRS (S-NPP from 2012, NOAA-20 from 2018) has
375 m pixels and finds **4.31x** as many fire cell-days in the same fires. Laid end to end the raw
record jumps in 2012, and every long-run question runs into that seam. Ember converts the whole
record to **VIIRS-equivalent fire cell-days** using conversion tables fitted where the two sensors
overlap, so years can be compared on one scale.

## Does it work?

Years are hidden from the model and its estimate compared with what VIIRS actually recorded
(leave-one-year-out, 2012-2025; weighted absolute error of yearly totals):

| Scale | Previous method | **Ember** |
|---|---|---|
| Canada | 8.3% | **5.7%** |
| Province | 12.4% | **8.2%** |
| Grid cell (~250 km2) | 45.2% | **36.0%** |

Across all hidden years, Canada-wide estimates land within **0.92-1.24x** the observed value. An
independent check against NBAC burned area (never a model input) shows **no step at 2012**: the
estimated years 2003-2011 track NBAC about as well as raw MODIS Aqua, the same satellite before and
after. Full method, every test and the limits: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) and the
app's **i** panel in the header.

## Run it

```bash
cd web && npm install && npm run dev      # http://localhost:5173
```

That is all it takes: the harmonised export is committed, so there is nothing to download or
rebuild. Live mode additionally needs the Cloudflare Worker in `worker/` with a FIRMS key; without
it the 26-year record still works.

## What you can do

Draw a box or type bounds, pick a date range, and read the calendar: every month since 2000 on one
scale. Click a month or a cell for what caused the fire, how much land burned and what kind of land
it was. Compare puts fire and people on two linked globes. Live shows what the satellites are
seeing right now, grouped into the same cells as the history. Everything on screen downloads as CSV
or PNG.

## How it is built

A Python pipeline turns raw FIRMS detections into fire cell-days on an H3 grid, learns a conversion
from the 2012–2025 MODIS/VIIRS overlap — kept separately per ecozone, land cover, season and fire
intensity — and applies it backwards to 2000. The web app is Vite and MapLibre reading a static
binary export, hosted on GitHub Pages; a Cloudflare Worker proxies live data so the FIRMS key never
reaches the browser.

- **The method, every validation test and the honest limits:** [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)
- **Rebuilding from the raw files, and the full list of data and tools:** [docs/BUILDING.md](docs/BUILDING.md)

```
pipeline/            the Python pipeline
web/                 the Vite + MapLibre app; web/public/harmonised/ is the export it loads
worker/              the Cloudflare Worker for live data
reports/             numbers and figures the pipeline writes, kept in git
docs/                how it works, and how to build it
data/                all raw and intermediate data (not in git)
```

## Data

NASA FIRMS (MODIS Collection 6.1 and VIIRS 375 m Collection 2) for every fire detection; ESA
WorldCover for land cover; NBAC, NFDB and CWFIS (Natural Resources Canada) for burned area, fire
causes and agency-reported fires; WorldPop for population; GeoNames and Natural Earth for places and
boundaries; OpenFreeMap for the base map. Every source and tool, with links:
[docs/BUILDING.md](docs/BUILDING.md#data-and-tools).

## Limits

- Extreme northern fire years are underestimated (2014: about −19% for all of Canada when hidden).
- 2001 and 2002 are low against NBAC burned area; raw Terra shows the same gap.
- Small areas are uncertain; estimated years are labelled low confidence below 10,000 km² of Canada in the box.
- Detected fire is a floor, not a full count of fires.
- The latest months (August–November 2026) use provisional near-real-time data.
- Canada only in this version.

## Use of AI tools

Ember was built with the help of an AI coding assistant (Claude), under my direction, for writing
and debugging code, running data checks and drafting text. The method, the data choices, the design
and every final decision are mine. The logo and the mascot are my own drawings, converted to SVG
with AI help.

## Attribution and licences

The links and uses are in [docs/BUILDING.md](docs/BUILDING.md#data-and-tools); these are the attribution statements
each provider asks for.

- NASA FIRMS active fire data (MODIS Collection 6.1, VIIRS 375 m), NASA ESDIS.
- NBAC and Canadian National Fire Database, Canadian Forest Service, Natural Resources Canada (CWFIS), and the
  Terrestrial Ecozones of Canada, Agriculture and Agri-Food Canada: contain information licensed under the
  [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).
- © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by the ESA WorldCover consortium (CC BY 4.0).
- Natural Earth (public domain). Base map: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors.
- Population: WorldPop 2020 (CC BY 4.0), a modelled estimate. Place names: GeoNames (CC BY 4.0).
- Typefaces: IBM Plex Sans and IBM Plex Mono, © 2019 IBM Corp., licensed under the SIL Open Font
  License 1.1.

References are listed in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).
