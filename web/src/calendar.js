// Burning activity calendar: years as rows, months as columns, colour = harmonised cell-days.

import { median } from "./data.js";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CIVIDIS = ["#00224e", "#213b6e", "#4c556c", "#6c6e72", "#8e8978", "#b1a570", "#d9c55c", "#fee838"];

function ramp() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  // Light: darker = more, without the brightest yellow (it reads as more salient than mid values).
  // Dark: lighter = more, without the darkest blue (it disappears into the background).
  return dark ? CIVIDIS.slice(1) : CIVIDIS.slice(0, -1).reverse();
}

function nice(v) {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

// Log-spaced bin edges between the smallest and largest positive monthly value.
export function makeScale(values) {
  const pos = values.filter((v) => v > 0);
  const colors = ramp();
  if (!pos.length) return { edges: [], colors, color: () => "var(--zero)" };
  const lo = Math.max(Math.min(...pos), 0.5), hi = Math.max(...pos);
  const n = colors.length;
  let edges = [];
  for (let k = 1; k < n; k++) edges.push(nice(Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * k / n)));
  edges = [...new Set(edges)].filter((e) => e > 0 && e < hi);
  const used = colors.slice(colors.length - edges.length - 1);
  return {
    edges,
    colors: used,
    color: (v) => {
      if (!(v > 0)) return "var(--zero)";
      let k = 0;
      while (k < edges.length && v >= edges[k]) k++;
      return used[k];
    },
  };
}

export const fmt = (v) =>
  !Number.isFinite(v) ? "–" : v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString("en-CA") : v >= 10 ? v.toFixed(0) : v.toFixed(1);

const SOURCE_LABEL = {
  observed: "observed (VIIRS)",
  near_real_time: "near real time (VIIRS, provisional)",
  estimated_from_aqua: "estimated from MODIS Aqua",
  estimated_from_terra: "estimated from MODIS Terra",
};

export function renderCalendar(el, d, agg, opts) {
  const { firstYear, medianYears } = opts;
  const lastYear = d.months[d.months.length - 1].y;
  const years = [];
  for (let y = lastYear; y >= firstYear; y--) years.push(y);

  const cell = (y, m) => {
    const i = d.monthIndex.get(y * 100 + m);
    return i === undefined ? null : { i, v: agg.totals[i], info: d.months[i] };
  };
  const shown = [];
  for (const y of years) for (let m = 1; m <= 12; m++) { const c = cell(y, m); if (c) shown.push(c); }
  const scale = makeScale(shown.map((c) => c.v));
  const top = new Set([...shown].sort((a, b) => b.v - a.v).filter((c) => c.v > 0).slice(0, 3).map((c) => c.i));

  const yearTotals = years.map((y) => {
    let s = 0, any = false, partial = false;
    for (let m = 1; m <= 12; m++) {
      const c = cell(y, m);
      if (c) { s += c.v; any = true; if (c.info.partial) partial = true; }
    }
    const complete = [1, 12].every((m) => cell(y, m));
    return { y, s: any ? s : NaN, partialYear: !complete || partial };
  });
  const maxYear = Math.max(...yearTotals.map((t) => t.s).filter(Number.isFinite), 1);

  const monthMedians = MONTHS.map((_, k) =>
    median(medianYears.map((y) => { const c = cell(y, k + 1); return c && !c.info.partial ? c.v : NaN; })));

  let html = `<table class="cal" aria-label="Fire cell-days per month for the selected area">
    <thead><tr><th scope="col">Year</th>${MONTHS.map((m) => `<th scope="col">${m}</th>`).join("")}
    <th scope="col" class="tot">Year total</th></tr></thead><tbody>`;
  for (const t of yearTotals) {
    html += `<tr><th scope="row">${t.y}</th>`;
    for (let m = 1; m <= 12; m++) {
      const c = cell(t.y, m);
      if (!c) { html += `<td class="nodata" aria-label="${MONTHS[m - 1]} ${t.y}: no data">–</td>`; continue; }
      const cls = ["v", c.info.partial && "partial", c.info.source === "near_real_time" && "nrt",
        top.has(c.i) && "top"].filter(Boolean).join(" ");
      const label = `${MONTHS[m - 1]} ${t.y}: ${fmt(c.v)} cell-days, ${SOURCE_LABEL[c.info.source]}` +
        (c.info.partial ? ", partial month" : "");
      html += `<td class="${cls}" style="--c:${scale.color(c.v)}" data-i="${c.i}" tabindex="0"
        aria-label="${label}"><span class="sr">${fmt(c.v)}</span></td>`;
    }
    const w = Number.isFinite(t.s) ? (100 * t.s) / maxYear : 0;
    html += `<td class="tot"><div class="bar" style="width:${w}%"></div><span>${fmt(t.s)}${t.partialYear && t.y === lastYear ? "*" : ""}</span></td></tr>`;
  }
  html += `</tbody><tfoot><tr><th scope="row" title="Median of complete months, ${medianYears[0]}–${medianYears[medianYears.length - 1]}">Median</th>
    ${monthMedians.map((v) => `<td class="med">${fmt(v)}</td>`).join("")}<td></td></tr></tfoot></table>`;
  el.innerHTML = html;

  renderLegend(opts.legendEl, scale);
  return { scale, monthMedians, yearTotals };
}

function renderLegend(el, scale) {
  const sw = scale.colors.map((c, k) => {
    const lo = k === 0 ? "> 0" : fmt(scale.edges[k - 1]);
    return `<li><span class="sw" style="background:${c}"></span>${lo}</li>`;
  }).join("");
  el.innerHTML = `<ul class="legend" aria-label="Colour scale, cell-days per month">
    <li><span class="sw" style="background:var(--zero)"></span>0</li>${sw}</ul>
    <ul class="legend keys">
      <li><span class="sw key-top"></span>Top 3 months</li>
      <li><span class="sw key-partial"></span>Partial month</li>
      <li><span class="sw key-nrt"></span>Near real time</li>
      <li><span class="sw key-nodata">–</span>No data</li>
    </ul>`;
}

export function attachTooltip(tableHost, tip, d, getAgg) {
  const show = (td, x, y) => {
    const i = Number(td.dataset.i);
    const info = d.months[i];
    tip.innerHTML = `<strong>${MONTHS[info.m - 1]} ${info.y}</strong><br>${fmt(getAgg().totals[i])} fire cell-days<br>
      <span class="muted">${SOURCE_LABEL[info.source]}${info.partial ? ` · partial month` : ""}</span>`;
    tip.hidden = false;
    tip.style.left = `${x + 14}px`;
    tip.style.top = `${y + 14}px`;
  };
  tableHost.addEventListener("mousemove", (e) => {
    const td = e.target.closest("td[data-i]");
    if (!td) { tip.hidden = true; return; }
    show(td, e.clientX, e.clientY);
  });
  tableHost.addEventListener("mouseleave", () => { tip.hidden = true; });
  tableHost.addEventListener("focusin", (e) => {
    const td = e.target.closest("td[data-i]");
    if (!td) return;
    const r = td.getBoundingClientRect();
    show(td, r.right, r.top);
  });
  tableHost.addEventListener("focusout", () => { tip.hidden = true; });
}
