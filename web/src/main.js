import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { loadData, aggregate } from "./data.js";
import { renderCalendar, attachTooltip, fmt } from "./calendar.js";
import { renderCompare } from "./compare.js";

const FIRST_YEAR = 2012; // step 4: observed years; earlier years come next
const CANADA = { south: 41.5, north: 83.5, west: -141.5, east: -52.0 };
const STYLE = "https://tiles.openfreemap.org/styles/positron";

const $ = (id) => document.getElementById(id);
const state = { data: null, box: null, agg: null };

const map = new maplibregl.Map({
  container: "map",
  style: STYLE,
  center: [-96, 60],
  zoom: 2.4,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

const boxFeature = (b) => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]] },
});

map.on("load", () => {
  map.addSource("selection", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-color": "#2a78d6", "fill-opacity": 0.12 } });
  map.addLayer({ id: "selection-line", type: "line", source: "selection", paint: { "line-color": "#2a78d6", "line-width": 2 } });
  if (state.box) drawBox(state.box);
});

function drawBox(b) {
  const src = map.getSource("selection");
  if (src) src.setData({ type: "FeatureCollection", features: b ? [boxFeature(b)] : [] });
}

// ---- rectangle drawing
let drawing = false, start = null;
const drawBtn = $("draw");
drawBtn.addEventListener("click", () => setDrawing(!drawing));
function setDrawing(on) {
  drawing = on;
  drawBtn.setAttribute("aria-pressed", String(on));
  drawBtn.textContent = on ? "Drag on the map…" : "Draw a box";
  map.getCanvas().style.cursor = on ? "crosshair" : "";
  if (on) map.dragPan.disable(); else map.dragPan.enable();
}
const boxFrom = (a, b) => ({
  south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
  west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
});
map.on("mousedown", (e) => { if (drawing) { start = e.lngLat; e.preventDefault(); } });
map.on("mousemove", (e) => { if (drawing && start) drawBox(boxFrom(start, e.lngLat)); });
map.on("mouseup", (e) => {
  if (!drawing || !start) return;
  const b = boxFrom(start, e.lngLat);
  start = null;
  setDrawing(false);
  if (b.north - b.south < 0.05 || b.east - b.west < 0.05) { drawBox(state.box); return; }
  select(b);
});

// ---- bounds inputs
const fields = ["south", "north", "west", "east"];
$("bounds").addEventListener("submit", (e) => {
  e.preventDefault();
  const b = Object.fromEntries(fields.map((f) => [f, parseFloat($(f).value)]));
  const err = !fields.every((f) => Number.isFinite(b[f])) ? "Enter all four bounds."
    : b.south < -90 || b.north > 90 || b.south >= b.north ? "South must be below north, within −90 to 90."
    : b.west < -180 || b.east > 180 || b.west >= b.east ? "West must be less than east, within −180 to 180."
    : "";
  $("bounds-error").textContent = err;
  if (!err) select(b);
});
$("all-canada").addEventListener("click", () => select(CANADA));

function round(v) { return Math.round(v * 100) / 100; }

function select(b) {
  state.box = b;
  fields.forEach((f) => { $(f).value = round(b[f]); });
  drawBox(b);
  if (state.data) update();
}

function update() {
  const d = state.data;
  const agg = (state.agg = aggregate(d, state.box));
  const lastYear = d.months[d.months.length - 1].y;
  const medianYears = [];
  for (let y = FIRST_YEAR; y < lastYear; y++) medianYears.push(y);

  const total = agg.totals.reduce((s, v, i) => s + (d.months[i].y >= FIRST_YEAR ? v : 0), 0);
  $("summary").innerHTML = agg.cells.length
    ? `<strong>${fmt(agg.areaKm2)} km²</strong> selected · ${agg.cells.length.toLocaleString("en-CA")} grid cells with fire
       since 2000 · ${fmt(total)} fire cell-days ${FIRST_YEAR}–${lastYear}`
    : `<strong>${fmt(agg.areaKm2)} km²</strong> selected · no fire recorded here. Data cover Canada only.`;

  const cal = renderCalendar($("calendar"), d, agg, { firstYear: FIRST_YEAR, medianYears, legendEl: $("legend") });
  renderCompare($("compare"), d, agg, { medianYears, yearTotals: cal.yearTotals });
  $("results").hidden = false;
}

// ---- start
attachTooltip($("calendar"), $("tip"), { get months() { return state.data.months; } }, () => state.agg);
loadData("harmonised/")
  .then((d) => {
    state.data = d;
    const last = d.months[d.months.length - 1];
    $("data-end").textContent = `Data to ${last.days && Math.max(...Object.values(last.days))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][last.m - 1]} ${last.y}`;
    select(state.box || CANADA);
  })
  .catch((err) => {
    $("summary").textContent = `Could not load the harmonised data (${err.message}).`;
  });
