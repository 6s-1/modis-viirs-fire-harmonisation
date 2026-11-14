// Comparison with past years: plain-language verdicts with bullet charts, the cumulative
// year-to-date chart, the seasonal profile and yearly totals.

import { MONTHS, fmt, fmtShort, median, monthDays, quantile } from "./data.js";

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const span = (ys) => (ys.length ? `${Math.min(...ys)}–${Math.max(...ys)}` : "");
const short = (ys) => (ys.length ? `${Math.min(...ys)}–${String(Math.max(...ys)).slice(2)}` : "");

// Words for a ratio to the median.
function verdictWord(r) {
  if (!Number.isFinite(r)) return "about normal";
  if (r < 0.5) return "well below normal";
  if (r < 0.8) return "below normal";
  if (r < 0.95) return "slightly below normal";
  if (r <= 1.05) return "about normal";
  if (r <= 1.25) return "slightly above normal";
  if (r < 2) return "above normal";
  return "well above normal";
}

// One comparison: sentence, numbers, then a bullet chart.
function bullet({ subject, ongoing, v, vals, years, nrt, big }) {
  const med = median(vals), q1 = quantile(vals, 0.25), q3 = quantile(vals, 0.75);
  const r = med > 0 ? v / med : v > 0 ? Infinity : 1;
  const word = med > 0 || v > 0 ? verdictWord(r) : "about normal";
  const sentence = `${subject} ${ongoing ? "is running" : "was"} ${word}`;
  const ratio = med > 0 ? `${(v / med).toFixed(2)}×` : v > 0 ? "above a typical value of 0" : "";
  const W = 560, H = 26, padL = 2, padR = 2;
  const max = Math.max(v, q3 || 0, med || 0, 1e-9) * 1.08;
  const x = (t) => padL + ((W - padL - padR) * t) / max;
  const band = Number.isFinite(q1) ? `<rect x="${x(q1)}" y="3" width="${Math.max(x(q3) - x(q1), 1)}" height="${H - 6}" rx="3" class="bband"><title>Middle half of ${span(years)}: ${fmt(q1)}–${fmt(q3)}</title></rect>` : "";
  const bar = `<rect x="${padL}" y="${H / 2 - 4}" width="${Math.max(x(v) - padL, 1)}" height="8" rx="2" class="bbar"><title>This year: ${fmt(v)}</title></rect>`;
  const mark = Number.isFinite(med) ? `<line x1="${x(med)}" x2="${x(med)}" y1="2" y2="${H - 2}" class="bmed"><title>Typical (median ${span(years)}): ${fmt(med)}</title></line>` : "";
  return `<div class="cmp${big ? "" : " small-cmp"}">
    <p class="verdict">${sentence}${nrt ? `<span class="nrt-dot" title="Provisional near-real-time data"></span>` : ""}</p>
    <p class="verdict-nums"><b>${fmt(v)}</b> this year · <span title="Median of ${span(years)}">${fmt(med)} typical</span>${ratio ? ` · ${ratio}` : ""}</p>
    <svg viewBox="0 0 ${W} ${H}" class="bullet" preserveAspectRatio="none" role="img"
      aria-label="${sentence}: ${fmt(v)} this year, typical ${fmt(med)}, middle half of past years ${fmt(q1)} to ${fmt(q3)}">${band}${bar}${mark}</svg>
  </div>`;
}

const BULLET_KEY = `<ul class="legend">
  <li><span class="sw key-bbar"></span>this year</li>
  <li><span class="sw key-bmed"></span>typical (median)</li>
  <li><span class="sw key-bband"></span>middle half of past years</li></ul>`;

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// Cumulative year to date: every year as a thin line, the latest year in the accent colour.
function cumulative(d, agg, yearsShown, yearFilter) {
  const Y = d.lastYear, last = d.lastMonth;
  const lines = [];
  for (const y of [...yearsShown].sort((a, b) => a - b)) {
    let c = 0, est = false;
    const pts = [];
    for (let m = 1; m <= 12; m++) {
      const i = d.monthIndex.get(y * 100 + m);
      if (i === undefined) { if (pts.length) break; continue; }
      if (d.months[i].source.startsWith("estimated")) est = true;
      if (!pts.length) pts.push([m - 1, 0]);
      c += agg.totals[i];
      pts.push([m, c]);
    }
    if (pts.length) lines.push({ y, pts, est: est && y < 2012, now: y === Y });
  }
  // rank this year against every other full year at the same point (to the last day of data)
  const nDays = monthDays(last);
  const sameDay = (y) => {
    let c = 0;
    for (let m = 1; m < last.m; m++) { const i = d.monthIndex.get(y * 100 + m); if (i !== undefined) c += agg.totals[i]; }
    if (y === Y) { const i = d.monthIndex.get(y * 100 + last.m); if (i !== undefined) c += agg.totals[i]; } // its own days 1..N
    else if (last.partial) c += agg.sameDays.get(y) || 0;
    else { const i = d.monthIndex.get(y * 100 + last.m); if (i !== undefined) c += agg.totals[i]; }
    return c;
  };
  const others = lines.filter((l) => !l.now && yearFilter(l.y) && d.monthIndex.has(l.y * 100 + 1)).map((l) => l.y);
  const cur = sameDay(Y);
  const lower = others.filter((y) => sameDay(y) < cur).length;
  const rank = others.filter((y) => sameDay(y) > cur).length + 1;
  const dateTxt = `${nDays} ${MONTHS[last.m - 1]}`;
  const caption = others.length ? `${Y} to ${dateTxt}: ${fmt(cur)} cell-days, ${rank === 1 ? "the highest" : `the ${ordinal(rank)} highest`} of ${others.length + 1} years at this date; more than ${lower} of the ${others.length} years ${span(others)}.` : "";

  const W = 560, H = 210, padL = 50, padR = 12, padB = 22, padT = 10;
  const max = Math.max(1, ...lines.map((l) => l.pts[l.pts.length - 1][1]));
  const x = (m) => padL + (m * (W - padL - padR)) / 12;
  const yy = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max].map((v) => `<g><line x1="${padL}" x2="${W - padR}" y1="${yy(v)}" y2="${yy(v)}" class="grid"/>
      <text x="${padL - 6}" y="${yy(v) + 4}" class="tick" text-anchor="end">${fmtShort(v)}</text></g>`).join("");
  const path = (l) => `M${l.pts.map(([m, v]) => `${x(m).toFixed(1)},${yy(v).toFixed(1)}`).join("L")}`;
  const back = lines.filter((l) => !l.now).map((l) => `<path d="${path(l)}" class="cum${l.est ? " est" : ""}"><title>${l.y}: ${fmt(l.pts[l.pts.length - 1][1])} cell-days${l.est ? " (estimated)" : ""}</title></path>`).join("");
  const nowL = lines.find((l) => l.now);
  const end = nowL ? nowL.pts[nowL.pts.length - 1] : null;
  const front = nowL ? `<path d="${path(nowL)}" class="cum-now"><title>${Y} to ${dateTxt}: ${fmt(cur)} cell-days</title></path>
      <text x="${x(end[0]) + 4}" y="${yy(end[1]) - 4}" class="tick strong">${Y}</text>` : "";
  const xt = MONTHS.map((m, k) => `<text x="${x(k + 0.5)}" y="${H - 6}" class="tick" text-anchor="middle">${m[0]}</text>`).join("");
  return `<h3 class="gap">Year to date</h3>
    <p class="caption">${caption}</p>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Cumulative fire cell-days through the year for every year, ${Y} highlighted. ${caption}">${ticks}${back}${front}${xt}</svg>
    <ul class="legend"><li><span class="sw key-cumnow"></span>${Y}</li><li><span class="sw key-cum"></span>measured years</li>
      <li><span class="sw key-cum dash"></span>estimated years</li></ul>`;
}

// Seasonal profile: median by month (middle-half band) over complete months, latest year on top.
function seasonal(d, agg, medianYears) {
  const per = MONTHS.map((_, k) => medianYears.map((y) => {
    const i = d.monthIndex.get(y * 100 + k + 1);
    return i === undefined || d.months[i].partial ? NaN : agg.totals[i];
  }).filter(Number.isFinite));
  const used = new Set();
  medianYears.forEach((y) => MONTHS.forEach((_, k) => {
    const i = d.monthIndex.get(y * 100 + k + 1);
    if (i !== undefined && !d.months[i].partial) used.add(y);
  }));
  const med = per.map((v) => median(v)), q1 = per.map((v) => quantile(v, 0.25)), q3 = per.map((v) => quantile(v, 0.75));
  const Y = d.lastYear;
  const cur = MONTHS.map((_, k) => {
    const i = d.monthIndex.get(Y * 100 + k + 1);
    return i === undefined ? null : { v: agg.totals[i], partial: d.months[i].partial, nrt: d.months[i].source === "near_real_time" };
  });
  const W = 560, H = 190, padL = 50, padR = 12, padB = 22, padT = 12;
  const max = Math.max(1, ...q3.filter(Number.isFinite), ...cur.filter(Boolean).map((c) => c.v));
  const x = (k) => padL + (k * (W - padL - padR)) / 11;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max].map((v) => `<g><line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
      <text x="${padL - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${fmtShort(v)}</text></g>`).join("");
  const band = `M${q3.map((v, k) => `${x(k)},${y(v || 0)}`).join("L")}L${q1.map((v, k) => `${x(k)},${y(v || 0)}`).reverse().join("L")}Z`;
  const medPath = `M${med.map((v, k) => `${x(k)},${y(v || 0)}`).join("L")}`;
  const pts = cur.map((c, k) => (c ? [k, c] : null)).filter(Boolean);
  const curPath = pts.length ? `M${pts.map(([k, c]) => `${x(k)},${y(c.v)}`).join("L")}` : "";
  const dots = pts.map(([k, c]) => `<circle cx="${x(k)}" cy="${y(c.v)}" r="3" class="${c.partial ? "dot-partial" : "dot-now"}">
      <title>${MONTHS[k]} ${Y}: ${fmt(c.v)} cell-days${c.partial ? ", partial month" : ""}${c.nrt ? ", near real time" : ""} · typical ${fmt(med[k])}</title></circle>`).join("");
  const xt = MONTHS.map((m, k) => `<text x="${x(k)}" y="${H - 6}" class="tick" text-anchor="middle">${m[0]}</text>`).join("");
  return `<h3 class="gap">Seasonal profile</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Typical fire cell-days by month with ${Y} overlaid">
      ${ticks}<path d="${band}" class="iqr"/><path d="${medPath}" class="medcurve"/><path d="${curPath}" class="nowcurve"/>${dots}${xt}</svg>
    <ul class="legend">
      <li><span class="sw key-now"></span>${Y}</li>
      <li title="Median of complete months ${span([...used])}"><span class="sw key-medcurve"></span>typical ${short([...used])}</li>
      <li><span class="sw key-iqr"></span>middle half of years</li>
      <li><span class="sw key-hollow"></span>partial month</li>
    </ul>`;
}

// Raw view: each satellite's own yearly cell-days. Colour = instrument, dashes = satellite.
const SENSORS = [["terra", "MODIS Terra", "modis", false], ["aqua", "MODIS Aqua", "modis", true],
  ["snpp", "VIIRS S-NPP", "viirs", false], ["noaa20", "VIIRS NOAA-20", "viirs", true]];
function rawYearly(d, agg, years) {
  const ys = [...years].sort((a, b) => a - b);
  const series = SENSORS.map(([p, name, inst, dash]) => {
    const v = agg.rawOf(p);
    const pts = ys.map((y) => {
      let s = 0, any = false;
      for (let m = 1; m <= 12; m++) {
        const i = d.monthIndex.get(y * 100 + m);
        if (i !== undefined && (d.months[i].days || {})[p]) { s += v[i]; any = true; }
      }
      return any ? s : NaN;
    });
    return { p, name, inst, dash, pts };
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
    const dots = s.pts.map((v, j) => Number.isFinite(v) ? `<circle cx="${x(j)}" cy="${y(v)}" r="2" class="${s.inst}"><title>${s.name} ${ys[j]}: ${fmt(v)} cell-days</title></circle>` : "").join("");
    return `<path d="${dpath}" class="rawline ${s.inst}${s.dash ? " dash" : ""}"/>${dots}`;
  }).join("");
  const ends = series.filter((s) => s.end).sort((a, b) => a.end.y - b.end.y);
  for (let k = 1; k < ends.length; k++) ends[k].end.y = Math.max(ends[k].end.y, ends[k - 1].end.y + 12);
  const over = ends.length ? ends[ends.length - 1].end.y - (H - padB) : 0;
  if (over > 0) ends.forEach((s) => { s.end.y -= over; });
  const labels = ends.map((s) => `<text x="${s.end.x}" y="${s.end.y}" class="tick strong">${s.name}</text>`).join("");
  const every = ys.length > 16 ? 5 : 1;
  const xt = ys.map((yy, j) => yy % every === 0 ? `<text x="${x(j)}" y="${H - 6}" class="tick" text-anchor="middle">${yy}</text>` : "").join("");
  return `<h3 title="Each satellite's own count, not converted. VIIRS sees about four times more fire cell-days than MODIS, so the record steps up in 2012. The comparison with normal is in the harmonised view.">Yearly totals by satellite, raw</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Raw fire cell-days per year for each satellite">${ticks}${stepLine}${lines}${labels}${xt}</svg>
    <ul class="legend">${SENSORS.map(([, n, inst, dash]) => `<li><span class="sw key-${inst}${dash ? " dash" : ""}"></span>${n}</li>`).join("")}</ul>`;
}

export function renderCompare(el, d, agg, opts) {
  const { yearFilter, totals, mode = "harmonised", years, medianYears = [] } = opts;
  if (mode === "raw") { el.innerHTML = rawYearly(d, agg, years); return; }
  const lastI = d.months.length - 1;
  const last = d.months[lastI];
  let html = "";

  // 1) latest month: if partial, compare the same days in earlier years
  const sd = d.manifest.same_days;
  if (last.partial && sd && sd.month === last.m) {
    const n = monthDays(last);
    const ys = sd.years.filter(yearFilter);
    html += bullet({ subject: `1–${n} ${MONTHS[last.m - 1]} ${last.y}`, ongoing: true, v: agg.totals[lastI],
      vals: ys.map((y) => agg.sameDays.get(y) || 0), years: ys, nrt: last.source === "near_real_time", big: true });
  } else {
    html += monthBullet(d, agg, lastI, yearFilter, true);
  }
  // 2) last complete month
  let j = lastI;
  while (j > 0 && d.months[j].partial) j--;
  if (j !== lastI) html += monthBullet(d, agg, j, yearFilter, false);
  html += BULLET_KEY;

  html += cumulative(d, agg, years, yearFilter);
  html += seasonal(d, agg, medianYears);

  // yearly totals
  const rows = totals.filter((t) => Number.isFinite(t.s)).sort((a, b) => a.y - b.y);
  const medYears = rows.filter((t) => !t.partial && t.y < d.lastYear).map((t) => t.y);
  const medY = median(rows.filter((t) => medYears.includes(t.y)).map((t) => t.s));
  const W = 560, H = 200, padL = 50, padB = 22, padT = 12;
  const max = Math.max(...rows.map((t) => t.est ? t.hi : t.s), medY || 0, 1);
  const bw = (W - padL - 8) / rows.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max].map((v) => `<g><line x1="${padL}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
      <text x="${padL - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${fmtShort(v)}</text></g>`).join("");
  const every = rows.length > 16 ? 5 : 1;
  const barsSvg = rows.map((t, k) => {
    const x = padL + k * bw + 1, w = Math.max(bw - 2, 1);
    const lbl = `${t.y}: ${fmt(t.s)}${t.est ? ` (${fmt(t.lo)}–${fmt(t.hi)})` : ""} cell-days${t.est ? ", estimated" : ""}${t.partial ? ", part of year" : ""}`;
    const err = t.est ? `<line x1="${x + w / 2}" x2="${x + w / 2}" y1="${y(t.hi)}" y2="${y(t.lo)}" class="err"/>` : "";
    return `<g><rect x="${x}" y="${y(t.s)}" width="${w}" height="${Math.max(y(0) - y(t.s), 0)}" rx="2"
        class="ybar${t.est ? " est" : ""}${t.partial ? " partial" : ""}${t.y === d.lastYear ? " current" : ""}"><title>${lbl}</title></rect>${err}
      ${t.y % every === 0 ? `<text x="${x + w / 2}" y="${H - 6}" class="tick" text-anchor="middle">${t.y}</text>` : ""}</g>`;
  }).join("");
  const medLine = Number.isFinite(medY) ? `<line x1="${padL}" x2="${W - 4}" y1="${y(medY)}" y2="${y(medY)}" class="medline"/>` : "";
  html += `<h3 class="gap">Yearly totals</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Fire cell-days per year for the selected area">
      <defs><pattern id="hatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="5" height="5" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="5" class="hatch-line"/></pattern></defs>
      ${ticks}${barsSvg}${medLine}</svg>
    <ul class="legend">
      <li><span class="sw key-bar"></span>measured</li>
      <li><span class="sw key-hatch"></span>estimated</li>
      <li><span class="sw key-line"></span>likely range</li>
      <li><span class="sw key-light"></span>${d.lastYear} (to date)</li>
      <li title="Median of complete years ${span(medYears)}"><span class="sw key-dash"></span>typical ${short(medYears)} (${fmtShort(medY)})</li>
    </ul>`;
  el.innerHTML = html;
}

function monthBullet(d, agg, i, yearFilter, big) {
  const info = d.months[i];
  const ys = [], vals = [];
  for (let y = d.firstYear; y < info.y; y++) {
    const j = d.monthIndex.get(y * 100 + info.m);
    if (j === undefined || d.months[j].partial || !yearFilter(y)) continue;
    ys.push(y);
    vals.push(agg.totals[j]);
  }
  return bullet({ subject: `${LONG[info.m - 1]} ${info.y}`, ongoing: false, v: agg.totals[i], vals, years: ys,
    nrt: info.source === "near_real_time", big });
}
