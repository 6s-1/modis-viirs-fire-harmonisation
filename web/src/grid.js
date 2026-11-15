// The fire grid: display cells (~250 km²) coloured with the fire ramp. In Historical it holds
// harmonised cell-days for the date range; in Live, near-real-time hotspot counts per cell.
// The features are built once and drawn on every map (one globe, or two in compare).

import { cellToBoundary, cellToParent } from "h3-js";
import { cellValues, fmt, h3Id } from "./data.js";
import { makeScale } from "./calendar.js";
import { infoIcon } from "./info.js";

const NONE = "rgba(0,0,0,0)"; // no fire: outline only

export function addGridLayers(map) {
  map.addSource("grid", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "grid-fill", type: "fill", source: "grid",
    paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "zero"], 0, 0.9] } }, "selection-fill");
  map.addLayer({ id: "grid-line", type: "line", source: "grid",
    paint: { "line-color": "#2a2e38", "line-width": 0.5, "line-opacity": 0.7 } }, "selection-fill");
  map.addLayer({ id: "grid-est", type: "line", source: "grid", filter: ["==", ["get", "est"], true],
    paint: { "line-color": "#f0efec", "line-width": 0.9, "line-dasharray": [2, 2], "line-opacity": 0.55 } }, "selection-fill");
}

const cellFeature = (d, i, props) => ({ type: "Feature", properties: { i, ...props },
  geometry: { type: "Polygon", coordinates: [cellToBoundary(h3Id(d, i), true)] } });

// Historical: harmonised cell-days per cell over the date range.
// coarse: roll the display cells up to their H3 parents (res 4, ~7x fewer, ~1,770 km2 each).
// Two synchronised globes draw twice the geometry, so compare uses the coarse grid.
export function buildGrid(d, agg, range, { coarse = false } = {}) {
  const vals = cellValues(d, agg.gridCells.filter((i) => d.canada[i] || d.rowStart[i + 1] > d.rowStart[i]), range);
  if (!coarse) {
    const scale = makeScale(vals.map((c) => c.v));
    const features = vals.map(({ i, v, est }) =>
      cellFeature(d, i, { v, est: est && v > 0, zero: !(v > 0), color: v > 0 ? scale.color(v) : NONE }));
    return { features, scale, n: features.length, unit: "cell-days", coarse: false };
  }
  const roll = new Map();
  for (const { i, v, est } of vals) {
    const parent = cellToParent(h3Id(d, i), 4);
    const cur = roll.get(parent);
    if (cur) { cur.v += v; cur.est = cur.est || est; } else roll.set(parent, { v, est });
  }
  const scale = makeScale([...roll.values()].map((c) => c.v));
  const features = [...roll].map(([id, { v, est }]) => ({ type: "Feature",
    properties: { v, est: est && v > 0, zero: !(v > 0), color: v > 0 ? scale.color(v) : NONE },
    geometry: { type: "Polygon", coordinates: [cellToBoundary(id, true)] } }));
  return { features, scale, n: features.length, unit: "cell-days", coarse: true };
}

// Live: hotspot counts per cell. counts is a Map of cell index -> hotspots.
export function buildLiveGrid(d, counts) {
  const scale = makeScale([...counts.values()], { integer: true });
  const features = [...counts].map(([i, v]) => cellFeature(d, i, { v, est: false, zero: false, color: scale.color(v) }));
  return { features, scale, n: features.length, unit: "hotspots" };
}

export function setGrid(map, features) {
  const src = map.getSource("grid");
  if (src) src.setData({ type: "FeatureCollection", features });
}

export function gridLegendHTML(scale, { rangeLabel, live = false, windowLabel = "", coarse = false }) {
  const sw = scale.colors.map((c, k) => `<li><span class="sw" style="background:${c}"></span>${scale.label(k)}</li>`).join("");
  if (live) {
    return `<p class="legend-title">Hotspots per cell <span class="live-tag">near real time</span>${infoIcon(`Live VIIRS hotspots counted per ~250 km² grid cell, ${windowLabel}. Not harmonised: hotspot counts, not cell-days.<br>Colours are relative to the current selection.`)}</p>
      <ul class="legend">${sw}</ul>`;
  }
  return `<ul class="legend"><li class="nofire"><span class="sw key-zero"></span>no fire</li>${sw}
      <li><span class="sw key-est"></span>estimated</li>
      <li>${infoIcon(`Fire cell-days per ~${coarse ? "1,770" : "250"} km² grid cell, ${rangeLabel}.${coarse ? "<br>Cells are grouped into larger ones while two globes are shown, so both stay smooth." : ""}<br>Colours are relative to the current selection and date range.<br><span class="muted">Dashed outline: includes months estimated from MODIS.</span>`)}</li></ul>`;
}

export function attachGridHover(map, tip, getInfo) {
  map.on("mousemove", "grid-fill", (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties, { unit, label } = getInfo();
    const est = p.est === true || p.est === "true";
    if (p.zero === true || p.zero === "true") { tip.hidden = true; return; }
    tip.innerHTML = `<strong>${fmt(+p.v)}</strong> ${unit === "hotspots" ? "hotspots" : "fire cell-days"}<br><span class="muted">${label}${est ? " · includes estimated months" : ""}</span>`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.originalEvent.clientX + 14, innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.min(e.originalEvent.clientY + 14, innerHeight - r.height - 8)}px`;
  });
  map.on("mouseleave", "grid-fill", () => { tip.hidden = true; });
}
