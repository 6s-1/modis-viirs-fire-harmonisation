// "Where fire is changing": a slope per grid cell over the selected date range.
//
// Each cell's yearly totals within the range are fitted with a Theil-Sen slope and tested with
// Mann-Kendall. Cells that fail the test keep a pale colour; cells that pass are coloured by the
// direction and size of their slope. Diverging scale: red arm rising, blue arm falling, neutral
// grey where there is no clear change. The test needs whole years, so the range is trimmed to the
// complete calendar years inside it.

import { cellToBoundary } from "h3-js";
import { fmt, h3Id } from "./data.js";
import { mannKendall, theilSen } from "./compare.js";
import { infoIcon } from "./info.js";

const MIN_YEARS = 8;      // fewer complete years than this and the map is not drawn
const MIN_TOTAL = 20;     // a cell needs this many cell-days over the period to be worth testing
const P_MAX = 0.1;        // cells above this p-value are "no clear change"

// Diverging: red rising, grey no clear change, blue falling. Arms are symmetric in lightness
// (CIELAB L* 58 / 72 / 88 / 72 / 58) so neither direction reads as louder than the other.
export const TREND_COLORS = { up2: "#e75f5d", up1: "#f8968a", flat: "#dcdcdc", down1: "#69b9eb", down2: "#0994d2" };
const WEAK = "rgba(220,220,220,0.45)"; // tested but not significant

export function addTrendLayers(map) {
  map.addSource("trend", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "trend-fill", type: "fill", source: "trend", layout: { visibility: "none" },
    paint: { "fill-color": ["get", "color"], "fill-opacity": 0.92 } }, "selection-fill");
  map.addLayer({ id: "trend-line", type: "line", source: "trend", layout: { visibility: "none" },
    paint: { "line-color": "#2a2e38", "line-width": 0.4, "line-opacity": 0.5 } }, "selection-fill");
}

// Complete calendar years inside the selected month range.
function wholeYears(d, range) {
  const [a, b] = range, out = [];
  for (let y = d.months[a].y; y <= d.months[b].y; y++) {
    let months = 0, partial = false;
    for (let m = 1; m <= 12; m++) {
      const i = d.monthIndex.get(y * 100 + m);
      if (i === undefined || i < a || i > b) continue;
      months++;
      if (d.months[i].partial) partial = true;
    }
    if (months === 12 && !partial) out.push(y);
  }
  return out;
}

export function buildTrend(d, agg, range) {
  const years = wholeYears(d, range);
  if (years.length < MIN_YEARS) return { features: [], years, enough: false, n: 0, up: 0, down: 0 };
  // month index -> position in years, so each cell is walked once
  const slot = new Map();
  years.forEach((y, k) => { for (let m = 1; m <= 12; m++) { const i = d.monthIndex.get(y * 100 + m); if (i !== undefined) slot.set(i, k); } });

  const features = [];
  let up = 0, down = 0, tested = 0;
  for (const i of agg.gridCells) {
    const sums = new Float64Array(years.length);
    let total = 0;
    for (let r = d.rowStart[i]; r < d.rowStart[i + 1]; r++) {
      const k = slot.get(d.rowMonth[r]);
      if (k === undefined) continue;
      sums[k] += d.rowValue[r];
      total += d.rowValue[r];
    }
    if (total < MIN_TOTAL) continue;
    tested++;
    const vs = Array.from(sums);
    const mk = mannKendall(vs);
    const fit = theilSen(years, vs, mk.varS);
    const sig = mk.p <= P_MAX && fit.b !== 0;
    const mean = total / years.length;
    const rel = mean > 0 ? fit.b / mean : 0; // slope as a share of the cell's own typical year
    let color = WEAK;
    if (sig && fit.b > 0) { color = Math.abs(rel) >= 0.1 ? TREND_COLORS.up2 : TREND_COLORS.up1; up++; }
    else if (sig && fit.b < 0) { color = Math.abs(rel) >= 0.1 ? TREND_COLORS.down2 : TREND_COLORS.down1; down++; }
    features.push({ type: "Feature",
      properties: { i, color, slope: fit.b, rel, p: mk.p, sig, mean },
      geometry: { type: "Polygon", coordinates: [cellToBoundary(h3Id(d, i), true)] } });
  }
  return { features, years, enough: true, n: tested, up, down };
}

export function setTrend(map, features) {
  const src = map.getSource("trend");
  if (src) src.setData({ type: "FeatureCollection", features });
}

export function trendLegendHTML(t) {
  const period = t.years.length ? `${t.years[0]}–${t.years[t.years.length - 1]}` : "";
  if (!t.enough) {
    return `<p class="legend-title">Where fire is changing${infoIcon(`A trend needs at least ${MIN_YEARS} complete calendar years in the date range. Widen the range to see it.`)}</p>
      <p class="legend-note">Needs ${MIN_YEARS}+ complete years; the range has ${t.years.length}.</p>`;
  }
  const sw = (c, label) => `<li><span class="sw" style="background:${c}"></span>${label}</li>`;
  return `<p class="legend-title">Where fire is changing, ${period}${infoIcon(`Each cell's yearly fire cell-days over ${period} fitted with a Theil–Sen slope and tested with Mann–Kendall.<br>
    Cells are coloured only where the trend is statistically significant (p ≤ ${P_MAX}); the rest are pale.<br>
    Strong means the slope is at least 10% of that cell's own typical year.<br><span class="muted">Cells with under ${MIN_TOTAL} cell-days over the period are left out.</span>`)}</p>
    <ul class="legend">
      ${sw(TREND_COLORS.up2, "rising, strong")}${sw(TREND_COLORS.up1, "rising")}
      ${sw(WEAK, "no clear change")}
      ${sw(TREND_COLORS.down1, "falling")}${sw(TREND_COLORS.down2, "falling, strong")}
    </ul>`;
}

export function attachTrendHover(map, tip, getYears) {
  map.on("mousemove", "trend-fill", (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties, years = getYears();
    const dir = p.slope > 0 ? "more" : "less";
    const pct = Math.abs(p.rel * 100);
    tip.innerHTML = p.sig === true || p.sig === "true"
      ? `<strong>${fmt(Math.abs(p.slope))}</strong> cell-days a year ${dir}<br>
         <span class="muted">${pct >= 1 ? `${pct.toFixed(0)}% of a typical year here` : "a small share of a typical year here"} · ${years}</span>`
      : `<strong>No clear change</strong><br><span class="muted">typical year ${fmt(p.mean)} cell-days · ${years}</span>`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.originalEvent.clientX + 14, innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.min(e.originalEvent.clientY + 14, innerHeight - r.height - 8)}px`;
  });
  map.on("mouseleave", "trend-fill", () => { tip.hidden = true; });
}
