// Historical comparison: latest months against the median for the same period, and yearly totals.

import { MONTHS, fmt, fmtShort, median, monthDays } from "./data.js";

const ratio = (v, med) => (med > 0 ? `${(v / med).toFixed(2)}×` : v > 0 ? "> 0 vs 0" : "0 vs 0");
const short = (ys) => (ys.length ? `${Math.min(...ys)}–${String(Math.max(...ys)).slice(2)}` : "");

// One comparison: ratio as the headline, then two thin bars with their values.
function bars({ title, nrt, v, med, medLabel, medTip, big }) {
  const max = Math.max(v, med, 1e-9);
  return `<div class="cmp">
    <div class="${big ? "big" : "mid"}">${ratio(v, med)} <span class="unit">median</span></div>
    <div class="sub"><strong>${title}</strong>${nrt ? `<span class="nrt-dot" title="Provisional near-real-time data"></span>` : ""}</div>
    <div class="cmp-bars" role="img" aria-label="${title}: ${fmt(v)} cell-days; ${medLabel} ${fmt(med)}">
      <div class="cmp-row"><span>${title.match(/\d{4}$/)[0]}</span><div class="b now" style="width:${(100 * v) / max}%"></div><b>${fmt(v)}</b></div>
      <div class="cmp-row"><span title="${medTip}">${medLabel}</span><div class="b med" style="width:${(100 * med) / max}%"></div><b>${fmt(med)}</b></div>
    </div></div>`;
}

const span = (ys) => (ys.length ? `${Math.min(...ys)}–${Math.max(...ys)}` : "");

const SENSORS = [["terra", "MODIS Terra"], ["aqua", "MODIS Aqua"], ["snpp", "VIIRS S-NPP"], ["noaa20", "VIIRS NOAA-20"]];

// Raw view: each satellite's own yearly cell-days, no conversion, so the 2012 step shows.
function rawYearly(d, agg, years) {
  const ys = [...years].sort((a, b) => a - b);
  const series = SENSORS.map(([p, name], k) => {
    const v = agg.rawOf(p);
    const pts = ys.map((y) => {
      let s = 0, any = false;
      for (let m = 1; m <= 12; m++) {
        const i = d.monthIndex.get(y * 100 + m);
        if (i !== undefined && (d.months[i].days || {})[p]) { s += v[i]; any = true; }
      }
      return any ? s : NaN;
    });
    return { p, name, k, pts };
  });
  const W = 560, H = 210, padL = 50, padR = 96, padB = 22, padT = 12;
  const max = Math.max(1, ...series.flatMap((s) => s.pts.filter(Number.isFinite)));
  const x = (j) => padL + (j * (W - padL - padR)) / Math.max(ys.length - 1, 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max].map((v) => `<g><line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
    <text x="${padL - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${fmt(v)}</text></g>`).join("");
  const step = ys.indexOf(2012);
  const stepLine = step > 0 ? `<line x1="${x(step)}" x2="${x(step)}" y1="${padT}" y2="${H - padB}" class="stepline"/>
    <text x="${x(step) + 4}" y="${padT + 10}" class="tick strong">VIIRS starts</text>` : "";
  const lines = series.map((s) => {
    let dpath = "", pen = false, lastJ = -1;
    s.pts.forEach((v, j) => {
      if (!Number.isFinite(v)) { pen = false; return; }
      dpath += `${pen ? "L" : "M"}${x(j).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true; lastJ = j;
    });
    s.end = lastJ >= 0 ? { x: x(lastJ) + 6, y: y(s.pts[lastJ]) + 4 } : null;
    const dots = s.pts.map((v, j) => Number.isFinite(v) ? `<circle cx="${x(j)}" cy="${y(v)}" r="2.2" class="s${s.k}"><title>${s.name} ${ys[j]}: ${fmt(v)} cell-days</title></circle>` : "").join("");
    return `<path d="${dpath}" class="rawline s${s.k}"/>${dots}`;
  }).join("");
  // end labels, nudged apart so they never overlap (min 12 px)
  const ends = series.filter((s) => s.end).sort((a, b) => a.end.y - b.end.y);
  for (let k = 1; k < ends.length; k++) ends[k].end.y = Math.max(ends[k].end.y, ends[k - 1].end.y + 12);
  const over = ends.length ? ends[ends.length - 1].end.y - (H - padB) : 0;
  if (over > 0) ends.forEach((s) => { s.end.y -= over; });
  const labels = ends.map((s) => `<text x="${s.end.x}" y="${s.end.y}" class="tick strong">${s.name}</text>`).join("");
  const every = ys.length > 16 ? 5 : 1;
  const xt = ys.map((yy, j) => yy % every === 0 ? `<text x="${x(j)}" y="${H - 6}" class="tick" text-anchor="middle">${yy}</text>` : "").join("");
  return `<h3 title="Each satellite's own count, not converted. VIIRS sees about four times more fire cell-days than MODIS, so the record steps up in 2012. The comparison with the median is in the harmonised view.">Yearly totals by satellite, raw</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Raw fire cell-days per year for each satellite">${ticks}${stepLine}${lines}${labels}${xt}</svg>
    <ul class="legend">${SENSORS.map(([, n], k) => `<li><span class="sw s${k}-bg"></span>${n}</li>`).join("")}</ul>`;
}

export function renderCompare(el, d, agg, opts) {
  const { yearFilter, totals, mode = "harmonised", years } = opts;
  if (mode === "raw") { el.innerHTML = rawYearly(d, agg, years); return; }
  const lastI = d.months.length - 1;
  const last = d.months[lastI];
  let html = "";

  // 1) latest month: if partial, compare the same days in earlier years
  const sd = d.manifest.same_days;
  if (last.partial && sd && sd.month === last.m) {
    const n = monthDays(last);
    const ys = sd.years.filter(yearFilter);
    const med = median(ys.map((y) => agg.sameDays.get(y) || 0));
    const label = `1–${n} ${MONTHS[last.m - 1]}`;
    html += bars({ title: `${label} ${last.y}`, nrt: last.source === "near_real_time", v: agg.totals[lastI], med,
      medLabel: `median ${short(ys)}`, medTip: `Median of ${label} in each year ${span(ys)}`, big: true });
  } else {
    html += monthCompare(d, agg, lastI, yearFilter, true);
  }
  // 2) last complete month
  let j = lastI;
  while (j > 0 && d.months[j].partial) j--;
  if (j !== lastI) html += monthCompare(d, agg, j, yearFilter, false);

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
    const lbl = `${t.y}: ${fmt(t.s)}${t.est ? ` (${fmt(t.lo)}–${fmt(t.hi)})` : ""} cell-days${t.est ? ", estimated" : ""}${t.partial ? ", part of year" : ""}`;
    const err = t.est ? `<line x1="${x + w / 2}" x2="${x + w / 2}" y1="${y(t.hi)}" y2="${y(t.lo)}" class="err"/>` : "";
    return `<g><rect x="${x}" y="${y(t.s)}" width="${w}" height="${Math.max(y(0) - y(t.s), 0)}" rx="2"
        class="ybar${t.est ? " est" : ""}${t.partial ? " partial" : ""}"><title>${lbl}</title></rect>${err}
      ${t.y % every === 0 ? `<text x="${x + w / 2}" y="${H - 6}" class="tick" text-anchor="middle">${t.y}</text>` : ""}</g>`;
  }).join("");
  const medLine = Number.isFinite(medY) ? `<line x1="${padL}" x2="${W - 4}" y1="${y(medY)}" y2="${y(medY)}" class="medline"/>` : "";
  html += `<h3 class="gap">Yearly totals</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Fire cell-days per year for the selected area">
      <defs><pattern id="hatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="5" height="5" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="5" class="hatch-line"/></pattern></defs>
      ${ticks}${barsSvg}${medLine}</svg>
    <ul class="legend">
      <li><span class="sw key-hatch"></span>estimated</li>
      <li><span class="sw key-line"></span>likely range</li>
      <li><span class="sw key-light"></span>part of year</li>
      <li title="Median of complete years ${span(medYears)}"><span class="sw key-dash"></span>median ${short(medYears)} (${fmtShort(medY)})</li>
    </ul>`;
  el.innerHTML = html;
}

function monthCompare(d, agg, i, yearFilter, big) {
  const info = d.months[i];
  const ys = [];
  const vals = [];
  for (let y = d.firstYear; y < info.y; y++) {
    const j = d.monthIndex.get(y * 100 + info.m);
    if (j === undefined || d.months[j].partial || !yearFilter(y)) continue;
    ys.push(y);
    vals.push(agg.totals[j]);
  }
  return bars({ title: `${MONTHS[info.m - 1]} ${info.y}`, nrt: info.source === "near_real_time", v: agg.totals[i],
    med: median(vals), medLabel: `median ${short(ys)}`, medTip: `Median of complete ${MONTHS[info.m - 1]} months, ${span(ys)}`, big });
}
