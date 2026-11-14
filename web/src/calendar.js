// Burning activity calendar: years as rows, months as columns, colour = harmonised cell-days.

import { MONTHS, SOURCE_LABEL, fmt, fmtShort, isEstimated, median, recordedSensor, uncertaintyFactors } from "./data.js";

export const SENSOR_LABEL = { terra: "MODIS Terra", aqua: "MODIS Aqua", snpp: "VIIRS S-NPP", noaa20: "VIIRS NOAA-20", viirs: "VIIRS" };
const SENSOR_SHORT = { terra: "Terra", aqua: "Aqua", viirs: "VIIRS" };

// cividis without its darkest step; brighter (yellow) = more fire, in light and dark themes
export const RAMP = ["#213b6e", "#4c556c", "#6c6e72", "#8e8978", "#b1a570", "#d9c55c", "#fee838"];

function nice(v) {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

// Diverging scale for "compared with normal": ratio to the median of the same month.
// Built from colours already in the app: accent blues below, the cividis yellows above, neutral
// grey at 1x. Both arms get brighter the further they are from normal.
export const RATIO_EDGES = [0.25, 0.5, 0.8, 1.25, 2, 4];
export const RATIO_COLORS = ["#86b6ef", "#3f8ce8", "#2b4f80", "#3a3e47", "#8e8978", "#d9c55c", "#fee838"];
export const RATIO_LABELS = ["< 0.25×", "0.25–0.5×", "0.5–0.8×", "0.8–1.25×", "1.25–2×", "2–4×", "> 4×"];
export function ratioColor(v, med) {
  if (!(med > 0)) return v > 0 ? RATIO_COLORS[6] : RATIO_COLORS[3];
  const r = v / med;
  let k = 0;
  while (k < RATIO_EDGES.length && r >= RATIO_EDGES[k]) k++;
  return RATIO_COLORS[k];
}

// Log-spaced bins between the smallest and largest positive value.
export function makeScale(values) {
  const pos = values.filter((v) => v > 0);
  if (!pos.length) return { edges: [], colors: RAMP.slice(0, 1), color: () => "var(--zero)" };
  const lo = Math.max(Math.min(...pos), 0.5), hi = Math.max(...pos);
  const n = RAMP.length;
  let edges = [];
  for (let k = 1; k < n; k++) edges.push(nice(Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * k / n)));
  edges = [...new Set(edges)].filter((e) => e > 0 && e < hi);
  const colors = RAMP.slice(RAMP.length - edges.length - 1);
  return {
    edges, colors,
    color: (v) => {
      if (!(v > 0)) return "var(--zero)";
      let k = 0;
      while (k < edges.length && v >= edges[k]) k++;
      return colors[k];
    },
  };
}

// Year totals with the uncertainty range of their estimated part.
export function yearTotals(d, agg, years, values = agg.totals, mode = "harmonised") {
  return years.map((y) => {
    let s = 0, any = false, partial = false, lo = 0, hi = 0, est = false, nMonths = 0, nEst = 0;
    const bySource = {}, estMonths = [];
    for (let m = 1; m <= 12; m++) {
      const i = d.monthIndex.get(y * 100 + m);
      if (i === undefined) continue;
      any = true;
      const info = d.months[i], v = values[i];
      nMonths++;
      if (mode === "harmonised" && isEstimated(info.source)) { nEst++; estMonths.push(m); }
      s += v;
      if (info.partial) partial = true;
      bySource[info.source] = (bySource[info.source] || 0) + v;
    }
    for (const [src, v] of Object.entries(bySource)) {
      const q = mode === "harmonised" ? uncertaintyFactors(d, agg.areaKm2, "year", src) : null;
      if (q) { est = true; lo += v * q[0]; hi += v * q[2]; } else { lo += v; hi += v; }
    }
    const complete = d.monthIndex.has(y * 100 + 1) && d.monthIndex.has(y * 100 + 12) && !partial;
    const estLabel = !est ? "" : nEst === nMonths ? "est." : `${estMonths.map((m) => MONTHS[m - 1]).join(", ")} est.`;
    const sensors = [...new Set(Object.keys(bySource).map((src) => SENSOR_SHORT[recordedSensor({ source: src })]))].join(" + ");
    return { y, s: any ? s : NaN, lo, hi, est, estLabel, sensors, partial: !complete };
  });
}

export function renderCalendar(el, d, agg, opts) {
  const { years, medianYears, range, lowConfidence, legendEl, mode = "harmonised", colour = "activity" } = opts;
  const values = opts.values || agg.totals;
  const harm = mode === "harmonised";
  const cell = (y, m) => {
    const i = d.monthIndex.get(y * 100 + m);
    return i === undefined ? null : { i, v: values[i], info: d.months[i] };
  };
  const shown = [];
  for (const y of years) for (let m = 1; m <= 12; m++) { const c = cell(y, m); if (c) shown.push(c); }
  const scale = makeScale(shown.map((c) => c.v));
  const top = new Set([...shown].filter((c) => c.v > 0).sort((a, b) => b.v - a.v).slice(0, 3).map((c) => c.i));
  const totals = yearTotals(d, agg, years, values, mode);
  const maxYear = Math.max(...totals.map((t) => t.s).filter(Number.isFinite), 1);
  const medYearsUsed = new Set();
  const monthMedians = MONTHS.map((_, k) => median(medianYears.map((y) => {
    const c = cell(y, k + 1);
    if (!c || c.info.partial) return NaN;
    medYearsUsed.add(y);
    return c.v;
  })));
  const medSpan = medYearsUsed.size ? `${Math.min(...medYearsUsed)}–${Math.max(...medYearsUsed)}` : "";
  const normal = colour === "normal";
  const fill = (c) => (normal ? ratioColor(c.v, monthMedians[c.info.m - 1]) : scale.color(c.v));

  let html = `<table class="cal" aria-label="Fire cell-days per month for the selected area">
    <thead><tr><th scope="col">Year</th>${MONTHS.map((m, k) => `<th scope="col" data-month="${k + 1}">${m}</th>`).join("")}
    <th scope="col" class="tot">Year total</th></tr></thead><tbody>`;
  for (const t of totals) {
    const badge = !harm ? `<span class="badge">${t.sensors}</span>`
      : t.est ? `<span class="badge${lowConfidence ? " low" : ""}">${t.estLabel}${lowConfidence ? " · low conf." : ""}</span>` : "";
    html += `<tr class="${t.est ? "est-row" : ""}"><th scope="row">${t.y}${badge}</th>`;
    for (let m = 1; m <= 12; m++) {
      const c = cell(t.y, m);
      if (!c) { html += `<td class="nodata" aria-label="${MONTHS[m - 1]} ${t.y}: no data">–</td>`; continue; }
      const out = c.i < range[0] || c.i > range[1];
      const cls = ["v", c.info.partial && "partial", c.info.source === "near_real_time" && "nrt",
        harm && isEstimated(c.info.source) && "est", top.has(c.i) && "top", out && "out"].filter(Boolean).join(" ");
      const label = `${MONTHS[m - 1]} ${t.y}: ${fmt(c.v)} cell-days, ${harm ? SOURCE_LABEL[c.info.source] : `raw ${SENSOR_LABEL[recordedSensor(c.info)]}`}` +
        (c.info.partial ? ", partial month" : "") +
        (normal && monthMedians[m - 1] > 0 ? `, ${(c.v / monthMedians[m - 1]).toFixed(2)} times the median` : "");
      html += `<td class="${cls}" style="--c:${fill(c)}" data-i="${c.i}" tabindex="0" aria-label="${label}"></td>`;
    }
    const w = Number.isFinite(t.s) ? (100 * t.s) / maxYear : 0;
    const rangeTxt = t.est && t.s > 0 && t.hi - t.lo > 0.01 * t.s ? ` <span class="rng" title="Likely range ${fmt(t.lo)}–${fmt(t.hi)}">(${fmtShort(t.lo)}–${fmtShort(t.hi)})</span>` : "";
    html += `<td class="tot"><div class="bar" style="width:${w}%"></div><span>${fmt(t.s)}${t.partial ? "*" : ""}${rangeTxt}</span></td></tr>`;
  }
  html += `</tbody><tfoot><tr><th scope="row">Median</th>
    ${monthMedians.map((v) => `<td class="med">${fmt(v)}</td>`).join("")}<td class="tot" title="Median of complete months">${medSpan}</td></tr></tfoot></table>`;
  el.innerHTML = html;
  if (normal) renderRatioLegend(legendEl, harm && lowConfidence, harm, medSpan);
  else renderLegend(legendEl, scale, harm && lowConfidence, harm);
  return { scale, totals, monthMedians, medSpan };
}

function marks(harm, lowConfidence) {
  return `<ul class="legend keys">
      ${harm ? `<li title="Estimated from MODIS before VIIRS (2012); the year total shows the likely range"><span class="sw key-est"></span>estimated</li>` : ""}
      <li><span class="sw key-partial"></span>partial month</li>
      <li title="Provisional near-real-time data"><span class="sw key-nrt"></span>near real time</li>
      <li><span class="sw key-top"></span>top 3</li>
      <li><span class="sw key-nodata">–</span>no data</li>
      <li><span class="sw key-out"></span>outside date range</li>
      <li>* part of year</li>
      ${lowConfidence ? `<li title="Less than the minimum area of Canada in the box for reliable estimates"><span class="badge low">low conf.</span></li>` : ""}
    </ul>`;
}

function renderRatioLegend(el, lowConfidence, harm, medSpan) {
  el.innerHTML = `<p class="legend-title"><span class="info" title="Each month divided by the median of the same calendar month over complete months ${medSpan}. 1× = a normal month for this area.">Compared with normal · × median of the same month, ${medSpan}</span></p>
    <ul class="legend" aria-label="Ratio colour scale">${RATIO_COLORS.map((c, k) => `<li><span class="sw" style="background:${c}"></span>${RATIO_LABELS[k]}</li>`).join("")}</ul>
    ${marks(harm, lowConfidence)}`;
}

const DEFINITION = "Fire cell-days: ~1 km grid cells with at least one fire detection on a day, summed over the month. Brighter (yellow) means more fire.";

function renderLegend(el, scale, lowConfidence, harm = true) {
  const sw = scale.colors.map((c, k) => `<li><span class="sw" style="background:${c}"></span>${k === 0 ? "> 0" : fmt(scale.edges[k - 1])}</li>`).join("");
  el.innerHTML = `<p class="legend-title"><span class="info" title="${DEFINITION}">${harm ? "Fire cell-days per month" : "Raw fire cell-days per month"}</span></p>
    <ul class="legend" aria-label="Colour scale"><li><span class="sw" style="background:var(--zero)"></span>0</li>${sw}</ul>
    ${marks(harm, lowConfidence)}`;
}

export function attachTooltip(host, tip, getState) {
  const show = (td, x, y) => {
    const { d, agg, mode, colour, cal } = getState();
    const i = Number(td.dataset.i), info = d.months[i];
    let body;
    if (mode === "raw") {
      const rows = ["terra", "aqua", "snpp", "noaa20"].map((p) => [p, agg.rawOf(p)[i]])
        .filter(([p]) => (info.days || {})[p]).map(([p, v]) => `${SENSOR_LABEL[p]}: ${fmt(v)}`);
      body = `Raw, no conversion<br>${rows.join("<br>")}<br><span class="muted">calendar shows ${SENSOR_LABEL[recordedSensor(info)]}</span>`;
    } else {
      const v = agg.totals[i];
      const q = uncertaintyFactors(d, agg.areaKm2, "month", info.source);
      const rng = q && v > 0 ? ` <span class="muted">(${fmt(v * q[0])}–${fmt(v * q[2])})</span>` : "";
      const med = cal && cal.monthMedians ? cal.monthMedians[info.m - 1] : NaN;
      const vs = colour === "normal" ? `<br>${med > 0 ? `${(v / med).toFixed(2)}×` : "–"} median ${cal.medSpan} (${fmt(med)})` : "";
      body = `${fmt(v)}${rng} fire cell-days${vs}<br><span class="muted">${SOURCE_LABEL[info.source]}${info.partial ? " · partial month" : ""}</span>`;
    }
    tip.innerHTML = `<strong>${MONTHS[info.m - 1]} ${info.y}</strong><br>${body}`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(x + 14, innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.min(y + 14, innerHeight - r.height - 8)}px`;
  };
  host.addEventListener("mousemove", (e) => {
    const td = e.target.closest("td[data-i]");
    if (!td) { tip.hidden = true; return; }
    show(td, e.clientX, e.clientY);
  });
  host.addEventListener("mouseleave", () => { tip.hidden = true; });
  host.addEventListener("focusin", (e) => {
    const td = e.target.closest("td[data-i]");
    if (td) { const r = td.getBoundingClientRect(); show(td, r.right, r.top); }
  });
  host.addEventListener("focusout", () => { tip.hidden = true; });
}
