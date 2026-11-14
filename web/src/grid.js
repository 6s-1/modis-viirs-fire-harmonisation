// Display-grid cells inside the selection, coloured by harmonised cell-days for the date range.

import { cellToBoundary } from "h3-js";
import { cellValues, fmt, h3Id } from "./data.js";
import { makeScale } from "./calendar.js";

const ZERO = { light: "rgba(0,0,0,0)", dark: "rgba(0,0,0,0)" }; // no fire: outline only
const dark = () => true; // the app uses a dark space theme

export function addGridLayers(map) {
  map.addSource("grid", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "grid-fill", type: "fill", source: "grid",
    paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "zero"], 0, 0.9] } }, "selection-fill");
  map.addLayer({ id: "grid-line", type: "line", source: "grid",
    paint: { "line-color": "#2a2e38", "line-width": 0.5, "line-opacity": 0.7 } }, "selection-fill");
  map.addLayer({ id: "grid-est", type: "line", source: "grid", filter: ["==", ["get", "est"], true],
    paint: { "line-color": dark() ? "#f0efec" : "#0b0b0b", "line-width": 0.9, "line-dasharray": [2, 2], "line-opacity": 0.55 } }, "selection-fill");
}

// Returns the colour scale used, for the legend.
export function updateGrid(map, d, agg, range) {
  const vals = cellValues(d, agg.gridCells.filter((i) => d.canada[i] || d.rowStart[i + 1] > d.rowStart[i]), range);
  const scale = makeScale(vals.map((c) => c.v));
  const zero = dark() ? ZERO.dark : ZERO.light;
  const features = vals.map(({ i, v, est }) => {
    const ring = cellToBoundary(h3Id(d, i), true);
    return { type: "Feature", properties: { v, est: est && v > 0, zero: !(v > 0), color: v > 0 ? scale.color(v) : zero },
      geometry: { type: "Polygon", coordinates: [ring] } };
  });
  const src = map.getSource("grid");
  if (src) src.setData({ type: "FeatureCollection", features });
  return { scale, n: features.length, withFire: vals.filter((c) => c.v > 0).length };
}

export function gridLegend(el, scale, rangeLabel) {
  const sw = scale.colors.map((c, k) => `<li><span class="sw" style="background:${c}"></span>${k === 0 ? "> 0" : fmt(scale.edges[k - 1])}</li>`).join("");
  el.innerHTML = `<p class="legend-title"><span class="info" title="Harmonised fire cell-days per grid cell (~250 km²) over ${rangeLabel}. Brighter (yellow) means more fire.">Grid · ${rangeLabel}</span></p>
    <ul class="legend"><li><span class="sw key-zero"></span>0</li>${sw}
      <li title="Includes months estimated from MODIS"><span class="sw key-est"></span>estimated</li></ul>`;
}

export function attachGridHover(map, tip, getRangeLabel) {
  map.on("mousemove", "grid-fill", (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties;
    const est = p.est === true || p.est === "true";
    tip.innerHTML = `<strong>${fmt(+p.v)}</strong> fire cell-days<br><span class="muted">${getRangeLabel()}${est ? " · includes estimated months" : ""}</span>`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.originalEvent.clientX + 14, innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.min(e.originalEvent.clientY + 14, innerHeight - r.height - 8)}px`;
  });
  map.on("mouseleave", "grid-fill", () => { tip.hidden = true; });
}
