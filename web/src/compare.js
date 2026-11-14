// Historical comparison: latest months against the median for that month, and yearly totals.

import { MONTHS, fmt } from "./calendar.js";
import { median } from "./data.js";

function monthDays(info) {
  const days = Object.values(info.days || {});
  return days.length ? Math.max(...days) : null;
}

function compareRow(d, agg, i, medianYears, note) {
  const info = d.months[i];
  const v = agg.totals[i];
  const hist = medianYears.map((y) => {
    const j = d.monthIndex.get(y * 100 + info.m);
    return j === undefined || d.months[j].partial ? NaN : agg.totals[j];
  });
  const med = median(hist);
  const ratio = med > 0 ? v / med : NaN;
  const words = !Number.isFinite(ratio) ? (v > 0 ? "above a median of zero" : "same as the median (zero)")
    : ratio >= 1.15 ? `${ratio.toFixed(1)}× the median` : ratio <= 0.85 ? `${ratio.toFixed(1)}× the median`
    : "close to the median";
  const max = Math.max(v, med, 1e-9);
  return `<div class="cmp">
    <div class="cmp-head"><strong>${MONTHS[info.m - 1]} ${info.y}</strong>${note ? ` <span class="muted">${note}</span>` : ""}</div>
    <div class="cmp-bars" role="img" aria-label="${MONTHS[info.m - 1]} ${info.y}: ${fmt(v)} cell-days; median ${fmt(med)}">
      <div class="cmp-row"><span>This year</span><div class="b now" style="width:${(100 * v) / max}%"></div><b>${fmt(v)}</b></div>
      <div class="cmp-row"><span>Median ${medianYears[0]}–${medianYears[medianYears.length - 1]}</span><div class="b med" style="width:${(100 * med) / max}%"></div><b>${fmt(med)}</b></div>
    </div>
    <div class="muted">${words}</div></div>`;
}

export function renderCompare(el, d, agg, opts) {
  const { medianYears, yearTotals } = opts;
  const last = d.months.length - 1;
  const lastInfo = d.months[last];
  let lastFull = last;
  while (lastFull > 0 && d.months[lastFull].partial) lastFull--;

  let html = `<h3>Latest months against the historical median</h3>`;
  const nd = monthDays(lastInfo);
  html += compareRow(d, agg, last, medianYears,
    lastInfo.partial ? `(1–${nd} ${MONTHS[lastInfo.m - 1]} only${lastInfo.source === "near_real_time" ? ", provisional" : ""})` : "");
  if (lastFull !== last) {
    html += compareRow(d, agg, lastFull, medianYears,
      d.months[lastFull].source === "near_real_time" ? "(provisional)" : "");
  }

  // Yearly totals chart
  const rows = [...yearTotals].filter((t) => Number.isFinite(t.s)).sort((a, b) => a.y - b.y);
  const complete = rows.filter((t) => !t.partialYear && medianYears.includes(t.y)).map((t) => t.s);
  const medY = median(complete);
  const W = 560, H = 190, padL = 46, padB = 22, padT = 10;
  const max = Math.max(...rows.map((t) => t.s), medY || 0, 1);
  const bw = (W - padL - 8) / rows.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max].map((v) => `<g><line x1="${padL}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
      <text x="${padL - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${fmt(v)}</text></g>`).join("");
  const bars = rows.map((t, k) => {
    const x = padL + k * bw + 1;
    const h = y(0) - y(t.s);
    const lbl = `${t.y}: ${fmt(t.s)} cell-days${t.partialYear ? " (part of year)" : ""}`;
    return `<g><rect x="${x}" y="${y(t.s)}" width="${Math.max(bw - 2, 1)}" height="${Math.max(h, 0)}" rx="2"
        class="${t.partialYear ? "ybar partial" : "ybar"}"><title>${lbl}</title></rect>
      ${k % 2 === 0 || rows.length < 16 ? `<text x="${x + bw / 2 - 1}" y="${H - 6}" class="tick" text-anchor="middle">${String(t.y).slice(2)}</text>` : ""}</g>`;
  }).join("");
  const medLine = Number.isFinite(medY) ? `<line x1="${padL}" x2="${W - 4}" y1="${y(medY)}" y2="${y(medY)}" class="medline"/>
      <text x="${padL + 4}" y="${y(medY) - 5}" class="tick strong halo">median ${fmt(medY)}</text>` : "";
  html += `<h3>Yearly totals</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Fire cell-days per year for the selected area">${ticks}${bars}${medLine}</svg>
    <p class="muted small">Median of complete years ${medianYears[0]}–${medianYears[medianYears.length - 1]}. Lighter bar: year in progress.</p>`;
  el.innerHTML = html;
}
