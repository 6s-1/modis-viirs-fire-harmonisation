import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { MONTHS, aggregate, fmt, loadData, monthDays } from "./data.js";
import { attachTooltip, renderCalendar } from "./calendar.js";
import { renderCompare } from "./compare.js";
import { calendarPNG, fileStem, hotspotIndex, hotspotPlan, hotspotsCSV, monthlyCSV, saveBlob } from "./downloads.js";

const OBSERVED_FROM = 2012;
const CANADA = { south: 41.5, north: 83.5, west: -141.5, east: -52.0 };
const STYLE = "https://tiles.openfreemap.org/styles/positron";

const $ = (id) => document.getElementById(id);
const state = { d: null, box: null, agg: null, cal: null, range: null, observedOnly: false };

// ---- map: north up, no rotation or pitch, starts fitted to Canada
const map = new maplibregl.Map({
  container: "map",
  style: STYLE,
  bounds: [[CANADA.west, 41.5], [CANADA.east, 72]],
  fitBoundsOptions: { padding: 20 },
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

const boxFeature = (b) => ({
  type: "Feature", properties: {},
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
  select(b);
});

// ---- bounds inputs
const fields = ["south", "north", "west", "east"];
$("bounds").addEventListener("submit", (e) => {
  e.preventDefault();
  const b = Object.fromEntries(fields.map((f) => [f, parseFloat($(f).value)]));
  const err = !fields.every((f) => Number.isFinite(b[f])) ? "Enter all four bounds."
    : b.south < -90 || b.north > 90 || b.south >= b.north ? "South must be below north, within −90 to 90."
    : b.west < -180 || b.east > 180 || b.west >= b.east ? "West must be less than east, within −180 to 180." : "";
  $("bounds-error").textContent = err;
  if (!err) select(b);
});
$("all-canada").addEventListener("click", () => select(CANADA));
function select(b) {
  state.box = b;
  fields.forEach((f) => { $(f).value = Math.round(b[f] * 100) / 100; });
  drawBox(b);
  if (state.d) update();
}

// ---- date range and toggle
const monthValue = (info) => `${info.y}-${String(info.m).padStart(2, "0")}`;
function readRange() {
  const d = state.d, idx = (v) => d.monthIndex.get(+v.slice(0, 4) * 100 + +v.slice(5, 7));
  let a = idx($("from").value), b = idx($("to").value);
  const msg = a === undefined || b === undefined ? `Choose months between ${monthValue(d.months[0])} and ${monthValue(d.lastMonth)}.`
    : a > b ? "The start month must be before the end month." : "";
  $("range-error").textContent = msg;
  if (msg) return false;
  state.range = [a, b];
  return true;
}
["from", "to"].forEach((id) => $(id).addEventListener("change", () => { if (readRange()) update(); }));
$("observed-only").addEventListener("change", (e) => { state.observedOnly = e.target.checked; update(); });

function update() {
  const d = state.d;
  const agg = (state.agg = aggregate(d, state.box));
  const firstYear = state.observedOnly ? OBSERVED_FROM : d.firstYear;
  const years = [];
  for (let y = d.lastYear; y >= firstYear; y--) years.push(y);
  const yearFilter = (y) => !state.observedOnly || y >= OBSERVED_FROM;
  const medianYears = years.filter((y) => y < d.lastYear);
  const minArea = d.manifest.uncertainty.low_confidence_below_km2;
  const lowConfidence = agg.areaKm2 < minArea;

  const [a, b] = state.range;
  let total = 0;
  for (let i = a; i <= b; i++) total += agg.totals[i];
  const rangeTxt = `${MONTHS[d.months[a].m - 1]} ${d.months[a].y} – ${MONTHS[d.months[b].m - 1]} ${d.months[b].y}`;
  $("summary").innerHTML = `<div><span class="muted">Selection box area</span> <strong>${fmt(agg.areaKm2)} km²</strong>${lowConfidence ? ` <span class="badge low">below ${fmt(minArea)} km²: estimates low confidence</span>` : ""}</div>
    <div>${agg.cells.length ? `${agg.cells.length.toLocaleString("en-CA")} grid cells with fire · <strong>${fmt(total)}</strong> fire cell-days, ${rangeTxt}`
      : "No fire recorded in this box. Harmonised history is available for Canada in this version."}</div>`;

  state.cal = renderCalendar($("calendar"), d, agg, { years, medianYears, range: state.range, lowConfidence, legendEl: $("legend") });
  renderCompare($("compare"), d, agg, { yearFilter, totals: state.cal.totals });
  $("results").hidden = false;
  $("dl-status").textContent = "";
}

// ---- downloads
$("dl-monthly").addEventListener("click", () => {
  saveBlob(monthlyCSV(state.d, state.agg, state.range), `fire-cell-days_${fileStem(state.box, state.d, state.range)}.csv`);
});
$("dl-png").addEventListener("click", async () => {
  const d = state.d, b = state.box;
  const years = state.cal.totals.map((t) => t.y);
  const blob = await calendarPNG(d, state.agg, state.cal, {
    years, lowConfidence: state.agg.areaKm2 < d.manifest.uncertainty.low_confidence_below_km2,
    title: "Burning activity calendar",
    subtitle: `Box S ${b.south.toFixed(2)}, N ${b.north.toFixed(2)}, W ${b.west.toFixed(2)}, E ${b.east.toFixed(2)} · selection box area ${fmt(state.agg.areaKm2)} km²`,
  });
  saveBlob(blob, `fire-calendar_${fileStem(b, d, [0, d.months.length - 1])}.png`);
});
$("dl-hotspots").addEventListener("click", async () => {
  const st = $("dl-status");
  const btn = $("dl-hotspots");
  try {
    btn.disabled = true;
    const plan = await hotspotPlan(state.box, state.d, state.range);
    if (!plan.tiles.length) { st.textContent = "No hotspots in this box and date range."; return; }
    if (plan.tooBig) {
      st.textContent = `This would read up to ${fmt(plan.rows)} hotspots. Narrow the box or the date range (limit 1.5 million).`;
      return;
    }
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
attachTooltip($("calendar"), $("tip"), () => ({ d: state.d, agg: state.agg }));
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
    select(state.box || CANADA);
  })
  .catch((err) => { $("summary").textContent = `Could not load the harmonised data (${err.message}).`; });
