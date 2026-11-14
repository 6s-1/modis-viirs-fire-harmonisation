// Historical comparison: latest months against the median for the same period, and yearly totals.

import { MONTHS, fmt, median, monthDays } from "./data.js";

function words(v, med) {
  if (!(med > 0)) return v > 0 ? "above a median of zero" : "same as the median (zero)";
  const r = v / med;
  return r >= 1.15 || r <= 0.85 ? `${r.toFixed(1)}× the median` : "close to the median";
}

function bars(title, note, v, med, medLabel) {
  const max = Math.max(v, med, 1e-9);
  return `<div class="cmp">
    <div class="cmp-head"><strong>${title}</strong>${note ? ` <span class="muted">${note}</span>` : ""}</div>
    <div class="cmp-bars" role="img" aria-label="${title}: ${fmt(v)} cell-days; ${medLabel} ${fmt(med)}">
      <div class="cmp-row"><span>This year</span><div class="b now" style="width:${(100 * v) / max}%"></div><b>${fmt(v)}</b></div>
      <div class="cmp-row"><span>${medLabel}</span><div class="b med" style="width:${(100 * med) / max}%"></div><b>${fmt(med)}</b></div>
    </div>
    <div class="muted">${words(v, med)}</div></div>`;
}

const span = (ys) => (ys.length ? `${Math.min(...ys)}–${Math.max(...ys)}` : "");

export function renderCompare(el, d, agg, opts) {
  const { yearFilter, totals } = opts;
  const lastI = d.months.length - 1;
  const last = d.months[lastI];
  let html = `<h3>Latest months against the historical median</h3>`;

  // 1) latest month: if partial, compare the same days in earlier years
  const sd = d.manifest.same_days;
  if (last.partial && sd && sd.month === last.m) {
    const n = monthDays(last);
    const ys = sd.years.filter(yearFilter);
    const med = median(ys.map((y) => agg.sameDays.get(y) || 0));
    const label = `1–${n} ${MONTHS[last.m - 1]}`;
    html += bars(`${label} ${last.y}`, last.source === "near_real_time" ? "(provisional)" : "",
      agg.totals[lastI], med, `Median of ${label}, ${span(ys)}`);
  } else {
    html += monthCompare(d, agg, lastI, yearFilter);
  }
  // 2) last complete month
  let j = lastI;
  while (j > 0 && d.months[j].partial) j--;
  if (j !== lastI) html += monthCompare(d, agg, j, yearFilter);

  // 3) yearly totals chart
  const rows = totals.filter((t) => Number.isFinite(t.s)).sort((a, b) => a.y - b.y);
  const medYears = rows.filter((t) => !t.partial && t.y < d.lastYear).map((t) => t.y);
  const medY = median(rows.filter((t) => medYears.includes(t.y)).map((t) => t.s));
  const W = 560, H = 200, padL = 50, padB = 22, padT = 12;
  const max = Math.max(...rows.map((t) => t.est ? t.hi : t.s), medY || 0, 1);
  const bw = (W - padL - 8) / rows.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max].map((v) => `<g><line x1="${padL}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
      <text x="${padL - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${fmt(v)}</text></g>`).join("");
  const every = rows.length > 16 ? 5 : 1;
  const barsSvg = rows.map((t, k) => {
    const x = padL + k * bw + 1, w = Math.max(bw - 2, 1);
    const lbl = `${t.y}: ${fmt(t.s)} cell-days${t.est ? ` (estimated, likely ${fmt(t.lo)}–${fmt(t.hi)})` : ""}${t.partial ? ", part of year" : ""}`;
    const err = t.est ? `<line x1="${x + w / 2}" x2="${x + w / 2}" y1="${y(t.hi)}" y2="${y(t.lo)}" class="err"/>` : "";
    return `<g><rect x="${x}" y="${y(t.s)}" width="${w}" height="${Math.max(y(0) - y(t.s), 0)}" rx="2"
        class="ybar${t.est ? " est" : ""}${t.partial ? " partial" : ""}"><title>${lbl}</title></rect>${err}
      ${t.y % every === 0 ? `<text x="${x + w / 2}" y="${H - 6}" class="tick" text-anchor="middle">${t.y}</text>` : ""}</g>`;
  }).join("");
  const medLine = Number.isFinite(medY) ? `<line x1="${padL}" x2="${W - 4}" y1="${y(medY)}" y2="${y(medY)}" class="medline"/>` : "";
  html += `<h3>Yearly totals</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Fire cell-days per year for the selected area">
      <defs><pattern id="hatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="5" height="5" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="5" class="hatch-line"/></pattern></defs>
      ${ticks}${barsSvg}${medLine}</svg>
    <p class="muted small">Dashed line: median of complete years ${span(medYears)} (${fmt(medY)} cell-days). Hatched bars: estimated from MODIS, with the likely range as a line. Lighter bars: part of a year.</p>`;
  el.innerHTML = html;
}

function monthCompare(d, agg, i, yearFilter) {
  const info = d.months[i];
  const ys = [];
  const vals = [];
  for (let y = d.firstYear; y < info.y; y++) {
    const j = d.monthIndex.get(y * 100 + info.m);
    if (j === undefined || d.months[j].partial || !yearFilter(y)) continue;
    ys.push(y);
    vals.push(agg.totals[j]);
  }
  return bars(`${MONTHS[info.m - 1]} ${info.y}`, info.source === "near_real_time" ? "(provisional)" : "",
    agg.totals[i], median(vals), `Median ${MONTHS[info.m - 1]}, ${span(ys)}`);
}
