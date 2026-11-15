// About page. All numbers come from about.json, written by pipeline/about_data.py.
import "./fonts.js";
import "./style.css";
import { initTextSize } from "./textsize.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pct = (v, sign = false) => `${sign && v > 0 ? "+" : ""}${Number(v).toFixed(1)}%`;
const n = (v) => Number(v).toLocaleString("en-CA");
const rng = (r) => `${r[0].toFixed(2)}–${r[1].toFixed(2)}`;

function compTable(rows) {
  const head = `<tr><th scope="col">Model</th><th scope="col">Canada</th><th scope="col">Province</th>
    <th scope="col">~12,400 km²</th><th scope="col">Grid cell (~250 km²)</th><th scope="col">2014</th>
    <th scope="col">Canada range</th></tr>`;
  const body = rows.map((r) => `<tr><th scope="row">${r.label}</th><td>${pct(r.loyo.canada)}</td><td>${pct(r.loyo.prov)}</td>
    <td>${pct(r.loyo["12k"])}</td><td>${pct(r.loyo.cell)}</td><td>${pct(r.loyo_2014, true)}</td><td>${rng(r.loyo_canada_range)}</td></tr>`).join("");
  return `<div class="tablewrap"><table class="data"><caption>Typical error of yearly totals when each year from 2012 to 2025 is hidden in turn
    (weighted absolute error). Lower is better. "2014" is the error for that year; "Canada range" is observed ÷ estimated
    across all hidden years.</caption><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function backTable(rows) {
  const body = rows.map((r) => `<tr><th scope="row">${r.label}</th><td>${pct(r.back.canada)}</td><td>${pct(r.back.prov)}</td>
    <td>${pct(r.back["12k"])}</td><td>${pct(r.back.cell)}</td><td>${pct(r.back_2014, true)}</td></tr>`).join("");
  return `<div class="tablewrap"><table class="data"><caption>Backwards test: built on 2019–2025 only, then asked to estimate
    2012–2014 from MODIS. Weighted absolute error of yearly totals.</caption>
    <thead><tr><th scope="col">Model</th><th scope="col">Canada</th><th scope="col">Province</th><th scope="col">~12,400 km²</th>
    <th scope="col">Grid cell</th><th scope="col">2014</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function hiddenTable(rows) {
  const body = rows.map((r) => `<tr><th scope="row">${r.year}</th><td>${pct(r.old, true)}</td><td>${pct(r.new, true)}</td></tr>`).join("");
  const mean = (k) => rows.reduce((s, r) => s + Math.abs(r[k]), 0) / rows.length;
  return `<div class="tablewrap"><table class="data narrow"><caption>Each year hidden in turn: estimated minus observed
    Canada total, as a share of observed.</caption>
    <thead><tr><th scope="col">Hidden year</th><th scope="col">Previous table</th><th scope="col">Adopted model</th></tr></thead>
    <tbody>${body}</tbody><tfoot><tr><th scope="row">Mean size of error</th><td>${pct(mean("old"))}</td><td>${pct(mean("new"))}</td></tr></tfoot></table></div>`;
}

function nbacTable(a) {
  const rows = [["raw MODIS Aqua", "Raw MODIS Aqua (same satellite before and after 2012)"], ["old table", "Previous table"],
    ["adopted model", "Adopted model"]];
  const body = rows.map(([k, lab]) => `<tr><th scope="row">${lab}</th><td>${pct(a.nbac[k].est_bias_pct, true)}</td><td>${a.nbac[k].est_mlr.toFixed(2)}</td></tr>`).join("");
  return `<div class="tablewrap"><table class="data narrow"><caption>Estimated years 2003–2011 against NBAC burned area, using one
    hectares-per-cell-day ratio per ecozone fitted on 2012–2025. Bias near zero and similar scatter to raw Aqua mean no step at 2012.</caption>
    <thead><tr><th scope="col">Series</th><th scope="col">Bias</th><th scope="col">Typical scatter (median |log ratio|)</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function render(a) {
  const adoptedModis = a.comparison[1], adoptedTerra = a.comparison[3], prev = a.comparison[0];
  const end = a.data_end;
  const endDays = Math.max(...Object.values(end.days));
  const ea = a.nbac_canada_annual_error_pct;
  const minKm2 = n(a.low_confidence_below_km2);
  return `
  <section>
    <h2>What the calendar shows</h2>
    <p>Each square is a <strong>fire cell-day count</strong>: how many ~1 km grid cells had at least one satellite fire
    detection on a given day, added up over the month. It measures how widespread detected burning was, not area burned.</p>
    <p>Two satellite instruments see fire very differently. MODIS (on Terra and Aqua, from 2000) has 1 km pixels; VIIRS
    (on S-NPP from 2012 and NOAA-20 from 2018) has 375 m pixels and finds about ${a.viirs_over_modis_2012_2025} times as many
    fire cell-days in the same fires. Laid end to end, the raw record would jump in 2012. The app converts the whole
    record to <strong>VIIRS-equivalent fire cell-days</strong>, so years can be compared. Use the "Raw sensors" view to see
    the unconverted counts.</p>
    <p>Colours run from <strong>light orange (least fire) through orange and red to dark red (most)</strong>. The
    classes are set from the values in the current selection and date range, so the same colour can mean different
    counts in different areas; the legend gives the numbers. "Compared with normal" uses a separate scale: purple for
    below the usual level for that month, grey for about normal, brown to orange for above.</p>
  </section>

  <section>
    <h2>How it is built</h2>
    <ol>
      <li><strong>Clean the detections.</strong> From NASA FIRMS we keep detections flagged as presumed vegetation fire and drop
        the low-confidence class (${n(a.detections_kept)} of ${n(a.detections_read)} detections kept). Day and night, and each
        satellite, are kept apart.</li>
      <li><strong>Count fire cell-days.</strong> Detections are placed on a shared ~1 km hexagon grid (H3). A cell counts once per
        satellite per local day. Monthly totals are shown on a ~250 km² hexagon grid, which keeps cells close to equal in area
        from the south of Canada to the Arctic.</li>
      <li><strong>Build the VIIRS reference.</strong> From 2012 the record is VIIRS: the mean of S-NPP and NOAA-20 where both
        were working, otherwise whichever was. The two agree closely (NOAA-20 ÷ S-NPP was
        ${Math.min(...a.viirs_agreement.noaa20_over_snpp).toFixed(2)}–${Math.max(...a.viirs_agreement.noaa20_over_snpp).toFixed(2)}
        each year). Days when one satellite was out of service are left out of its average
        (S-NPP ${a.outage_days.snpp} days, NOAA-20 ${a.outage_days.noaa20}).</li>
      <li><strong>Learn the conversion.</strong> On 2012–2025, where MODIS and VIIRS overlap, we work out how many VIIRS
        cell-days each MODIS cell-day corresponds to. The ratio is kept separately for each fire region (the 15 ecozones of
        Canada), land cover (forest, grass and shrub, cropland, other; ESA WorldCover), season, and fire intensity (low, middle or
        high mean fire radiative power, split into thirds). Groups with too little data borrow the ratio of a
        broader group.</li>
      <li><strong>Estimate the years before VIIRS.</strong> From August 2002 the MODIS input is any cell-day seen by Aqua or Terra.
        Before that only Terra was flying, so November 2000 to July 2002 uses a Terra-only version of the same table. These
        months are marked "estimated" and carry a likely range. The record starts in November 2000, the first month of Terra
        fire data.</li>
    </ol>
  </section>

  <section>
    <h2>How well it works: hidden years</h2>
    <p>To test the estimates honestly we hide years the model has not seen and compare its estimate with what VIIRS actually
    recorded. Below, the previous method (a VIIRS/Aqua table without fire intensity) and the adopted one are tested the same way.</p>
    ${compTable(a.comparison)}
    ${backTable(a.comparison)}
    ${hiddenTable(a.hidden_years)}
    <p>The adopted model cuts the typical province-level error from ${pct(prev.loyo.prov)} to ${pct(adoptedModis.loyo.prov)} and the
    grid-cell error from ${pct(prev.loyo.cell)} to ${pct(adoptedModis.loyo.cell)}. Using Terra as well as Aqua also means more
    activity has a location: the share of VIIRS cell-days in places and months where MODIS saw nothing falls from
    ${pct(prev.zero_input_pct)} to ${pct(adoptedModis.zero_input_pct)}. Other ideas were tested and left out because they did
    not beat this on the same tests: ${a.rejected.map((r) => r.label).join("; ")}.</p>
    <p>The likely ranges in the app come from these hidden-year errors and get narrower as the area grows. For all of Canada,
    yearly estimates fall within ${rng(a.adopted.estimated_from_modis.loyo_canada_range)} times the observed value
    across all hidden years.</p>
    <figure><img src="about/canada_annual_series.png" alt="Line chart of fire cell-days per year in Canada, 2000 to 2025: raw MODIS Aqua stays low, raw VIIRS from 2012 is about four times higher, and the harmonised series continues the VIIRS level back to 2000 with a shaded range before 2012." />
      <figcaption>Raw MODIS Aqua, raw VIIRS and the harmonised series for all of Canada.</figcaption></figure>
  </section>

  <section>
    <h2>An independent check against burned area</h2>
    <p>The National Burned Area Composite (NBAC) maps the area burned by fires in Canada each year. It is not used to build the
    record. For each ecozone we fit one hectares-per-cell-day ratio on 2012–2025 and apply it unchanged to earlier years. If
    the conversion introduced a step at 2012, the earlier years would drift away from NBAC.</p>
    ${nbacTable(a)}
    <figure><img src="about/nbac_check.png" alt="Three scatter plots of burned area implied by cell-days against NBAC burned area per ecozone and year, for raw MODIS Aqua, the previous table and the adopted model. Points from 2003 to 2011 lie along the same line as 2012 to 2025 in all three." />
      <figcaption>Each point is one ecozone in one year. Grey: years used to fit the ratio. Blue: estimated years.</figcaption></figure>
    <p>For 2003–2011 the harmonised record matches NBAC about as well as raw Aqua does, which is the same satellite before and
    after 2012. So the conversion does not introduce a step. Small fire years in an ecozone are noisy in every series.</p>
  </section>

  <section>
    <h2>Limits</h2>
    <ul>
      <li><strong>Extreme northern fire years are underestimated.</strong> In 2014, when large fires burned in the Northwest
        Territories, the estimate for all of Canada was ${pct(adoptedModis.loyo_2014, true)} when that year was hidden. Very large,
        long-burning northern fires produce more VIIRS detections per MODIS detection than the model expects.</li>
      <li><strong>2001 and 2002 are low against burned area.</strong> Against NBAC, the estimate is ${pct(ea["adopted model"]["2001"], true)}
        in 2001 and ${pct(ea["adopted model"]["2002"], true)} in 2002. Raw Terra shows the same gap (${pct(ea["raw MODIS Terra (diagnostic)"]["2001"], true)}
        and ${pct(ea["raw MODIS Terra (diagnostic)"]["2002"], true)}), so it is not caused by the conversion, but those years should be read with care.</li>
      <li><strong>Small areas are uncertain.</strong> For a single grid cell a yearly estimate is typically off by about
        ${pct(adoptedModis.loyo.cell)}; for a province about ${pct(adoptedModis.loyo.prov)}. With less than ${minKm2} km² of Canada
        in the box, estimated years are labelled low confidence.</li>
      <li><strong>Detected fire is a floor, not a full count.</strong> Satellites miss fires that are small, short, under cloud or
        smoke, or between overpasses. ${pct(a.zero_cases.share_of_viirs_pct)} of VIIRS activity is in grid cells and months where
        MODIS saw nothing; the estimates include it in totals but cannot place it on the map for years before 2012.</li>
      <li><strong>August to November 2026 is near real time.</strong> Those months use provisional FIRMS data, which can change.
        Near-real-time files do not say which detections are industrial or over water, so a small share (about 3% of VIIRS
        detections) may not be vegetation fire. Data end on ${endDays} ${MONTHS[end.m - 1]} ${end.y}; S-NPP data end on 2 November 2026.</li>
      <li><strong>Canada only.</strong> This version covers Canada. The ratio tables are specific to Canadian ecozones.</li>
      <li><strong>Land cover is one snapshot.</strong> ESA WorldCover 2021 is used for all years, so places that burned before 2021
        may be classed as shrub or grass rather than forest.</li>
    </ul>
  </section>

  <section>
    <h2>Evacuation and emergency information</h2>
    <p>This app shows fire history and recent detections. It is not an emergency service. For evacuation orders, alerts and
    routes, follow your provincial or territorial emergency service:</p>
    <ul class="links">
      <li>British Columbia: <a href="https://www.emergencyinfobc.gov.bc.ca/">EmergencyInfoBC</a></li>
      <li>Alberta: <a href="https://www.alberta.ca/alberta-emergency-alert">Alberta Emergency Alert</a></li>
      <li>Saskatchewan: <a href="https://www.saskpublicsafety.ca/">Saskatchewan Public Safety Agency</a></li>
      <li>Manitoba: <a href="https://www.gov.mb.ca/emo/">Manitoba Emergency Management</a></li>
      <li>Ontario: <a href="https://www.ontario.ca/page/forest-fires">Ontario forest fires</a></li>
      <li>Québec: <a href="https://www.quebec.ca/securite-situations-urgence">Sécurité et situations d'urgence</a> and <a href="https://www.sopfeu.qc.ca/en/">SOPFEU</a></li>
      <li>New Brunswick: <a href="https://www.gnb.ca/en/topic/laws-safety/emergency-preparedness-alerts.html">Emergency preparedness and alerts</a></li>
      <li>Nova Scotia: <a href="https://novascotia.ca/alerts/">Nova Scotia alerts</a></li>
      <li>Prince Edward Island: <a href="https://www.princeedwardisland.ca/en/topic/emergency-management">Emergency management</a></li>
      <li>Newfoundland and Labrador: <a href="https://www.gov.nl.ca/ffa/wildfires/">Wildfires</a></li>
      <li>Yukon: <a href="https://yukon.ca/">Government of Yukon</a></li>
      <li>Northwest Territories: <a href="https://www.maca.gov.nt.ca/en/services/emergency-management">Emergency management</a></li>
      <li>Nunavut: <a href="https://www.gov.nu.ca/">Government of Nunavut</a></li>
      <li>Across Canada: <a href="https://www.alertready.ca/">Alert Ready</a></li>
    </ul>
  </section>

  <section>
    <h2>Live fire and people exposed</h2>
    <ul>
      <li><strong>Live fire</strong> shows near-real-time VIIRS hotspots from NOAA-20 and NOAA-21 (NASA FIRMS) for the last 24 hours,
        48 hours or 7 days. These are single satellite detections: not harmonised, not checked, and not the same unit as the calendar.
        Points outside Canada are removed using the same boundary as the harmonised data (Natural Earth 1:50 m). Switch
        between Historical and Live at the top of the panel.</li>
      <li><strong>People</strong> are WorldPop 2020 estimates (1 km, UN-adjusted): a model of where people live, not a census count,
        and six years old.</li>
      <li><strong>Areas with fire, ranked by people exposed</strong> lists ~250 km² grid cells with recent fire and the people living in
        them. It describes exposure only. It is not a ranking of need or priority; response priorities are set by emergency
        management agencies. Hotspots in towns can be industrial heat or other sources that are not wildfire.</li>
    </ul>
  </section>

  <section>
    <h2>Data freshness</h2>
    <p>Historical data to ${endDays} ${MONTHS[end.m - 1]} ${end.y}; live data from NASA FIRMS, near real time.</p>

    <h2>Data credits</h2>
    <ul>
      <li><strong>Active fire detections:</strong> NASA Fire Information for Resource Management System (FIRMS), part of NASA's Earth
        Science Data and Information System (ESDIS). MODIS Collection 6.1 (Terra, Aqua) and VIIRS 375 m Collection 2 (S-NPP, NOAA-20),
        yearly country summaries and archive downloads.</li>
      <li><strong>Burned area and fire points:</strong> National Burned Area Composite (NBAC) and Canadian National Fire Database
        (NFDB), Canadian Forest Service, Natural Resources Canada, via the Canadian Wildland Fire Information System (CWFIS).
        Contains information licensed under the <a href="https://open.canada.ca/en/open-government-licence-canada">Open Government
        Licence – Canada</a>. Used as an independent check on the harmonised record, and shown in the
        <em>Why it burned</em> card for the cause of recorded fires, their names and sizes, and the area burned.
        Neither feeds the harmonisation model.</li>
      <li><strong>Fire regions:</strong> Terrestrial Ecozones of Canada, Agriculture and Agri-Food Canada. Contains information
        licensed under the Open Government Licence – Canada.</li>
      <li><strong>Land cover:</strong> © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by
        the ESA WorldCover consortium, licensed under CC BY 4.0.</li>
      <li><strong>Boundaries:</strong> Natural Earth (public domain).</li>
      <li><strong>Population:</strong> WorldPop (www.worldpop.org), 2020 1 km UN-adjusted population for Canada, licensed under CC BY 4.0.</li>
      <li><strong>Place names:</strong> GeoNames (cities500), licensed under CC BY 4.0.</li>
      <li><strong>Live fire:</strong> NASA FIRMS near-real-time VIIRS (NOAA-20, NOAA-21), served through a Cloudflare Worker that keeps
        the FIRMS key private.</li>
      <li><strong>Base map:</strong> OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors.</li>
      <li><strong>Software:</strong> H3 hexagonal grid (Uber), MapLibre GL JS.</li>
    </ul>
  </section>

  <section>
    <h2>References</h2>
    <ul class="refs">
      <li>Giglio, L., Schroeder, W., &amp; Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire
        products. <em>Remote Sensing of Environment</em>, 178, 31–41.</li>
      <li>Schroeder, W., Oliva, P., Giglio, L., &amp; Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product:
        Algorithm description and initial assessment. <em>Remote Sensing of Environment</em>, 143, 85–96.</li>
      <li>Hall, R. J., Skakun, R. S., Metsaranta, J. M., Landry, R., Fraser, R. H., Raymond, D., Gartrell, M., Decker, V., &amp;
        Little, J. (2020). Generating annual estimates of forest fire disturbance in Canada: the National Burned Area Composite.
        <em>International Journal of Wildland Fire</em>, 29(10), 878–891.</li>
      <li>Zanaga, D., et al. (2022). <em>ESA WorldCover 10 m 2021 v200</em>. Zenodo. https://doi.org/10.5281/zenodo.7254221</li>
      <li>Ecological Stratification Working Group (1995). <em>A National Ecological Framework for Canada</em>. Agriculture and
        Agri-Food Canada and Environment Canada.</li>
      <li>Canadian Forest Service (2026). <em>Canadian National Fire Database – Agency Fire Data</em> and <em>National Burned Area
        Composite</em>. Natural Resources Canada, https://cwfis.cfs.nrcan.gc.ca/</li>
    </ul>
    <p class="muted small">Figures last generated ${a.generated}. Source code and the full pipeline:
      <a href="https://github.com/6s-1/modis-viirs-fire-harmonisation">github.com/6s-1/modis-viirs-fire-harmonisation</a>.</p>
  </section>`;
}

fetch("about/about.json")
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((a) => { document.getElementById("about").innerHTML = render(a); })
  .catch((e) => { console.error(e); document.getElementById("about").innerHTML = `<p>Could not load the figures (${e.message}).</p>`; });

initTextSize();
