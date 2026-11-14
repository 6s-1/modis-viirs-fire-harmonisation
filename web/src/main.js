import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { MONTHS, aggregate, fmt, fmtShort, h3Id, loadData, monthDays, rawRecorded, uncertaintyFactors } from "./data.js";
import { cellToBoundary } from "h3-js";
import { attachTooltip, renderCalendar } from "./calendar.js";
import { renderCompare } from "./compare.js";
import { calendarPNG, fileStem, hotspotIndex, hotspotPlan, hotspotsCSV, monthlyCSV, saveBlob } from "./downloads.js";
import { addGridLayers, attachGridHover, gridLegend, updateGrid } from "./grid.js";

const OBSERVED_FROM = 2012;
const PRESETS = {
  "all-canada": { south: 41.5, north: 83.5, west: -141.5, east: -52.0 },
  okanagan: { south: 49.0, north: 50.6, west: -120.1, east: -118.9 }, // Okanagan valley, Osoyoos to Vernon, around Kelowna
};
const STYLE = "https://tiles.openfreemap.org/styles/positron";
const OUTSIDE = "Harmonised history is available for Canada in this version.";

const $ = (id) => document.getElementById(id);

// The globe should fill its half with dark space around it: radius ~38% of the panel's smaller side.
const START = { lng: -96, lat: 58 };
function fitGlobe() {
  const el = map.getContainer();
  const target = 0.38 * Math.min(el.clientWidth, el.clientHeight);
  map.jumpTo({ center: [START.lng, START.lat], zoom: 1.5 });
  for (let k = 0; k < 3; k++) {
    // a point 89 degrees from the centre sits just inside the globe's edge
    const c = map.project([START.lng, START.lat]), e = map.project([START.lng, START.lat - 89]);
    const r = Math.hypot(e.x - c.x, e.y - c.y);
    if (!(r > 0)) break;
    map.jumpTo({ center: [START.lng, START.lat], zoom: map.getZoom() + Math.log2(target / r) });
  }
}

// Collapsible sections remember their state in this browser.
document.querySelectorAll("details[data-remember]").forEach((el) => {
  const key = `section:${el.id}`;
  try { const v = localStorage.getItem(key); if (v !== null) el.open = v === "1"; } catch { /* storage unavailable */ }
  el.addEventListener("toggle", () => { try { localStorage.setItem(key, el.open ? "1" : "0"); } catch { /* ignore */ } });
});
const state = { d: null, box: null, agg: null, gridAgg: null, cell: null, cal: null, range: null, observedOnly: false, mode: "harmonised", colour: "activity", mapReady: false };

// ---- map: globe, north up, no rotation or pitch, starts on Canada
const map = new maplibregl.Map({
  container: "map",
  style: STYLE,
  center: [-96, 58],
  zoom: 1.5,
  bearing: 0,
  pitch: 0,
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.on("style.load", () => { map.setProjection({ type: "globe" }); neutralBasemap(); fitGlobe(); });

// Mid-grey basemap so both ends of the inferno fire scale stand out (dark purple low end,
// pale yellow high end): land ~ rgb(160,163,168), water darker, no blue or green tints.
function neutralBasemap() {
  const paint = { background: ["background-color", "#a0a3a8"], water: ["fill-color", "#6f747c"], park: ["fill-color", "#9a9da2"],
    landcover_wood: ["fill-color", "#9a9da2"], landuse_residential: ["fill-color", "#9c9fa4"], landcover_ice_shelf: ["fill-color", "#b3b6ba"],
    landcover_glacier: ["fill-color", "#b3b6ba"], waterway: ["line-color", "#6f747c"], boundary_2: ["line-color", "#55595f"], boundary_3: ["line-color", "#6a6e74"] };
  for (const [id, [prop, val]] of Object.entries(paint)) if (map.getLayer(id)) map.setPaintProperty(id, prop, val);
  for (const l of map.getStyle().layers) {
    if (l.type === "symbol" && l.id.startsWith("water_name")) map.setPaintProperty(l.id, "text-color", "#2f3238");
  }
}

// lat/lon box as a polygon with points along each edge, so it follows parallels on the globe
function boxFeature(b) {
  const ring = [], n = 24;
  for (let k = 0; k <= n; k++) ring.push([b.west + ((b.east - b.west) * k) / n, b.south]);
  for (let k = 1; k <= n; k++) ring.push([b.east, b.south + ((b.north - b.south) * k) / n]);
  for (let k = 1; k <= n; k++) ring.push([b.east - ((b.east - b.west) * k) / n, b.north]);
  for (let k = 1; k <= n; k++) ring.push([b.west, b.north - ((b.north - b.south) * k) / n]);
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}
map.on("load", () => {
  map.addSource("selection", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-color": "#2bb3a3", "fill-opacity": 0.05 } });
  map.addLayer({ id: "selection-line", type: "line", source: "selection", paint: { "line-color": "#2bb3a3", "line-width": 2 } });
  addGridLayers(map);
  map.addSource("cell-sel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "cell-sel", type: "line", source: "cell-sel", paint: { "line-color": "#2bb3a3", "line-width": 3 } });
  attachGridHover(map, $("tip"), () => rangeLabel());
  map.on("click", "grid-fill", (e) => { if (!drawing && e.features && e.features.length) clickCell(+e.features[0].properties.i); });
  map.on("mouseenter", "grid-fill", () => { if (!drawing) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "grid-fill", () => { if (!drawing) map.getCanvas().style.cursor = ""; });
  state.mapReady = true;
  if (state.box) { drawBox(state.box); if (state.d) refreshGrid(); }
});
function drawBox(b) {
  const src = map.getSource("selection");
  if (src) src.setData({ type: "FeatureCollection", features: b ? [boxFeature(b)] : [] });
}

// ---- rectangle drawing (works on the globe; panning is paused while drawing)
let drawing = false, start = null;
$("draw").addEventListener("click", () => setDrawing(!drawing));
function setDrawing(on) {
  drawing = on;
  $("draw").setAttribute("aria-pressed", String(on));
  $("draw").textContent = on ? "Drag on the map…" : "Draw a box";
  map.getCanvas().style.cursor = on ? "crosshair" : "";
  if (on) map.dragPan.disable(); else map.dragPan.enable();
}
const boxFrom = (a, b) => ({ south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat), west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng) });
map.on("mousedown", (e) => { if (drawing) { start = e.lngLat; e.preventDefault(); } });
map.on("mousemove", (e) => { if (drawing && start) drawBox(boxFrom(start, e.lngLat)); });
map.on("mouseup", (e) => {
  if (!drawing || !start) return;
  const b = boxFrom(start, e.lngLat);
  start = null;
  setDrawing(false);
  if (b.north - b.south < 0.05 || b.east - b.west < 0.05) { drawBox(state.box); return; }
  select(b, true);
});

// ---- bounds inputs and presets
const fields = ["south", "north", "west", "east"];
$("bounds").addEventListener("submit", (e) => {
  e.preventDefault();
  const b = Object.fromEntries(fields.map((f) => [f, parseFloat($(f).value)]));
  const err = !fields.every((f) => Number.isFinite(b[f])) ? "Enter all four bounds."
    : b.south < -90 || b.north > 90 || b.south >= b.north ? "South must be below north, within −90 to 90."
    : b.west < -180 || b.east > 180 || b.west >= b.east ? "West must be less than east, within −180 to 180." : "";
  $("bounds-error").textContent = err;
  if (!err) select(b, true);
});
for (const [id, b] of Object.entries(PRESETS)) $(id).addEventListener("click", () => select(b, true));
// Clicking a grid cell makes that cell the selection; clicking it again (or any preset, typed
// bounds or drawn box) returns to the previous box. The grid keeps showing the box's cells.
function clickCell(i) {
  if (state.cell && state.cell.i === i) { const prev = state.cell.prev; select(prev, false); return; }
  const prev = state.cell ? state.cell.prev : state.box;
  const ring = cellToBoundary(h3Id(state.d, i), true);
  const lats = ring.map((p) => p[1]), lons = ring.map((p) => p[0]);
  state.cell = { i, prev, ring };
  state.box = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) };
  fields.forEach((f) => { $(f).value = Math.round(state.box[f] * 100) / 100; });
  const src = map.getSource("cell-sel");
  if (src) src.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] });
  update();
}

function select(b, fly) {
  state.cell = null;
  const cs = map.getSource("cell-sel");
  if (cs) cs.setData({ type: "FeatureCollection", features: [] });
  state.box = b;
  fields.forEach((f) => { $(f).value = Math.round(b[f] * 100) / 100; });
  drawBox(b);
  if (state.d) update();
  if (fly) fitToData();
}

// Fit the camera so the cells with data (or the box, if none) fill ~90% of the map's shorter side,
// centred. Same rule for presets, typed bounds and drawn boxes.
function fitToData() {
  const e = state.agg && state.agg.extent;
  const half = 0.12; // display cells are ~0.25 degrees across; pad centres by half a cell
  const b = e ? { south: e.south - half, north: e.north + half, west: e.west - half * 2, east: e.east + half * 2 } : state.box;
  const el = map.getContainer(), W = el.clientWidth, H = el.clientHeight;
  const side = 0.9 * Math.min(W, H);
  const px = Math.max((W - side) / 2, 0), py = Math.max((H - side) / 2, 0);
  map.fitBounds([[b.west, b.south], [b.east, b.north]], {
    padding: { top: py, bottom: py, left: px, right: px }, duration: 800, maxZoom: 9,
  });
}

// ---- date range, observed-only toggle, harmonised / raw view
const monthValue = (info) => `${info.y}-${String(info.m).padStart(2, "0")}`;
const rangeLabel = () => {
  const d = state.d, [a, b] = state.range;
  return `${MONTHS[d.months[a].m - 1]} ${d.months[a].y} – ${MONTHS[d.months[b].m - 1]} ${d.months[b].y}`;
};
function readRange() {
  const d = state.d, idx = (v) => d.monthIndex.get(+v.slice(0, 4) * 100 + +v.slice(5, 7));
  const a = idx($("from").value), b = idx($("to").value);
  const msg = a === undefined || b === undefined ? `Choose months between ${monthValue(d.months[0])} and ${monthValue(d.lastMonth)}.`
    : a > b ? "The start month must be before the end month." : "";
  $("range-error").textContent = msg;
  if (msg) return false;
  state.range = [a, b];
  return true;
}
["from", "to"].forEach((id) => $(id).addEventListener("change", () => { if (readRange()) update(); }));
document.querySelectorAll('input[name="years"]').forEach((r) => r.addEventListener("change", (e) => { state.observedOnly = e.target.value === "measured"; update(); }));
document.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener("change", (e) => { state.mode = e.target.value; update(); }));
document.querySelectorAll('input[name="colour"]').forEach((r) => r.addEventListener("change", (e) => { state.colour = e.target.value; update(); }));

function refreshGrid() {
  if (!state.mapReady || !state.gridAgg) return;
  const g = updateGrid(map, state.d, state.gridAgg, state.range);
  if (g.n) gridLegend($("grid-legend"), g.scale, rangeLabel());
  else $("grid-legend").innerHTML = "";
}

function update() {
  const d = state.d;
  const agg = (state.agg = aggregate(d, state.box, state.cell ? state.cell.i : null));
  state.gridAgg = state.cell ? aggregate(d, state.cell.prev) : agg;
  const firstYear = state.observedOnly ? OBSERVED_FROM : d.firstYear;
  const years = [];
  for (let y = d.lastYear; y >= firstYear; y--) years.push(y);
  const yearFilter = (y) => !state.observedOnly || y >= OBSERVED_FROM;
  const medianYears = years.filter((y) => y < d.lastYear);
  const minArea = d.manifest.uncertainty.low_confidence_below_km2;
  const lowConfidence = agg.canadaKm2 < minArea;
  const inCanada = agg.canadaKm2 > 0 || agg.cells.length > 0;

  const [a, b] = state.range;
  let total = 0;
  for (let i = a; i <= b; i++) total += agg.totals[i];
  const partlyOutside = agg.boxKm2 > agg.canadaKm2 * 1.1;
  // range of the total: estimated months carry the yearly likely range for this area
  let lo = 0, hi = 0;
  for (let i = a; i <= b; i++) {
    const q = uncertaintyFactors(d, agg.canadaKm2, "year", d.months[i].source);
    lo += agg.totals[i] * (q ? q[0] : 1); hi += agg.totals[i] * (q ? q[2] : 1);
  }
  const areaTip = `Canada inside the box (land and lakes): the area searched, not the area burned.${partlyOutside ? ` Part of the box is outside Canada. ${OUTSIDE}` : ""}`;
  const lowTip = `Less than ${fmt(minArea)} km² of Canada in the box: estimated years are low confidence.`;
  const areaTxt = agg.canadaKm2 >= 1e6 ? `${(agg.canadaKm2 / 1e6).toFixed(2)}M` : fmt(agg.canadaKm2);
  const dets = [["terra", "Terra"], ["aqua", "Aqua"], ["snpp", "S-NPP"], ["noaa20", "NOAA-20"]].map(([p, name]) => {
    const v = agg.detOf(p);
    let t = 0;
    for (let i = a; i <= b; i++) t += v[i];
    return [name, t];
  }).filter(([, t]) => t > 0);
  const detLine = dets.length ? `<div class="sub" title="Raw hotspot detections per satellite (vegetation fire, low-confidence class removed), not converted. Counted by grid cell like the cell-days (cells whose centre is in the box, local-date months), so they can differ slightly from the hotspot CSV, which uses each detection's exact position.">
      <strong>hotspots</strong> ${dets.map(([n, t]) => `${n} ${t < 1000 ? Math.round(t).toLocaleString("en-CA") : fmtShort(t)}`).join(" · ")}</div>
    <div class="sub dim">Hotspots count every flagged pixel on every overpass; cell-days count each ~1 km cell once a day.</div>` : "";
  const ci = state.cell ? state.cell.i : null;
  const cellLine = ci === null ? "" : `<p class="cell-name"><strong>Grid cell</strong> ${h3Id(d, ci)} ·
    ${d.manifest.regions[d.region[ci]] || "outside the ecozones"}${d.manifest.provinces[d.province[ci]] ? `, ${d.manifest.provinces[d.province[ci]]}` : ""} ·
    ${fmt(d.area[ci])} km² <button type="button" class="linkish" id="cell-back">back to the box</button></p>`;
  $("summary").innerHTML = cellLine + (!inCanada ? `<p class="notice">${OUTSIDE}</p>` : agg.cells.length ? `
    <div class="big" title="Harmonised fire cell-days (VIIRS-equivalent), ${rangeLabel()}">${fmt(total)}${hi - lo > 0.005 * total ? ` <span class="rng">(${fmtShort(lo)}–${fmtShort(hi)})</span>` : ""}
      <span class="unit">fire cell-days</span></div>
    <div class="sub">${rangeLabel()} · ${agg.cells.length.toLocaleString("en-CA")} ${agg.cells.length === 1 ? "cell" : "cells"} with fire ·
      <span class="info" title="${areaTip}">${areaTxt} km² searched</span>${lowConfidence ? ` <span class="badge low" title="${lowTip}">low conf.</span>` : ""}</div>${detLine}`
    : `<div class="big">0 <span class="unit">fire cell-days</span></div>
    <div class="sub"><span class="info" title="${areaTip}">${areaTxt} km² searched</span> · no fire detected</div>`);
  if (ci !== null) $("cell-back").addEventListener("click", () => clickCell(ci));
  for (const id of ["sec-calendar", "sec-compare", "sec-downloads"]) $(id).hidden = !inCanada;
  if (!inCanada) { refreshGrid(); return; }

  const raw = state.mode === "raw";
  $("view-note").textContent = raw
    ? "Raw: each satellite's own fire cell-days, not converted. MODIS before 2012, VIIRS after, so the record steps up in 2012."
    : "Harmonised: the whole record in VIIRS-equivalent fire cell-days. Before 2012 it is estimated from MODIS.";
  state.cal = renderCalendar($("calendar"), d, agg, {
    years, medianYears, range: state.range, lowConfidence, legendEl: $("legend"),
    mode: state.mode, values: raw ? rawRecorded(d, agg) : agg.totals, colour: state.colour,
  });
  renderCompare($("compare"), d, agg, { yearFilter, totals: state.cal.totals, mode: state.mode, years, medianYears });
  $("dl-status").textContent = "";
  refreshGrid();
}

// ---- downloads
$("dl-monthly").addEventListener("click", () => {
  saveBlob(monthlyCSV(state.d, state.agg, state.range), `fire-cell-days_${fileStem(state.box, state.d, state.range)}.csv`);
});
$("dl-png").addEventListener("click", async () => {
  const d = state.d, b = state.box;
  const cal = state.mode === "raw" ? renderCalendar(document.createElement("div"), d, state.agg, {
    years: state.cal.totals.map((t) => t.y), medianYears: [], range: state.range, lowConfidence: false,
    legendEl: document.createElement("div") }) : state.cal; // the PNG is always the harmonised calendar
  const blob = await calendarPNG(d, state.agg, cal, {
    years: cal.totals.map((t) => t.y), lowConfidence: state.agg.canadaKm2 < d.manifest.uncertainty.low_confidence_below_km2,
    title: "Burning activity calendar (harmonised)",
    subtitle: `Box S ${b.south.toFixed(2)}, N ${b.north.toFixed(2)}, W ${b.west.toFixed(2)}, E ${b.east.toFixed(2)} · Canada inside the box ${fmt(state.agg.canadaKm2)} km² (area searched, not burned)`,
  });
  saveBlob(blob, `fire-calendar_${fileStem(b, d, [0, d.months.length - 1])}.png`);
});
$("dl-hotspots").addEventListener("click", async () => {
  const st = $("dl-status"), btn = $("dl-hotspots");
  try {
    btn.disabled = true;
    const plan = await hotspotPlan(state.box, state.d, state.range);
    if (!plan.tiles.length) { st.textContent = "No hotspots in this box and date range."; return; }
    if (plan.tooBig) { st.textContent = `This would read up to ${fmt(plan.rows)} hotspots. Narrow the box or the date range (limit 1.5 million).`; return; }
    st.textContent = `Reading ${plan.tiles.length} tiles (${(plan.bytes / 1e6).toFixed(1)} MB)…`;
    const { blob, rows } = await hotspotsCSV(state.box, state.d, state.range, plan,
      (done, n, kept) => { st.textContent = `Reading tiles ${done}/${n} · ${fmt(kept)} hotspots so far…`; });
    saveBlob(blob, `hotspots_${fileStem(state.box, state.d, state.range)}.csv`);
    st.textContent = `Saved ${fmt(rows)} hotspots.`;
  } catch (err) {
    st.textContent = `Hotspot download failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---- start
attachTooltip($("calendar"), $("tip"), () => ({ d: state.d, agg: state.agg, mode: state.mode, colour: state.colour, cal: state.cal }));
loadData("harmonised/")
  .then((d) => {
    state.d = d;
    const first = monthValue(d.months[0]), last = monthValue(d.lastMonth);
    for (const id of ["from", "to"]) { $(id).min = first; $(id).max = last; }
    $("from").value = first; $("to").value = last;
    state.range = [0, d.months.length - 1];
    $("data-end").textContent = `Data to ${monthDays(d.lastMonth)} ${MONTHS[d.lastMonth.m - 1]} ${d.lastMonth.y}.`;
    hotspotIndex().catch(() => {
      $("dl-hotspots").hidden = true;
      $("dl-status").textContent = "Hotspot download is not available on this copy of the site.";
    });
    select(state.box || PRESETS["all-canada"], false);
  })
  .catch((err) => { $("summary").textContent = `Could not load the harmonised data (${err.message}).`; });
