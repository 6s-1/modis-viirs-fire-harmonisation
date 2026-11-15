import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { MONTHS, aggregate, fmt, fmtShort, h3Id, loadData, monthDays, population, rawRecorded, uncertaintyFactors } from "./data.js";
import { renderExposureList, loadPlaces } from "./exposure.js";
import { cellToBoundary } from "h3-js";
import { attachTooltip, renderCalendar } from "./calendar.js";
import { renderCompare } from "./compare.js";
import { calendarPNG, fileStem, hotspotIndex, hotspotPlan, hotspotsCSV, monthlyCSV, saveBlob } from "./downloads.js";
import { addGridLayers, attachGridHover, gridLegend, updateGrid } from "./grid.js";
import { addLiveLayer, attachLiveHover, fetchLive, liveAvailable } from "./live.js";
import { liveWindow, renderLiveChart } from "./livechart.js";

const OBSERVED_FROM = 2012;
// With no box drawn, the selection is all of Canada.
const CANADA = { south: 41.5, north: 83.5, west: -141.5, east: -52.0 };
const PRESETS = {
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
const state = { app: "historical", d: null, box: null, agg: null, cal: null, range: null, observedOnly: false, mode: "harmonised", colour: "activity", mapReady: false };

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
if (import.meta.env.DEV) window.__ember = { map, get state() { return state; } }; // test hook, dev builds only
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
  attachGridHover(map, $("tip"), () => rangeLabel());
  addContextLayers();
  map.addSource("exp", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "exp-fill", type: "fill", source: "exp", paint: { "fill-color": "#ffffff", "fill-opacity": 0.01 } });
  map.addLayer({ id: "exp-line", type: "line", source: "exp", paint: { "line-color": "#ffffff", "line-width": 1.6 } });
  map.addLayer({ id: "exp-hi", type: "line", source: "exp", filter: ["==", ["get", "rank"], -1], paint: { "line-color": "#2bb3a3", "line-width": 3.5 } });
  map.on("mousemove", "exp-fill", (e) => { const f = e.features && e.features[0]; if (f) highlightExposure(+f.properties.rank); });
  map.on("mouseleave", "exp-fill", () => highlightExposure(null));
  addLiveLayer(map);
  attachLiveHover(map, $("tip"));
  state.mapReady = true;
  renderExposure(); // places may have loaded before the map
  if (state.box) drawBox(state.box);
  if (state.d) refreshGrid();
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
// ---- context layer: major roads and populated places (OpenStreetMap via the basemap's vector tiles),
// shown only inside the selection. For orientation; not evacuation routes.
function selectionPolygon() {
  return boxFeature(selBox()).geometry;
}
const ROAD_CLASSES = ["motorway", "trunk", "primary"];
function addContextLayers() {
  const vis = $("ctx").checked ? "visible" : "none";
  map.addSource("ctx-roads", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "ctx-roads-case", type: "line", source: "ctx-roads", layout: { visibility: vis, "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#0b0d12", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.8, 10, 4.5] } });
  map.addLayer({ id: "ctx-roads", type: "line", source: "ctx-roads", layout: { visibility: vis, "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#e8eaee", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.7, 10, 2.2] } });
  map.addLayer({ id: "ctx-places", type: "symbol", source: "openmaptiles", "source-layer": "place",
    filter: ["match", ["get", "class"], ["city", "town", "village"], true, false],
    layout: { visibility: vis, "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": ["Noto Sans Regular"],
      "text-size": ["match", ["get", "class"], "city", 13, "town", 12, 11], "text-anchor": "top", "text-offset": [0, 0.4] },
    paint: { "text-color": "#ffffff", "text-halo-color": "#0b0d12", "text-halo-width": 1.6 } });
  map.on("idle", () => { if ($("ctx").checked) clipRoads(); });
  updateContext();
}

// Clip a polyline to a lat/lon rectangle (Liang-Barsky per segment); returns the inside pieces.
function clipLine(coords, b) {
  const out = [];
  let cur = [];
  for (let k = 0; k < coords.length - 1; k++) {
    let [x0, y0] = coords[k], [x1, y1] = coords[k + 1];
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const edges = [[-dx, x0 - b.west], [dx, b.east - x0], [-dy, y0 - b.south], [dy, b.north - y0]];
    let keep = true;
    for (const [pp, q] of edges) {
      if (pp === 0) { if (q < 0) { keep = false; break; } continue; }
      const t = q / pp;
      if (pp < 0) { if (t > t1) { keep = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { keep = false; break; } if (t < t1) t1 = t; }
    }
    if (!keep) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const a = [x0 + t0 * dx, y0 + t0 * dy], c = [x0 + t1 * dx, y0 + t1 * dy];
    if (!cur.length) cur.push(a);
    cur.push(c);
    if (t1 < 1) { out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

// Major roads from the loaded basemap tiles, clipped to the selection (the cell's bounding box
// when a single cell is selected).
function clipRoads() {
  const src = map.getSource("ctx-roads");
  if (!src) return;
  const b = selBox();
  const feats = map.querySourceFeatures("openmaptiles", { sourceLayer: "transportation",
    filter: ["match", ["get", "class"], ROAD_CLASSES, true, false] });
  const lines = [];
  for (const f of feats) {
    const g = f.geometry;
    const parts = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const part of parts) lines.push(...clipLine(part, b));
  }
  src.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } }] });
}

function updateContext() {
  const poly = selectionPolygon();
  const on = $("ctx").checked;
  if (map.getLayer("ctx-places")) {
    const base = ["match", ["get", "class"], ["city", "town", "village"], true, false];
    map.setFilter("ctx-places", poly ? ["all", base, ["within", poly]] : base);
  }
  for (const id of ["ctx-roads-case", "ctx-roads", "ctx-places"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  if (on) clipRoads();
}
$("ctx").addEventListener("change", updateContext);

// The current selection: the drawn box, or all of Canada when there is none.
const selBox = () => state.box || CANADA;

// A small x pinned to the box's top-right corner clears the box (back to all of Canada).
const clearEl = document.createElement("button");
clearEl.type = "button";
clearEl.className = "box-clear";
clearEl.textContent = "×";
clearEl.title = "Clear the box and return to all of Canada";
clearEl.setAttribute("aria-label", "Clear the box and return to all of Canada");
clearEl.addEventListener("click", (e) => { e.stopPropagation(); clearBox(); });
const clearMarker = new maplibregl.Marker({ element: clearEl, anchor: "center" });

function select(b, fly) {
  state.box = b;
  fields.forEach((f) => { $(f).value = Math.round(b[f] * 100) / 100; });
  drawBox(b);
  clearMarker.setLngLat([b.east, b.north]).addTo(map);
  if (state.d) update();
  if (fly) fitToData();
}

function clearBox(fly = true) {
  state.box = null;
  fields.forEach((f) => { $(f).value = ""; });
  drawBox(null);
  clearMarker.remove();
  if (state.d) update();
  if (fly) fitToData();
}

// Fit the camera so the cells with data (or the box, if none) fill ~90% of the map's shorter side,
// centred. Every selection change (drawn box, typed bounds, presets, clearing back to Canada,
// exposure rows) moves the camera in one smooth flight whose duration grows with the distance
// travelled and the change in zoom (about 1-2.5 s). With reduced motion the camera jumps instead.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
function kmBetween(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
function fitToData() {
  const e = state.agg && state.agg.extent;
  const half = 0.12; // display cells are ~0.25 degrees across; pad centres by half a cell
  const b = e ? { south: e.south - half, north: e.north + half, west: e.west - half * 2, east: e.east + half * 2 } : selBox();
  const el = map.getContainer(), W = el.clientWidth, H = el.clientHeight;
  const side = 0.9 * Math.min(W, H);
  const px = Math.max((W - side) / 2, 0), py = Math.max((H - side) / 2, 0);
  const cam = map.cameraForBounds([[b.west, b.south], [b.east, b.north]], { padding: { top: py, bottom: py, left: px, right: px }, maxZoom: 9 });
  if (!cam) return;
  if (reduceMotion.matches) { map.jumpTo({ center: cam.center, zoom: cam.zoom }); return; }
  const from = map.getCenter(), to = maplibregl.LngLat.convert(cam.center);
  const dz = Math.abs(cam.zoom - map.getZoom());
  const duration = Math.min(2500, Math.max(1000, 900 + 260 * dz + 0.25 * kmBetween(from, to)));
  map.flyTo({ center: cam.center, zoom: cam.zoom, duration, curve: 1.42, easing: easeInOutCubic, essential: true });
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
  if (!state.mapReady || !state.agg) return;
  updateContext();
  const g = updateGrid(map, state.d, state.agg, state.range);
  if (g.n) gridLegend($("grid-legend"), g.scale, rangeLabel());
  else $("grid-legend").innerHTML = "";
}

function update() {
  const d = state.d;
  const agg = (state.agg = aggregate(d, selBox()));
  if (state.app === "live") { setGridVisible(false); loadLive(); return; }
  setGridVisible(true);
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
  const areaTip = state.box ? `Canada inside the box (land and lakes): the area searched, not the area burned.${partlyOutside ? ` Part of the box is outside Canada. ${OUTSIDE}` : ""}`
    : "All of Canada (land and lakes): the area searched, not the area burned. Draw a box to look at a smaller area.";
  const lowTip = `Less than ${fmt(minArea)} km² of Canada in the box: estimated years are low confidence.`;
  const areaTxt = agg.canadaKm2 >= 1e6 ? `${(agg.canadaKm2 / 1e6).toFixed(2)}M` : fmt(agg.canadaKm2);
  const dets = [["terra", "Terra"], ["aqua", "Aqua"], ["snpp", "S-NPP"], ["noaa20", "NOAA-20"]].map(([p, name]) => {
    const v = agg.detOf(p);
    let t = 0;
    for (let i = a; i <= b; i++) t += v[i];
    return [name, t];
  }).filter(([, t]) => t > 0);
  const pop = population(d, agg, d.months[a].y, d.months[b].y);
  const yrs = d.months[a].y === d.months[b].y ? `${d.months[a].y}` : `${d.months[a].y}–${d.months[b].y}`;
  const popLine = pop ? `<div class="sub" title="WorldPop 2020, 1 km, UN-adjusted: a modelled estimate of where people live, not a census count. Fire cells: ~1 km cells with at least one fire cell-day in ${yrs} (whole years).">
      ${fmtShort(pop.all)} people live here · ${fmtShort(pop.fire)} in ~1 km cells with fire, ${yrs} <span class="dim">(WorldPop 2020, modelled)</span></div>` : "";
  const hotTip = dets.length ? `Raw hotspot detections, ${rangeLabel()}: ${dets.map(([n, t]) => `${n} ${Math.round(t).toLocaleString("en-CA")}`).join(", ")}. `
    + "Hotspots count every flagged pixel on every overpass; cell-days count each ~1 km cell once a day. "
    + "Hotspots are counted by grid cell like the cell-days, so they can differ slightly from the hotspot CSV, which uses each detection's exact position." : "";
  const info = hotTip ? ` <span class="info-i" tabindex="0" role="img" aria-label="${hotTip}" title="${hotTip}">i</span>` : "";
  const where = state.box ? `${areaTxt} km² searched` : `all of Canada, ${areaTxt} km²`;
  $("summary").innerHTML = (!inCanada ? `<p class="notice">${OUTSIDE}</p>` : agg.cells.length ? `
    <div class="big" title="Harmonised fire cell-days (VIIRS-equivalent), ${rangeLabel()}">${fmt(total)}${hi - lo > 0.005 * total ? ` <span class="rng">(${fmtShort(lo)}–${fmtShort(hi)})</span>` : ""}
      <span class="unit">fire cell-days</span>${info}</div>
    <div class="sub">${rangeLabel()} · <span class="info" title="${areaTip}">${where}</span>${lowConfidence ? ` <span class="badge low" title="${lowTip}">low conf.</span>` : ""}</div>${popLine}`
    : `<div class="big">0 <span class="unit">fire cell-days</span></div>
    <div class="sub">${rangeLabel()} · <span class="info" title="${areaTip}">${where}</span> · no fire detected</div>${popLine}`);
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
  renderExposure();
}

// ---- downloads
$("dl-monthly").addEventListener("click", () => {
  saveBlob(monthlyCSV(state.d, state.agg, state.range), `ember_fire-cell-days_${fileStem(selBox(), state.d, state.range)}.csv`);
});
$("dl-png").addEventListener("click", async () => {
  const d = state.d, b = selBox();
  const cal = state.mode === "raw" ? renderCalendar(document.createElement("div"), d, state.agg, {
    years: state.cal.totals.map((t) => t.y), medianYears: [], range: state.range, lowConfidence: false,
    legendEl: document.createElement("div") }) : state.cal; // the PNG is always the harmonised calendar
  const blob = await calendarPNG(d, state.agg, cal, {
    years: cal.totals.map((t) => t.y), lowConfidence: state.agg.canadaKm2 < d.manifest.uncertainty.low_confidence_below_km2,
    title: "Ember · burning activity calendar (harmonised)",
    subtitle: `Box S ${b.south.toFixed(2)}, N ${b.north.toFixed(2)}, W ${b.west.toFixed(2)}, E ${b.east.toFixed(2)} · Canada inside the box ${fmt(state.agg.canadaKm2)} km² (area searched, not burned)`,
  });
  saveBlob(blob, `ember_fire-calendar_${fileStem(b, d, [0, d.months.length - 1])}.png`);
});
$("dl-hotspots").addEventListener("click", async () => {
  const st = $("dl-status"), btn = $("dl-hotspots");
  try {
    btn.disabled = true;
    const plan = await hotspotPlan(selBox(), state.d, state.range);
    if (!plan.tiles.length) { st.textContent = "No hotspots in this box and date range."; return; }
    if (plan.tooBig) { st.textContent = `This would read up to ${fmt(plan.rows)} hotspots. Narrow the box or the date range (limit 1.5 million).`; return; }
    st.textContent = `Reading ${plan.tiles.length} tiles (${(plan.bytes / 1e6).toFixed(1)} MB)…`;
    const { blob, rows } = await hotspotsCSV(selBox(), state.d, state.range, plan,
      (done, n, kept) => { st.textContent = `Reading tiles ${done}/${n} · ${fmt(kept)} hotspots so far…`; });
    saveBlob(blob, `ember_hotspots_${fileStem(selBox(), state.d, state.range)}.csv`);
    st.textContent = `Saved ${fmt(rows)} hotspots.`;
  } catch (err) {
    st.textContent = `Hotspot download failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// Zoom to an area from the exposure list: the cell's bounds padded by about one cell on each side.
function zoomToCell(i) {
  const ring = cellToBoundary(h3Id(state.d, i), true);
  const lats = ring.map((p) => p[1]), lons = ring.map((p) => p[0]);
  const s_ = Math.min(...lats), n_ = Math.max(...lats), w_ = Math.min(...lons), e_ = Math.max(...lons);
  const dy = n_ - s_, dx = e_ - w_;
  select({ south: s_ - dy, north: n_ + dy, west: w_ - dx, east: e_ + dx }, true);
}

// The top areas are outlined on the map with numbered badges; hovering a row, a badge or a
// cell highlights the matching pair.
const expMarkers = [];
function highlightExposure(rank) {
  if (map.getLayer("exp-hi")) map.setFilter("exp-hi", ["==", ["get", "rank"], rank || -1]);
  expMarkers.forEach((m) => m.getElement().classList.toggle("hi", m._rank === rank));
  document.querySelectorAll("#exposure tr[data-rank]").forEach((tr) => tr.classList.toggle("hi", +tr.dataset.rank === rank));
}
function drawExposure(top) {
  expMarkers.splice(0).forEach((m) => m.remove());
  const feats = top.map(({ i, rank }) => ({ type: "Feature", properties: { rank, i },
    geometry: { type: "Polygon", coordinates: [cellToBoundary(h3Id(state.d, i), true)] } }));
  const src = map.getSource("exp");
  if (src) src.setData({ type: "FeatureCollection", features: feats });
  for (const { i, rank } of top) {
    const el = document.createElement("div");
    el.className = "exp-badge";
    el.textContent = rank;
    el.addEventListener("mouseenter", () => highlightExposure(rank));
    el.addEventListener("mouseleave", () => highlightExposure(null));
    el.addEventListener("click", () => zoomToCell(i));
    const m = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([state.d.lon[i], state.d.lat[i]]).addTo(map);
    m._rank = rank;
    expMarkers.push(m);
  }
}
function renderExposure() {
  if (!state.d || !state.mapReady) return;
  const isLive = state.app === "live";
  const top = renderExposureList($("exposure"), state.d, selBox(), isLive ? live.feats : null, live.hours, zoomToCell, highlightExposure) || [];
  drawExposure(top);
}

// ---- Live mode: near-real-time hotspots (via the Worker) for the selection; Historical is the record.
// If the Worker cannot be reached, Live shows one line and Historical keeps working.
const live = { hours: 24, seq: 0, feats: [] };
const LIVE_DOWN = "Live fire data is unavailable right now.";
const WINDOW_LABEL = { 24: "last 24 hours", 48: "last 48 hours", 168: "last 7 days" };
let liveOk = null; // null = not checked yet
const liveReady = liveAvailable().then((ok) => (liveOk = ok));

function setGridVisible(on) {
  for (const id of ["grid-fill", "grid-line", "grid-est"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  if (map.getLayer("live")) map.setLayoutProperty("live", "visibility", on ? "none" : "visible");
}
const inBox = (f, b) => { const [x, y] = f.geometry.coordinates; return x >= b.west && x <= b.east && y >= b.south && y <= b.north; };

function liveDown() {
  document.body.classList.add("live-down");
  $("summary").innerHTML = `<p class="notice">${LIVE_DOWN}</p>`;
  if (map.getSource("live")) map.getSource("live").setData({ type: "FeatureCollection", features: [] });
  $("grid-legend").innerHTML = "";
}

async function loadLive() {
  const seq = ++live.seq;
  if (liveOk === null) await liveReady;
  if (seq !== live.seq || state.app !== "live") return;
  if (!liveOk) { liveDown(); return; }
  document.body.classList.remove("live-down");
  $("summary").innerHTML = `<p class="muted small">Loading live hotspots…</p>`;
  const b = selBox();
  try {
    const feats = await fetchLive([b.west, b.south, b.east, b.north], live.hours);
    if (seq !== live.seq || state.app !== "live") return;
    live.feats = feats.filter((f) => inBox(f, b)); // the Worker already keeps Canada only
    state.live = live.feats;
    renderLive();
  } catch {
    if (seq === live.seq) liveDown();
  }
}

function renderLive() {
  const d = state.d, agg = state.agg, feats = live.feats;
  map.getSource("live").setData({ type: "FeatureCollection", features: feats });
  setGridVisible(false);
  const n20 = feats.filter((f) => f.properties.sat !== "NOAA-21").length, n21 = feats.length - n20;
  const win = liveWindow(live.hours);
  const t = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const startMs = live.hours >= 168 ? win.start : Date.now() - live.hours * 3600e3;
  const areaTxt = agg.canadaKm2 >= 1e6 ? `${(agg.canadaKm2 / 1e6).toFixed(2)}M` : fmt(agg.canadaKm2);
  const where = state.box ? `${areaTxt} km² searched` : `all of Canada, ${areaTxt} km²`;
  const pop = d.pop ? agg.gridCells.reduce((s, i) => s + d.pop[i], 0) : 0;
  $("summary").innerHTML = `
    <div class="big">${fmt(feats.length)} <span class="unit">live hotspots</span><span class="live-tag">near real time, not harmonised</span></div>
    <div class="sub">${WINDOW_LABEL[live.hours]} (${t(startMs)} – ${t(Date.now())} UTC) · <span class="info" title="Canada only: points outside Canada are removed.">${where}</span></div>
    <div class="sub">NOAA-20 ${fmt(n20)} · NOAA-21 ${fmt(n21)}${pop ? ` · ${fmtShort(pop)} people live here <span class="dim">(WorldPop 2020, modelled)</span>` : ""}</div>`;
  live.meta = renderLiveChart($("livechart"), feats, live.hours);
  $("grid-legend").innerHTML = `<p class="legend-title">Live hotspots · ${WINDOW_LABEL[live.hours]}</p>
    <ul class="legend"><li><span class="sw key-live"></span>near real time, not harmonised (NOAA-20, NOAA-21)</li></ul>`;
  renderExposure();
}

document.querySelectorAll('input[name="app"]').forEach((r) => r.addEventListener("change", (e) => {
  state.app = e.target.value;
  document.body.classList.toggle("mode-live", state.app === "live");
  if (state.app !== "live") { document.body.classList.remove("live-down"); live.seq++; state.live = null; }
  if (state.d) update();
}));
document.querySelectorAll('input[name="live"]').forEach((r) => r.addEventListener("change", (e) => {
  live.hours = +e.target.value;
  if (state.app === "live") loadLive();
}));

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
    clearBox(false); // start on all of Canada
    loadPlaces("harmonised/places.json").then(renderExposure).catch(() => { $("exposure").textContent = "Place names could not be loaded."; });
  })
  .catch((err) => { $("summary").textContent = `Could not load the harmonised data (${err.message}).`; });
