import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./fonts.js";
import "./style.css";
import { MONTHS, aggregate, cellIndexOf, fmt, fmtShort, h3Id, loadData, monthDays, population, rawRecorded, uncertaintyFactors } from "./data.js";
import { renderExposureList, loadPlaces, placeName } from "./exposure.js";
import { cellToBoundary, cellToChildren, cellToParent, latLngToCell } from "h3-js";
import { attachTooltip, renderCalendar } from "./calendar.js";
import { renderCompare } from "./compare.js";
import { attachInfoTips, infoIcon } from "./info.js";
import { calendarPNG, coverage, fileTime, hotspotIndex, hotspotPlan, hotspotsCSV, liveCSV, monthlyCSV, saveBlob, utcStamp } from "./downloads.js";
import { addGridLayers, attachGridHover, buildGrid, buildLiveGrid, gridLegendHTML, setGrid } from "./grid.js";
import { initLayersControl, overlays, setLiveMode } from "./layers.js";
import { raisePlaces, setPlacesVisible } from "./places.js";
import { addTrendLayers, attachTrendHover, buildTrend, setTrend, trendLegendHTML } from "./trend.js";
import { addHoverLayers, footprint, raiseHover, scheduleHover, setHover, setPicked } from "./hover.js";
import { closeWhyCard, renderWhyCard } from "./whycard.js";
import { initTextSize } from "./textsize.js";
import { initInfoPanel } from "./infopanel.js";
import { initTour } from "./tour.js";
import { fixPair, lockCameras, layerPicker, repaintPickers, view } from "./views.js";
import { readUrl, writeUrl } from "./urlstate.js";
import { addLiveLayer, attachLiveHover, fetchLive, liveAvailable, liveReason } from "./live.js";
import { liveWindow, renderLiveChart, setLivePlaceNamer } from "./livechart.js";

const OBSERVED_FROM = 2012;
// With no box drawn, the selection is all of Canada.
const CANADA = { south: 41.5, north: 83.5, west: -141.5, east: -52.0 };
const STYLE = "https://tiles.openfreemap.org/styles/positron";
const OUTSIDE = "Harmonised history is available for Canada in this version.";

const $ = (id) => document.getElementById(id);

// Collapsible sections remember their state in this browser.
document.querySelectorAll("details[data-remember]").forEach((el) => {
  const key = `section:${el.id}`;
  try { const v = localStorage.getItem(key); if (v !== null) el.open = v === "1"; } catch { /* storage unavailable */ }
  el.addEventListener("toggle", () => { try { localStorage.setItem(key, el.open ? "1" : "0"); } catch { /* ignore */ } });
});
const state = { app: "historical", d: null, box: null, agg: null, cal: null, range: null, observedOnly: false, mode: "harmonised", colour: "activity", mapReady: false };

// ---- maps: globe, north up, no rotation or pitch. Every map gets the same sources and layers;
// what each one shows is set by applyLayers(). maps[0] is the main globe.
function makeMap(container) {
  const m = new maplibregl.Map({
    container, style: STYLE, center: [-96, 58], zoom: 1.5, bearing: 0, pitch: 0, maxPitch: 0,
    dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: false,
  });
  m.touchZoomRotate.disableRotation();
  m.keyboard.disableRotation();
  // Keep the canvas the size of its slot. body.app is sized in dvh, so the panel grows and
  // shrinks as a mobile browser's toolbars slide away - and Safari does not reliably fire a
  // window resize for that, which left the canvas short and the space below it black.
  const slot = m.getContainer();
  if (typeof ResizeObserver === "function") {
    let pending = false;
    new ResizeObserver(() => {
      if (pending) return; // one resize per frame, however many entries arrive
      pending = true;
      requestAnimationFrame(() => { pending = false; m.resize(); });
    }).observe(slot);
  }
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  m.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right"); // under zoom, clear of the corners below
  m.on("style.load", () => { m.setProjection({ type: "globe" }); neutralBasemap(m); });
  m.on("moveend", () => { if (m === maps[0]) saveUrl(); });
  m.on("load", () => {
    // the compact attribution starts collapsed (an "i" button) so it never spreads across the map
    m.getContainer().querySelectorAll(".maplibregl-compact-show").forEach((el) => el.classList.remove("maplibregl-compact-show"));
    setupMap(m);
  });
  attachDrawing(m);
  return m;
}
const maps = [];
const map = makeMap("map");
maps.push(map);
map.on("style.load", () => {
  const cam = canadaCamera(); // open already in on all of Canada
  if (cam) map.jumpTo(cam);
});
if (import.meta.env.DEV) {
  window.__ember = { map, maps, get state() { return state; } }; // test hook, dev builds only
  import("./fps.js").then((m) => m.attachFps(() => `${view.mode}, ${maps.length} globe${maps.length > 1 ? "s" : ""}`));
}

// Mid-grey basemap so both ends of the fire scale stand out (light orange low end, dark red
// high end): land ~ rgb(160,163,168), water darker, no blue or green tints.
function neutralBasemap(map) {
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
function setupMap(map) {
  map.addSource("selection", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-color": "#2bb3a3", "fill-opacity": 0.05 } });
  map.addLayer({ id: "selection-line", type: "line", source: "selection", paint: { "line-color": "#2bb3a3", "line-width": 2 } });
  addGridLayers(map);
  attachGridHover(map, $("tip"), () => ({ unit: state.app === "live" ? "hotspots" : "cell-days",
    label: state.app === "live" ? WINDOW_LABEL[live.hours] : rangeLabel(),
    paired: view.mode !== "single",
    place: (i) => (state.d && i !== undefined && state.d.lat[i] !== undefined ? placeName(state.d.lat[i], state.d.lon[i]) : "") }), linkHover);
  map.addSource("exp", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "exp-fill", type: "fill", source: "exp", paint: { "fill-color": "#ffffff", "fill-opacity": 0.01 } });
  map.addLayer({ id: "exp-line", type: "line", source: "exp", paint: { "line-color": "#ffffff", "line-width": 1.6 } });
  map.addLayer({ id: "exp-hi", type: "line", source: "exp", filter: ["==", ["get", "rank"], -1], paint: { "line-color": "#2bb3a3", "line-width": 3.5 } });
  // Numbered badges as map layers, not DOM markers: ten markers per globe were repositioned on
  // every frame of both locked globes, which is what made compare stutter.
  map.addSource("exp-pt", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "exp-badge", type: "circle", source: "exp-pt",
    paint: { "circle-radius": 10, "circle-color": ["case", ["==", ["get", "rank"], ["literal", -1]], "#ffffff", "#ffffff"],
      "circle-stroke-color": "#0b0d12", "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "exp-badge-hi", type: "circle", source: "exp-pt", filter: ["==", ["get", "rank"], -1],
    paint: { "circle-radius": 10, "circle-color": "#2bb3a3", "circle-stroke-color": "#0b0d12", "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "exp-badge-n", type: "symbol", source: "exp-pt",
    layout: { "text-field": ["to-string", ["get", "rank"]], "text-size": 11,
      "text-font": ["Noto Sans Regular"], "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#0b0d12" } });
  for (const id of ["exp-badge", "exp-badge-hi", "exp-badge-n"]) {
    map.on("mouseenter", id, (e) => {
      const f = e.features && e.features[0];
      if (f) highlightExposure(+f.properties.rank);
      map.getCanvas().style.cursor = drawing ? "crosshair" : "pointer";
    });
    map.on("mouseleave", id, () => { highlightExposure(null); map.getCanvas().style.cursor = drawing ? "crosshair" : ""; });
    map.on("click", id, (e) => {
      const f = e.features && e.features[0];
      if (f) { e.preventDefault(); zoomToCell(+f.properties.i); }
    });
  }
  map.on("mousemove", "exp-fill", (e) => { const f = e.features && e.features[0]; if (f) highlightExposure(+f.properties.rank); });
  map.on("mouseleave", "exp-fill", () => highlightExposure(null));
  map.addSource("pop", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "pop-fill", type: "fill", source: "pop", layout: { visibility: "none" },
    paint: { "fill-color": ["get", "color"], "fill-opacity": 0.88 } }, "exp-fill");
  map.addLayer({ id: "pop-line", type: "line", source: "pop", layout: { visibility: "none" },
    paint: { "line-color": "#2a2e38", "line-width": 0.4, "line-opacity": 0.6 } }, "exp-fill");
  map.on("mousemove", "pop-fill", (e) => {
    const f = e.features && e.features[0];
    if (!f || view.mode !== "single") return; // compare writes one paired tooltip instead
    const tip = $("tip");
    const pv = +f.properties.p;
    tip.innerHTML = `<strong>${pv < 1 ? pv.toFixed(2) : fmt(pv)}</strong> people live in this grid cell`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.originalEvent.clientX + 14, innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.min(e.originalEvent.clientY + 14, innerHeight - r.height - 8)}px`;
  });
  map.on("mouseleave", "pop-fill", () => { $("tip").hidden = true; });
  addTrendLayers(map);
  attachTrendHover(map, $("tip"), () => trendYears());
  addLiveLayer(map);
  attachLiveHover(map, $("tip"));
  raisePlaces(map); // borders and labels above the fire grid
  addHoverLayers(map); // added last: the outline sits above every fill, trend, population and Places
  // population and the trend layer are hoverable too, not just the fire grid
  for (const layer of ["pop-fill", "trend-fill"]) {
    map.on("mousemove", layer, (e) => {
      const f = e.features && e.features[0];
      if (f) linkHover(map, f.properties.h3 || null);
    });
    map.on("mouseleave", layer, () => linkHover(map, null));
  }
  for (const layer of ["grid-fill", "trend-fill", "pop-fill"]) {
    map.on("click", layer, (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      // The coarse grid in compare mode carries no cell index, only its H3 id, so a click there
      // is resolved through the display cell under the pointer.
      if (f.properties.i !== undefined) { openWhyForCell(+f.properties.i); return; }
      const k = cellIndexOf(state.d, latLngToCell(e.lngLat.lat, e.lngLat.lng, 5));
      if (k !== undefined) openWhyForCell(k);
    });
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = drawing ? "crosshair" : "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = drawing ? "crosshair" : ""; });
  }
  map._ready = true;
  // bring this map up to date with whatever has been computed so far
  drawBox(state.box);
  if (state.grid) setGrid(map, state.grid.features);
  if (state.trend) setTrend(map, state.trend.features);
  if (pickedH3) setPicked(map, footprint(pickedH3, hoverResOf(map)));
  if (state.popFeatures) map.getSource("pop").setData({ type: "FeatureCollection", features: state.popFeatures });
  if (state.app === "live" && map.getSource("live")) map.getSource("live").setData({ type: "FeatureCollection", features: live.feats });
  applyLayers();
  if (map === maps[0]) {
    state.mapReady = true;
    renderExposure(); // places may have loaded before the map
    if (state.d) refreshGrid();
  } else {
    drawExposure(expTop);
  }
}
function drawBox(b) {
  for (const m of maps) {
    const src = m.getSource("selection");
    if (src) src.setData({ type: "FeatureCollection", features: b ? [boxFeature(b)] : [] });
  }
}

// ---- rectangle drawing (works on the globe; panning is paused while drawing)
let drawing = false, start = null;
$("draw").addEventListener("click", () => setDrawing(!drawing));
function setDrawing(on) {
  drawing = on;
  $("draw").setAttribute("aria-pressed", String(on));
  $("draw").textContent = on ? "Drag on the map…" : "Draw a box";
  for (const m of maps) {
    m.getCanvas().style.cursor = on ? "crosshair" : "";
    if (on) m.dragPan.disable(); else m.dragPan.enable();
  }
}
const boxFrom = (a, b) => ({ south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat), west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng) });
function attachDrawing(m) {
  m.on("mousedown", (e) => { if (drawing) { start = e.lngLat; e.preventDefault(); } });
  m.on("mousemove", (e) => { if (drawing && start) drawBox(boxFrom(start, e.lngLat)); });
  m.on("mouseup", (e) => {
    if (!drawing || !start) return;
    const b = boxFrom(start, e.lngLat);
    start = null;
    setDrawing(false);
    if (b.north - b.south < 0.05 || b.east - b.west < 0.05) { drawBox(state.box); return; }
    select(b, true);
  });
}

// ---- bounds inputs
const fields = ["south", "north", "west", "east"];
$("bounds").addEventListener("submit", (e) => {
  e.preventDefault();
  // A blank field keeps the current selection's value; a typed minus sign or comma decimal is accepted.
  const cur = selBox();
  const read = (f) => { const t = $(f).value.trim().replace("−", "-").replace(",", "."); return t === "" ? cur[f] : Number(t); };
  const b = Object.fromEntries(fields.map((f) => [f, read(f)]));
  const err = !fields.every((f) => Number.isFinite(b[f])) ? "Bounds must be numbers in degrees."
    : b.south < -90 || b.north > 90 || b.south >= b.north ? "South must be below north, within −90 to 90."
    : b.west < -180 || b.east > 180 || b.west >= b.east ? "West must be less than east, within −180 to 180." : "";
  $("bounds-error").textContent = err;
  if (err) return;
  if (fields.every((f) => b[f] === CANADA[f])) { if (state.box) clearBox(); return; } // all of Canada is no box
  select(b, true);
});

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
// one x per map, all pinned to the same corner
const clearMarkers = new Map();
function placeClearMarkers(b) {
  for (const m of maps) {
    if (!clearMarkers.has(m)) {
      const el = m === maps[0] ? clearEl : clearEl.cloneNode(true);
      if (el !== clearEl) el.addEventListener("click", (e) => { e.stopPropagation(); clearBox(); });
      clearMarkers.set(m, new maplibregl.Marker({ element: el, anchor: "center" }));
    }
    const mk = clearMarkers.get(m);
    if (b) mk.setLngLat([b.east, b.north]).addTo(m); else mk.remove();
  }
}

function select(b, fly) {
  state.box = b;
  $("bounds-error").textContent = "";
  fields.forEach((f) => { $(f).value = Math.round(b[f] * 100) / 100; });
  drawBox(b);
  placeClearMarkers(b);
  if (state.d) update();
  if (fly) fitToData();
  saveUrl();
}

function clearBox(fly = true) {
  state.box = null;
  $("bounds-error").textContent = "";
  fields.forEach((f) => { $(f).value = CANADA[f]; }); // the form always shows the current selection
  drawBox(null);
  placeClearMarkers(null);
  if (state.d) update();
  if (fly) flyToCamera(canadaCamera()); // back to exactly the opening view
  saveUrl();
}

// Fit the camera so the cells with data (or the box, if none) fill ~90% of the map's shorter side,
// centred. Every selection change (drawn box, typed bounds, clearing back to Canada,
// exposure rows) moves the camera in one smooth flight whose duration grows with the distance
// travelled and the change in zoom (about 1-2.5 s). With reduced motion the camera jumps instead.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
function kmBetween(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
// Padding rule shared by every fit: the bounds fill ~90% of the map's shorter side, centred.
function cameraFor(b) {
  const el = map.getContainer(), W = el.clientWidth, H = el.clientHeight;
  const side = 0.9 * Math.min(W, H);
  const px = Math.max((W - side) / 2, 0), py = Math.max((H - side) / 2, 0);
  return map.cameraForBounds([[b.west, b.south], [b.east, b.north]], { padding: { top: py, bottom: py, left: px, right: px }, maxZoom: 9 });
}
// All of Canada on the globe. cameraForBounds works in flat Mercator terms, which on a globe centres
// Canada too far north and leaves it small, so the fit is refined on the globe itself: Canada's
// outermost points are projected and the camera is moved until they fill the same padding square
// (90% of the map's shorter side), centred. The map is put back where it was; the caller moves it.
const CANADA_EXTREMES = [[-141, 69.6], [-141, 60.3], [-133, 54.6], [-123.4, 48.3], [-95.2, 49], [-82.6, 41.7], [-67, 44.6],
  [-59.8, 43.9], [-52.6, 47.5], [-55.6, 52.2], [-61.6, 56.6], [-64.7, 60.3], [-61.5, 66.6], [-63, 82.4], [-70, 83.1],
  [-90, 81.7], [-110, 78.6], [-120, 74.3], [-125.5, 71.9], [-135, 69.5]];
function canadaCamera() {
  const el = map.getContainer(), W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return null;
  const first = cameraFor(CANADA);
  if (!first) return null;
  const saved = { center: map.getCenter(), zoom: map.getZoom() };
  const side = 0.9 * Math.min(W, H);
  let cam = { center: maplibregl.LngLat.convert(first.center), zoom: first.zoom };
  for (let k = 0; k < 5; k++) {
    map.jumpTo(cam);
    const xy = CANADA_EXTREMES.map((p) => map.project(p));
    const x0 = Math.min(...xy.map((q) => q.x)), x1 = Math.max(...xy.map((q) => q.x));
    const y0 = Math.min(...xy.map((q) => q.y)), y1 = Math.max(...xy.map((q) => q.y));
    const scale = Math.min(side / (x1 - x0), side / (y1 - y0));
    cam = { center: map.unproject([(x0 + x1) / 2, (y0 + y1) / 2]), zoom: cam.zoom + Math.log2(scale) };
    if (Math.abs(Math.log2(scale)) < 0.005) break;
  }
  map.jumpTo(saved);
  return cam;
}
function fitToData() {
  const e = state.agg && state.agg.extent;
  const half = 0.12; // display cells are ~0.25 degrees across; pad centres by half a cell
  const b = e ? { south: e.south - half, north: e.north + half, west: e.west - half * 2, east: e.east + half * 2 } : selBox();
  flyToCamera(cameraFor(b));
}
function flyToCamera(cam) {
  if (!cam) return;
  // only the first map is flown: the lock copies every frame to the other one
  if (reduceMotion.matches) { map.jumpTo({ center: cam.center, zoom: cam.zoom }); return; }
  const from = map.getCenter(), to = maplibregl.LngLat.convert(cam.center);
  const dz = Math.abs(cam.zoom - map.getZoom());
  const duration = Math.min(2500, Math.max(1000, 900 + 260 * dz + 0.25 * kmBetween(from, to)));
  map.flyTo({ center: cam.center, zoom: cam.zoom, duration, curve: 1.42, easing: easeInOutCubic, essential: true });
}

// ---- "Why it burned": opened by a cell on the map or a month in the calendar. It renders in the
// side panel below the fire chart, outlines the cell on every globe and is closed by its button
// or Esc.
let whyCell = null;
async function openWhyForCell(i) {
  whyCell = i;
  const d = state.d;
  const place = placeName(d.lat[i], d.lon[i]) || "This area";
  const mine = (live.feats || []).filter((f) => {
    const [lon, lat] = f.geometry.coordinates;
    return cellIndexOf(d, latLngToCell(lat, lon, 5)) === i;
  });
  const liveCtx = state.app === "live" ? {
    windowLabel: WINDOW_LABEL[live.hours],
    feats: mine,
    frame: { hours: live.hours, count: mine.length },
  } : null;
  await renderWhyCard($("sec-why"), d, state.agg, {
    i, place, range: state.range, scope: "cell",
    windowLabel: state.app === "live" ? WINDOW_LABEL[live.hours] : rangeLabel(),
    recordLabel: `${MONTHS[d.months[0].m - 1]} ${d.months[0].y} – ${MONTHS[d.lastMonth.m - 1]} ${d.lastMonth.y}`,
  }, liveCtx);
  setPickedCell(h3Id(d, i)); // stays outlined while the card is open
  $("sec-why").scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "nearest" });
  $("sec-why").querySelector(".wc-close").addEventListener("click", closeWhy);
  $("sec-why").querySelector(".wc-close").focus({ preventScroll: true });
}
// a month in the calendar: the selection box, that month only
async function openWhyForMonth(mi) {
  whyCell = null;
  setPickedCell(null); // a month covers the whole selection, not one cell
  const d = state.d, info = d.months[mi];
  await renderWhyCard($("sec-why"), d, state.agg, {
    place: state.box ? "Selected box" : "All of Canada", range: [mi, mi], scope: "month",
    clickedMonth: mi,
    windowLabel: `${MONTHS[info.m - 1]} ${info.y}`,
    nameOf: (la, lo) => placeName(la, lo) || "a cell",
  }, null);
  $("sec-why").scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "nearest" });
  $("sec-why").querySelector(".wc-close").addEventListener("click", closeWhy);
  $("sec-why").querySelector(".wc-close").focus({ preventScroll: true });
}
function closeWhy() {
  whyCell = null;
  setPickedCell(null);
  showAreaCard(); // fall back to the selection rather than leaving nothing
}

// The card with nothing clicked: the selected area over the selected dates, so the answer is on
// screen as soon as the dashboard loads.
async function showAreaCard() {
  if (!state.d || !state.agg) return;
  const d = state.d;
  const liveCtx = state.app === "live"
    ? { windowLabel: WINDOW_LABEL[live.hours], feats: live.feats || [],
        frame: { hours: live.hours, count: (live.feats || []).length } }
    : null;
  await renderWhyCard($("sec-why"), d, state.agg, {
    place: state.box ? "Selected area" : "All of Canada",
    range: state.range, scope: "area",
    windowLabel: state.app === "live" ? WINDOW_LABEL[live.hours] : rangeLabel(),
    recordLabel: `${MONTHS[d.months[0].m - 1]} ${d.months[0].y} – ${MONTHS[d.lastMonth.m - 1]} ${d.lastMonth.y}`,
    nameOf: (la, lo) => placeName(la, lo) || "a cell",
  }, liveCtx);
  const close = $("sec-why").querySelector(".wc-close");
  if (close) close.hidden = true; // nothing to close back to
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sec-why").hidden) closeWhy(); });

// ---- linked hover: the hovered ground is outlined on every globe, translated to the resolution
// each one draws at. The resolution a globe shows depends on its layer and the view mode.
function hoverResOf(m) {
  const show = layersFor(m);
  if (show.trend || show.people) return 5;          // both are drawn on the display grid
  return state.grid && state.grid.coarse ? 4 : 5;   // the fire grid is rolled up in compare
}
// The cell the reader clicked, outlined on every globe until another is clicked or the card is
// closed. Separate from hover, so moving the cursor never erases it.
let pickedH3 = null;
function drawPicked() {
  for (const m of maps) {
    if (!m._ready) continue;
    setPicked(m, pickedH3 ? footprint(pickedH3, hoverResOf(m)) : []);
  }
}
function setPickedCell(h3id) {
  pickedH3 = h3id;
  drawPicked();
}

function linkHover(from, h3id) {
  scheduleHover(() => {
    for (const m of maps) {
      if (!m._ready) continue;
      setHover(m, h3id ? footprint(h3id, hoverResOf(m)) : []);
    }
    showPairTip(h3id);
  });
}

// In compare the tooltip reports the same ground on both globes, each in its own layer's terms,
// so hovering one tells the reader what the other shows there too.
function showPairTip(h3id) {
  const tip = $("tip");
  if (!h3id || view.mode === "single" || maps.length < 2) return;
  const d = state.d;
  // the hovered id may be res 4 (the coarse grid in compare) or res 5; find a display cell either way
  let i = cellIndexOf(d, h3id);
  if (i === undefined) {
    try { i = cellIndexOf(d, cellToParent(h3id, 5)); } catch { /* not finer than res 5 */ }
  }
  if (i === undefined) {
    try { for (const kid of cellToChildren(h3id, 5)) { i = cellIndexOf(d, kid); if (i !== undefined) break; } }
    catch { /* not coarser than res 5 */ }
  }
  if (i === undefined) return;
  const lines = maps.map((m, k) => {
    const show = layersFor(m);
    const where = k === 0 ? "Top" : "Bottom";
    if (show.people) {
      const p = d.pop[i] || 0;
      return `<span class="muted">${where}:</span> ${p < 1 ? p.toFixed(2) : fmt(Math.round(p))} people`;
    }
    if (show.trend) {
      const f = (state.trend?.features || []).find((x) => x.properties.i === i);
      if (!f) return `<span class="muted">${where}:</span> no trend`;
      return `<span class="muted">${where}:</span> ${f.properties.sig ? `${f.properties.slope > 0 ? "rising" : "falling"} ${fmt(Math.abs(f.properties.slope))} a year` : "no clear change"}`;
    }
    const unit = state.app === "live" ? "hotspots" : "cell-days";
    const feats = (state.grid?.features || []);
    const f = feats.find((x) => x.properties.h3 === h3id)
      || feats.find((x) => x.properties.i === i);
    return `<span class="muted">${where}:</span> ${f ? fmt(f.properties.v) : 0} ${unit}`;
  });
  const near = placeName(d.lat[i], d.lon[i]);
  tip.innerHTML = `${near ? `<strong>${near}</strong><br>` : ""}${lines.join("<br>")}`;
  tip.hidden = false;
}

// ---- views: one globe, or two locked globes (compare). On a narrow window the two globes stack
// as the layout already does, still locked together.
const narrow = window.matchMedia("(max-width: 960px)");
let unlock = null;

function ensureSecondMap() {
  if (maps[1]) return maps[1];
  $("map-slot-b").hidden = false;
  const m = makeMap("map-b");
  maps.push(m);
  m.jumpTo({ center: maps[0].getCenter(), zoom: maps[0].getZoom() });
  $("map-slot-b").appendChild(Object.assign(document.createElement("div"),
    { id: "grid-legend-b", className: "map-ui corner-bl map-legend" }));
  $("map-slot-b").appendChild(layerPicker("bottom", onViewPick));
  $("map-slot-a").appendChild(layerPicker("top", onViewPick));
  return m;
}
function onViewPick() {
  updateTrend();
  updatePop();
  applyLayers();
  renderLegends();
  saveUrl();
}

function setView(mode) {
  if (mode === view.mode) return;
  view.mode = mode;
  const stack = $("map-stack");
  stack.dataset.view = mode;
  $("compare-btn").setAttribute("aria-pressed", String(mode === "compare"));
  if (mode === "single") {
    if (unlock) { unlock(); unlock = null; }
    $("map-slot-b").hidden = true;
    document.querySelectorAll(".view-pick").forEach((el) => { el.hidden = true; });
    if (maps[1]) maps[1].resize();
    maps[0].resize();
    refreshGrid(); // back to the full-resolution grid
    onViewPick();
    saveUrl();
    return;
  }
  ensureSecondMap();
  document.querySelectorAll(".view-pick").forEach((el) => { el.hidden = false; });
  if (!unlock) unlock = lockCameras(maps);
  // Resize now that both slots are visible, and again next frame once the layout has settled:
  // the first keeps a map from drawing at zero size, the second picks up the final dimensions.
  for (const m of maps) m.resize();
  requestAnimationFrame(() => { for (const m of maps) m.resize(); });
  refreshGrid(); // the grid is coarser while two globes are shown
  onViewPick();
  saveUrl();
}
$("compare-btn").addEventListener("click", () => setView(view.mode === "compare" ? "single" : "compare"));

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
["from", "to"].forEach((id) => $(id).addEventListener("change", () => { if (readRange()) { update(); saveUrl(); } }));
document.querySelectorAll('input[name="years"]').forEach((r) => r.addEventListener("change", (e) => { state.observedOnly = e.target.value === "measured"; update(); }));
document.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener("change", (e) => { state.mode = e.target.value; update(); }));
document.querySelectorAll('input[name="colour"]').forEach((r) => r.addEventListener("change", (e) => { state.colour = e.target.value; update(); }));

function refreshGrid() {
  if (!state.mapReady || !state.agg || deferHeavy) return;
  const isLive = state.app === "live";
  const coarse = view.mode === "compare"; // two globes: fewer, larger cells so both stay smooth
  const g = (state.grid = isLive ? state.liveGrid || { features: [], scale: null, n: 0 } : buildGrid(state.d, state.agg, state.range, { coarse }));
  for (const m of maps) { setGrid(m, g.features); raiseHover(m); }
  drawPicked(); // a redraw must not drop the selected cell
  state.fireLegend = !g.n || !g.scale ? ""
    : isLive ? gridLegendHTML(g.scale, { live: true, windowLabel: WINDOW_LABEL[live.hours] })
    : gridLegendHTML(g.scale, { rangeLabel: rangeLabel(), coarse: g.coarse });
  updatePop();
  updateTrend();
  applyLayers();
  renderLegends();
}

// Per-cell trends over the complete years in the date range.
const trendYears = () => {
  const t = state.trend;
  return t && t.years.length ? `${t.years[0]}–${t.years[t.years.length - 1]}` : rangeLabel();
};
const wantsTrend = () => (view.mode === "single" ? overlays.trend : view.top === "trend" || view.bottom === "trend");
const wantsPeople = () => view.mode !== "single" && (view.top === "people" || view.bottom === "people");
function updateTrend() {
  if (!wantsTrend() || state.app === "live" || !state.d || !state.agg) {
    state.trend = null;
    for (const m of maps) setTrend(m, []);
    return;
  }
  state.trend = buildTrend(state.d, state.agg, state.range);
  for (const m of maps) setTrend(m, state.trend.features);
}

function update() {
  const d = state.d;
  const agg = (state.agg = aggregate(d, selBox()));
  if (state.app === "live") { state.liveGrid = null; refreshGrid(); loadLive(); return; }
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
  // first line: the number, its range and the unit; everything else sits behind the info icon
  const details = [
    `<strong>${rangeLabel()}</strong>${agg.cells.length ? "" : " · no fire detected"}`,
    `${state.box ? `${areaTxt} km² of Canada in the box` : `All of Canada, ${areaTxt} km²`}: the area searched, not burned.${state.box && partlyOutside ? " Part of the box is outside Canada." : ""}`,
    lowConfidence ? `<strong>Low confidence:</strong> ${lowTip}` : "",
    pop ? `${fmtShort(pop.all)} people live here; ${fmtShort(pop.fire)} in ~1 km cells with fire, ${yrs}. <span class="muted">WorldPop 2020, modelled.</span>` : "",
    dets.length ? `Raw hotspot detections: ${dets.map(([n, t]) => `${n} ${Math.round(t).toLocaleString("en-CA")}`).join(", ")}.` : "",
    `<span class="muted">VIIRS-equivalent fire cell-days: each ~1 km cell counts once on each day it has fire. Hotspots count every flagged pixel on every overpass.</span>`,
  ].filter(Boolean).join("<br>");
  const info = infoIcon(details, lowConfidence ? "warn" : "");
  $("summary").innerHTML = !inCanada ? `<p class="notice">${OUTSIDE}</p>`
    : `<div class="big">${fmt(total)}${agg.cells.length && hi - lo > 0.005 * total ? ` <span class="rng">(${fmtShort(lo)}–${fmtShort(hi)})</span>` : ""}
      <span class="unit">fire cell-days</span>${info}</div>`;
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
  if (whyCell === null) showAreaCard(); // keep the answer in step with the selection
  $("dl-status").textContent = "";
  refreshGrid();
  renderExposure();
}

// ---- downloads
$("dl-monthly").addEventListener("click", () => {
  const cov = coverage(state.d, state.box, state.range);
  saveBlob(monthlyCSV(state.d, state.agg, state.range, cov), `ember_fire-cell-days_${cov.tag}_${cov.periodTag}.csv`);
});
$("dl-png").addEventListener("click", async () => {
  const d = state.d, b = selBox();
  const cov = coverage(d, state.box, [0, d.months.length - 1]); // the PNG always shows the whole record
  const cal = state.mode === "raw" ? renderCalendar(document.createElement("div"), d, state.agg, {
    years: state.cal.totals.map((t) => t.y), medianYears: [], range: state.range, lowConfidence: false,
    legendEl: document.createElement("div") }) : state.cal; // the PNG is always the harmonised calendar
  const blob = await calendarPNG(d, state.agg, cal, {
    years: cal.totals.map((t) => t.y), lowConfidence: state.agg.canadaKm2 < d.manifest.uncertainty.low_confidence_below_km2,
    title: "Ember · burning activity calendar (harmonised)",
    subtitle: state.box
      ? `Box S ${b.south.toFixed(2)}, N ${b.north.toFixed(2)}, W ${b.west.toFixed(2)}, E ${b.east.toFixed(2)} · Canada inside the box ${fmt(state.agg.canadaKm2)} km² (area searched, not burned)`
      : `All of Canada · ${fmt(state.agg.canadaKm2)} km² (area searched, not burned)`,
    caption: `Period ${cov.period} (data to ${cov.dataEnd}) · Generated ${utcStamp()}`,
  });
  saveBlob(blob, `ember_fire-calendar_${cov.tag}_${cov.periodTag}.png`);
});
$("dl-hotspots").addEventListener("click", async () => {
  const st = $("dl-status"), btn = $("dl-hotspots");
  try {
    btn.disabled = true;
    const plan = await hotspotPlan(selBox(), state.d, state.range);
    if (!plan.tiles.length) { st.textContent = "No hotspots in this box and date range."; return; }
    if (plan.tooBig) { st.textContent = `This would read up to ${fmt(plan.rows)} hotspots. Narrow the box or the date range (limit 1.5 million).`; return; }
    st.textContent = `Reading ${plan.tiles.length} tiles (${(plan.bytes / 1e6).toFixed(1)} MB)…`;
    const cov = coverage(state.d, state.box, state.range);
    const { blob, rows } = await hotspotsCSV(selBox(), state.d, state.range, plan,
      (done, n, kept) => { st.textContent = `Reading tiles ${done}/${n} · ${fmt(kept)} hotspots so far…`; }, cov);
    saveBlob(blob, `ember_hotspots_${cov.tag}_${cov.periodTag}.csv`);
    st.textContent = `Saved ${fmt(rows)} hotspots.`;
  } catch (err) {
    st.textContent = `Hotspot download failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("dl-live").addEventListener("click", () => {
  if (!live.span) return;
  const cov = coverage(state.d, state.box, state.range);
  const win = live.hours >= 168 ? "7d" : `${live.hours}h`;
  saveBlob(liveCSV(live.feats, { area: cov.area, windowLabel: WINDOW_LABEL[live.hours], ...live.span }),
    `ember_live-hotspots_${cov.tag}_${win}_${fileTime(live.span.start)}_${fileTime(live.span.end)}.csv`);
  $("dl-status").textContent = `Saved ${fmt(live.feats.length)} live hotspots.`;
});

// Zoom to an area from the exposure list: the cell's bounds padded by about one cell on each side.
// Opening compare, building the second map, recomputing both grids and starting the flight in one
// go dropped frames for most of a second. The work is spread out instead: open compare and wait
// for the second globe, update once, fly, and leave the heavy setData until the flight has landed.
function zoomToCell(i) {
  const ring = cellToBoundary(h3Id(state.d, i), true);
  const lats = ring.map((p) => p[1]), lons = ring.map((p) => p[0]);
  const s_ = Math.min(...lats), n_ = Math.max(...lats), w_ = Math.min(...lons), e_ = Math.max(...lons);
  const dy = n_ - s_, dx = e_ - w_;
  const box = { south: s_ - dy, north: n_ + dy, west: w_ - dx, east: e_ + dx };

  const go = () => {
    deferHeavy = true; // grids and badges wait until the flight lands
    select(box, true);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      maps[0].off("moveend", done);
      clearTimeout(guard);
      deferHeavy = false;
      // one frame later, so the last frame of the flight is not the one that pays for it
      requestAnimationFrame(() => { refreshGrid(); renderExposure(); });
    };
    const guard = setTimeout(done, 3500); // a flight that never ends must not strand them
    maps[0].once("moveend", done);
  };

  if (view.mode === "single") {
    setView("compare"); // a row opens the comparison on that area
    // The second globe is created by that call, so it may still be loading its style. Wait for it
    // before flying, and size it first: a map that is flown while its slot is still 0x0 renders
    // black until something else happens to resize it.
    whenReady(maps[1], () => {
      for (const m of maps) m.resize();
      requestAnimationFrame(go);
    });
    return;
  }
  go();
}
// Run fn once the map has loaded. `once("load")` alone would never fire for a map that finished
// loading before we asked, which is the usual case on a warm cache.
function whenReady(m, fn) {
  if (!m) return fn();
  if (m._ready || m.loaded()) return fn();
  m.once("load", fn);
}
let deferHeavy = false;

// The top areas are outlined on the map with numbered badges; hovering a row, a badge or a
// cell highlights the matching pair.
function highlightExposure(rank) {
  for (const m of maps) {
    if (m.getLayer("exp-hi")) m.setFilter("exp-hi", ["==", ["get", "rank"], rank || -1]);
    if (m.getLayer("exp-badge-hi")) m.setFilter("exp-badge-hi", ["==", ["get", "rank"], rank || -1]);
  }
  document.querySelectorAll("#exposure tr[data-rank]").forEach((tr) => tr.classList.toggle("hi", +tr.dataset.rank === rank));
}
// Outlines and numbered badges appear only when the "Exposure badges" layer is on (off by default).
let expTop = [];
function drawExposure(top) {
  expTop = top;
  if (!overlays.badges || !state.d) top = [];
  const outlines = top.map(({ i, rank }) => ({ type: "Feature", properties: { rank, i },
    geometry: { type: "Polygon", coordinates: [cellToBoundary(h3Id(state.d, i), true)] } }));
  const points = top.map(({ i, rank }) => ({ type: "Feature", properties: { rank, i },
    geometry: { type: "Point", coordinates: [state.d.lon[i], state.d.lat[i]] } }));
  for (const map of maps) {
    map.getSource("exp")?.setData({ type: "FeatureCollection", features: outlines });
    map.getSource("exp-pt")?.setData({ type: "FeatureCollection", features: points });
  }
}
function renderExposure() {
  if (!state.d || !state.mapReady || deferHeavy) return;
  const isLive = state.app === "live";
  const top = renderExposureList($("exposure"), state.d, selBox(), isLive ? live.feats : null, live.hours,
    zoomToCell, highlightExposure, state.range) || [];
  drawExposure(top);
}

// ---- Live mode: near-real-time hotspots (via the Worker) for the selection; Historical is the record.
// If the Worker cannot be reached, Live shows one line and Historical keeps working.
const live = { hours: 24, seq: 0, feats: [], earlier: [], reachFrom: 0 };
const LIVE_DOWN = "Live fire data is unavailable right now.";
const WINDOW_LABEL = { 24: "last 24 hours", 48: "last 48 hours", 168: "last 7 days" };
// No cached verdict: liveAvailable() checks again on each attempt, so one dropped request no
// longer wedges live mode off until a reload.

// Which layers each map shows. The fire grid is the base and always on; overlays follow their
// toggles in the Layers control. Nothing else appears unless it is turned on.
// In single view the overlay toggles decide what each map shows. In compare each map
// shows one chosen layer, so the pickers decide instead; the toggles that are not a map's subject
// still apply on top of it.
function layersFor(m) {
  const live = state.app === "live";
  const overlayShow = {
    fire: true,
    places: overlays.places,
    trend: overlays.trend && !live,
    people: false, // not an overlay: population is a compare-globe layer only
    detections: overlays.detections && live,
  };
  if (view.mode === "single") return overlayShow;
  const pick = m === maps[0] ? view.top : view.bottom;
  return {
    places: overlays.places, // on both globes, whatever each one shows
    fire: pick === "fire",
    trend: pick === "trend" && !live,
    people: pick === "people",
    detections: overlays.detections && live,
  };
}
function applyLayers() {
  for (const m of maps) {
    if (!m._ready) continue;
    const show = layersFor(m);
    const set = (ids, on) => ids.forEach((id) => m.getLayer(id) && m.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
    setPlacesVisible(m, show.places);
    set(["grid-fill", "grid-line", "grid-est"], show.fire && !show.trend); // the trend replaces the totals
    set(["trend-fill", "trend-line"], show.trend);
    set(["pop-fill", "pop-line"], show.people);
    set(["live"], show.detections);
  }
}

// People per display cell (WorldPop 2020): its own blue scale so it never reads as fire.
// Log-spaced classes starting below one person: the old linear classes began at 1 and the layer
// only drew cells with at least one person, which hid 4,160 of the 4,829 populated cells north of
// 60 (86%) and made the territories look empty. Cells with nobody in them stay empty: nothing is
// smoothed or spread into them.
const POP_EDGES = [1, 10, 100, 1000, 10000];
const POP_COLORS = ["#d7ebfa", "#a5d1f3", "#66b3e6", "#1b94d3", "#0570ab", "#044e81"];
const POP_LABELS = ["< 1", "1–10", "10–100", "100–1k", "1k–10k", "> 10k"];
function popColor(v) { let k = 0; while (k < POP_EDGES.length && v >= POP_EDGES[k]) k++; return POP_COLORS[k]; }
function updatePop() {
  const d = state.d;
  state.popFeatures = !wantsPeople() || !d || !state.agg ? [] : state.agg.gridCells.filter((i) => d.pop[i] > 0).map((i) => ({ type: "Feature",
    properties: { color: popColor(d.pop[i]), p: d.pop[i], h3: h3Id(d, i) },
    geometry: { type: "Polygon", coordinates: [cellToBoundary(h3Id(d, i), true)] } }));
  for (const m of maps) { const src = m.getSource("pop"); if (src) src.setData({ type: "FeatureCollection", features: state.popFeatures }); }
}
const popLegendHTML = () => `<p class="legend-title">People per grid cell${infoIcon("People living in each ~250 km² grid cell. WorldPop 2020, 1 km, UN-adjusted: a modelled estimate, not a census count.<br>Classes are log-spaced and start below one person, so sparsely populated cells in the north are still visible. Cells with nobody in them are left empty.")}</p>
  <ul class="legend">${POP_COLORS.map((c, k) => `<li><span class="sw" style="background:${c}"></span>${POP_LABELS[k]}</li>`).join("")}</ul>`;
function legendFor(m) {
  const show = layersFor(m), parts = [];
  if (show.trend && state.trend) parts.push(trendLegendHTML(state.trend));
  else if (show.fire) parts.push(state.fireLegend || "");
  if (show.detections) parts.push(`<ul class="legend"><li><span class="sw key-live"></span>individual detection</li></ul>`);
  if (show.people) parts.push(popLegendHTML());
  return parts.filter(Boolean).join("");
}
function renderLegends() {
  $("grid-legend").innerHTML = legendFor(maps[0]);
  if (maps[1]) $("grid-legend-b").innerHTML = legendFor(maps[1]);
}
initLayersControl($("layers-btn"), $("layers-panel"), (id) => {
  if (id === "trend") updateTrend();
  if (id === "badges") drawExposure(expTop);
  applyLayers();
  renderLegends();
});
const inBox = (f, b) => { const [x, y] = f.geometry.coordinates; return x >= b.west && x <= b.east && y >= b.south && y <= b.north; };

function liveDown() {
  document.body.classList.add("live-down");
  state.liveGrid = null;
  refreshGrid();
  // in dev the banner names the failure; the published site keeps the plain sentence
  const why = import.meta.env.DEV && liveReason ? ` <span class="muted">(${liveReason})</span>` : "";
  $("summary").innerHTML = `<p class="notice">${LIVE_DOWN}${why}</p>`;
  for (const m of maps) if (m.getSource("live")) m.getSource("live").setData({ type: "FeatureCollection", features: [] });
  $("grid-legend").innerHTML = "";
}

async function loadLive() {
  const seq = ++live.seq;
  $("summary").innerHTML = `<p class="muted small">Loading live hotspots…</p>`;
  const ok = await liveAvailable();
  if (seq !== live.seq || state.app !== "live") return;
  if (!ok) { liveDown(); return; }
  document.body.classList.remove("live-down");
  $("summary").innerHTML = `<p class="muted small">Loading live hotspots…</p>`;
  $("dl-live").disabled = true; $("dl-status").textContent = "";
  const b = selBox();
  try {
    const got = await fetchLive([b.west, b.south, b.east, b.north], live.hours);
    if (seq !== live.seq || state.app !== "live") return;
    live.feats = got.feats.filter((f) => inBox(f, b)); // the Worker already keeps Canada only
    live.earlier = got.earlier.filter((f) => inBox(f, b));
    live.reachFrom = got.reachFrom;
    state.live = live.feats;
    renderLive();
  } catch {
    if (seq === live.seq) liveDown();
  }
}

function renderLive() {
  const d = state.d, agg = state.agg, feats = live.feats;
  for (const m of maps) if (m.getSource("live")) m.getSource("live").setData({ type: "FeatureCollection", features: feats });
  // the same ~250 km² cells as Historical, coloured with the fire ramp by hotspot count
  const counts = new Map();
  for (const f of feats) {
    const [lon, lat] = f.geometry.coordinates;
    const i = cellIndexOf(d, latLngToCell(lat, lon, 5));
    if (i !== undefined) counts.set(i, (counts.get(i) || 0) + 1);
  }
  state.liveGrid = buildLiveGrid(d, counts);
  refreshGrid();
  const n20 = feats.filter((f) => f.properties.sat !== "NOAA-21").length, n21 = feats.length - n20;
  const win = liveWindow(live.hours);
  const t = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const startMs = live.hours >= 168 ? win.start : Date.now() - live.hours * 3600e3;
  const areaTxt = agg.canadaKm2 >= 1e6 ? `${(agg.canadaKm2 / 1e6).toFixed(2)}M` : fmt(agg.canadaKm2);
  const where = state.box ? `${areaTxt} km² searched` : `all of Canada, ${areaTxt} km²`;
  const pop = d.pop ? agg.gridCells.reduce((s, i) => s + d.pop[i], 0) : 0;
  const details = [
    `<strong>${WINDOW_LABEL[live.hours][0].toUpperCase()}${WINDOW_LABEL[live.hours].slice(1)}</strong>: ${t(startMs)} – ${t(Date.now())} UTC`,
    `${where}; points outside Canada removed.`,
    `NOAA-20 ${fmt(n20)} · NOAA-21 ${fmt(n21)}`,
    pop ? `${fmtShort(pop)} people live here. <span class="muted">WorldPop 2020, modelled.</span>` : "",
    `<span class="muted">Near real time from NASA FIRMS (VIIRS): provisional and not harmonised.</span>`,
    `<span class="muted">New and continuing cells are shown only when the feed reaches back a full window before this one; FIRMS serves whole UTC days, so it often does not.</span>`,
  ].filter(Boolean).join("<br>");
  $("summary").innerHTML = `<div class="big">${fmt(feats.length)} <span class="unit">live hotspots</span>${infoIcon(details)}</div>`;
  live.meta = renderLiveChart($("livechart"), feats, live.hours, d, agg, WINDOW_LABEL[live.hours],
    { earlier: live.earlier || [], reachFrom: live.reachFrom });
  live.span = { start: startMs, end: Date.now() };
  $("dl-live").disabled = false;
  updatePop();
  renderLegends();
  renderExposure();
  if (whyCell === null) showAreaCard(); // the live answer follows each refresh
}

document.querySelectorAll('input[name="app"]').forEach((r) => r.addEventListener("change", (e) => {
  state.app = e.target.value;
  document.body.classList.toggle("mode-live", state.app === "live");
  setLiveMode($("layers-panel"), state.app === "live");
  if (state.app !== "live") { document.body.classList.remove("live-down"); live.seq++; state.live = null; }
  if (state.d) update();
  saveUrl();
}));
document.querySelectorAll('input[name="live"]').forEach((r) => r.addEventListener("change", (e) => {
  live.hours = +e.target.value;
  if (state.app === "live") loadLive();
  saveUrl();
}));

// ---- the view in the URL, so a reload or a shared link reopens the same view.
// Each setting is validated on its own: a bad one falls back to its default and the rest stand.
let urlReady = false;
function restoreFromUrl(d) {
  const u = readUrl();

  if (u.range) {
    const idx = (v) => d.monthIndex.get(+v.slice(0, 4) * 100 + +v.slice(5, 7));
    const a = idx(u.range.from), b = idx(u.range.to);
    if (a !== undefined && b !== undefined && a <= b) {
      state.range = [a, b];
      $("from").value = u.range.from;
      $("to").value = u.range.to;
    }
  }
  if (u.liveHours) {
    live.hours = u.liveHours;
    const radio = document.querySelector(`input[name="live"][value="${u.liveHours}"]`);
    if (radio) radio.checked = true;
  }
  if (u.top) view.top = u.top;
  if (u.bottom) view.bottom = u.bottom;
  fixPair(); // unknown or colliding layers fall back to fire and people
  repaintPickers();

  // With nothing drawn, the selection is all of Canada. Saved state and shared links still
  // restore whatever box they carry.
  const fresh = !location.search && !u.box && !u.range;
  if (u.box) select(u.box, false);
  else clearBox(false);

  if (u.app === "live") {
    state.app = "live";
    document.body.classList.toggle("mode-live", true);
    setLiveMode($("layers-panel"), true);
    const radio = document.querySelector('input[name="app"][value="live"]');
    if (radio) radio.checked = true;
    update();
  }
  if (u.viewMode === "compare") setView("compare");

  // the camera last, so no fit overrides it
  if (u.camera) {
    const apply = () => map.jumpTo(u.camera);
    if (map.loaded()) apply(); else map.once("load", apply);
  } else if (fresh) {
    const apply = () => fitToData();
    if (map.loaded()) apply(); else map.once("load", apply);
  }
  urlReady = true;
  saveUrl();
}
function saveUrl() {
  if (!urlReady) return;
  writeUrl(() => {
    const c = map.getCenter();
    return {
      app: state.app, box: state.box,
      from: $("from").value, to: $("to").value,
      liveHours: live.hours,
      viewMode: view.mode, top: view.top, bottom: view.bottom,
      camera: { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() },
    };
  });
}

// ---- start
initTextSize();
initInfoPanel(document.getElementById("info-btn"));
// the tour lives in the header, and its steps follow whichever mode the reader is in
{
  const tour = initTour(document.querySelector(".map-panel"), () => state.app === "live", {
    openLayers: (on) => { const panel = $("layers-panel"); panel.hidden = !on; $("layers-btn").setAttribute("aria-expanded", String(on)); },
    isCompare: () => view.mode === "compare",
    setCompare: (on) => setView(on ? "compare" : "single"),
  });
  const btn = $("tour-btn");
  btn.addEventListener("click", tour.start);
  if (!tour.seen) btn.insertAdjacentHTML("beforeend", `<span class="tour-dot" aria-hidden="true"></span>`);
}
setLiveMode($("layers-panel"), false);
attachInfoTips($("tip"));
attachTooltip($("calendar"), $("tip"), () => ({ d: state.d, agg: state.agg, mode: state.mode, colour: state.colour, cal: state.cal }));
// a month in the calendar opens the card for that month, by click or by keyboard
$("calendar").addEventListener("click", (e) => {
  const td = e.target.closest("td[data-i]");
  if (td) openWhyForMonth(Number(td.dataset.i));
});
$("calendar").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const td = e.target.closest("td[data-i]");
  if (td) { e.preventDefault(); openWhyForMonth(Number(td.dataset.i)); }
});
loadData("harmonised/")
  .then((d) => {
    state.d = d;
    const first = monthValue(d.months[0]), last = monthValue(d.lastMonth);
    for (const id of ["from", "to"]) { $(id).min = first; $(id).max = last; }
    $("from").value = first; $("to").value = last;
    state.range = [0, d.months.length - 1];
    // the data-end stamp moved to the About page; the header carries the wordmark only
    hotspotIndex().catch(() => {
      $("dl-hotspots").hidden = true;
      $("dl-status").textContent = "Hotspot download is not available on this copy of the site.";
    });
    restoreFromUrl(d); // URL, then localStorage, then defaults
    loadPlaces("harmonised/places.json").then(() => { setLivePlaceNamer(placeName); renderExposure(); }).catch(() => { $("exposure").textContent = "Place names could not be loaded."; });
  })
  .catch((err) => { $("summary").textContent = `Could not load the harmonised data (${err.message}).`; });
