// Ember burning activity calendar: years as rows, months as columns, colour = harmonised cell-days.

import { infoIcon } from "./info.js";
import { MONTHS, SOURCE_LABEL, fmt, fmtShort, fmtSig, isEstimated, median, recordedSensor, uncertaintyFactors } from "./data.js";

export const SENSOR_LABEL = { terra: "MODIS Terra", aqua: "MODIS Aqua", snpp: "VIIRS S-NPP", noaa20: "VIIRS NOAA-20", viirs: "VIIRS" };
const SENSOR_SHORT = { terra: "Terra", aqua: "Aqua", viirs: "VIIRS" };

// Fire scale: six classes in one warm family that only darkens, light orange (least) through orange,
// red-orange and red to dark red (most); no yellow. CIELAB L* falls in even steps of ~12
// (88, 76, 64, 52, 40, 28) while hue runs 62 -> 28 degrees, so the order also reads in greyscale and
// with red-green colour blindness. Zero is not a class (empty outlined cell, "no fire").
export const RAMP = ["#ffd5b8", "#ffa67d", "#fb7146", "#df4531", "#b2292a", "#7d1e23"];

// Diverging scale for "compared with normal": ratio to the median of the same month.
// Purple = below normal, orange = above, neutral grey at 1x. Both arms get stronger further from 1x.
export const RATIO_EDGES = [0.25, 0.5, 0.8, 1.25, 2, 4];
export const RATIO_COLORS = ["#c3aef0", "#8e6ccf", "#5c4887", "#4a4e57", "#8f5a2c", "#de8430", "#f8b45c"];
export const RATIO_LABELS = ["< 0.25×", "0.25–0.5×", "0.5–0.8×", "0.8–1.25×", "1.25–2×", "2–4×", "> 4×"];
export function ratioColor(v, med) {
  if (!(med > 0)) return v > 0 ? RATIO_COLORS[6] : RATIO_COLORS[3];
  const r = v / med;
  let k = 0;
  while (k < RATIO_EDGES.length && r >= RATIO_EDGES[k]) k++;
  return RATIO_COLORS[k];
}

// Six classes with log-even breaks between the smallest and largest positive value. The breaks
// are not rounded: they fall where they fall, and labels show two significant figures.
export function makeScale(values) {
  const pos = values.filter((v) => v > 0);
  if (!pos.length) return { edges: [], colors: [], color: () => "var(--zero)", label: () => "" };
  const lo = Math.max(Math.min(...pos), 0.5), hi = Math.max(...pos);
  const n = RAMP.length;
  const edges = hi > lo ? Array.from({ length: n - 1 }, (_, k) => Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * (k + 1)) / n)) : [];
  const colors = RAMP.slice(RAMP.length - edges.length - 1);
  return {
    edges, colors,
    color: (v) => {
      if (!(v > 0)) return "var(--zero)";
      let k = 0;
      while (k < edges.length && v >= edges[k]) k++;
      return colors[k];
    },
    label: (k) => (k === 0 ? "> 0" : fmtSig(edges[k - 1])),
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
      const cls = ["v", !normal && !(c.v > 0) && "zero", c.info.partial && "partial", c.info.source === "near_real_time" && "nrt",
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

// Calendar legend: a block of its own. Left, the colour bands as an even strip with the lower
// bound of each band under it, and "no fire" set apart. Right, the state keys in an aligned grid.
function keys(harm, lowConfidence) {
  const k = (sw, label) => `<li><span class="sw ${sw}"></span><span>${label}</span></li>`;
  return `<div class="lg-keys">
      <p class="lg-title">Marks</p>
      <ul class="lg-keylist">
        ${harm ? k("key-est", "estimated") : ""}
        ${k("key-partial", "partial month")}
        ${k("key-nrt", "near real time")}
        ${k("key-top", "top 3")}
        ${k("key-nodata", "no data")}
        ${k("key-out", "outside dates")}
        <li><span class="sw key-star">*</span><span>part of year</span></li>
        ${lowConfidence ? `<li><span class="badge low">low conf.</span>${infoIcon("Less than the minimum area of Canada in the box for reliable estimates of the years before 2012.")}</li>` : ""}
      </ul>
    </div>`;
}

const strip = (colors, labels, aria) => `<ol class="lg-ramp" aria-label="${aria}" style="--n:${colors.length}">
    ${colors.map((c, k) => `<li><span class="lg-band" style="background:${c}"></span><span class="lg-lab">${labels[k]}</span></li>`).join("")}</ol>`;

function renderRatioLegend(el, lowConfidence, harm, medSpan) {
  el.innerHTML = `<div class="cal-legend">
    <div class="lg-scale">
      <p class="lg-title">× median of the same month${infoIcon(`Each month divided by the median of the same calendar month over complete months ${medSpan}. 1× is a normal month for this area. Purple is below normal, grey normal, brown to orange above.`)}</p>
      ${strip(RATIO_COLORS, RATIO_LABELS.map((l) => l.replace("–", "–<wbr>")), "Ratio colour scale")}
      <p class="lg-ends"><span>below normal</span><span>above normal</span></p>
    </div>
    ${keys(harm, lowConfidence)}
  </div>`;
}

const DEFINITION = "Fire cell-days: ~1 km grid cells with at least one fire detection on a day, summed over the month. Light orange is the least fire, dark red the most. Each band starts at the number under it.";

function renderLegend(el, scale, lowConfidence, harm = true) {
  el.innerHTML = `<div class="cal-legend">
    <div class="lg-scale">
      <p class="lg-title">${harm ? "Fire cell-days per month" : "Raw fire cell-days per month"}${infoIcon(DEFINITION)}</p>
      <div class="lg-row">
        <div class="lg-zero"><span class="lg-band key-zero"></span><span class="lg-lab">no fire</span></div>
        ${strip(scale.colors, scale.colors.map((_, k) => scale.label(k)), "Colour scale")}
      </div>
    </div>
    ${keys(harm, lowConfidence)}
  </div>`;
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
