// Compared with past years: a storyline from the widest timescale to the narrowest.
//   1 Yearly totals, with a trend line
//   2 When the fire season runs, by year
//   3 This year so far, against past years
//   4 Month by month, this year against typical
//   5 Unusual months
// Every block states its subject in the heading, never its conclusion; any reading of the data is
// one muted line below the chart, with the statistics behind an info icon.
// Blocks are patched in place on a new selection, so bars and lines glide to their new values.

import { MONTHS, fmt, fmtShort, fmtSig, median, monthDays, quantile } from "./data.js";
import { infoIcon } from "./info.js";
import { distributionStrip, rankSentence } from "./strip.js";
import { RAMP, makeScale } from "./calendar.js";

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MEASURED_FROM = 2012;
const span = (ys) => (ys.length ? `${Math.min(...ys)}–${Math.max(...ys)}` : "");
const f1 = (v) => v.toFixed(1);
const sg = (v) => `${v < 0 ? "−" : ""}${fmtSig(Math.abs(v))}`;

// Anomaly rule: above the 90th percentile AND above twice the median of the same month in the
// other years, and at least this many cell-days.
const ANOM_MIN = 10, ANOM_MIN_YEARS = 5, ANOM_TOP = 5;
const isEstimatedSource = (src) => src === "estimated_from_modis" || src === "estimated_from_terra";

// ---------- statistics

// Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7).
function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Mann–Kendall trend test with the ties correction; two-sided p.
export function mannKendall(vs) {
  const n = vs.length;
  let S = 0;
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) S += Math.sign(vs[j] - vs[i]);
  const ties = new Map();
  for (const v of vs) ties.set(v, (ties.get(v) || 0) + 1);
  let tie = 0;
  for (const t of ties.values()) if (t > 1) tie += t * (t - 1) * (2 * t + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tie) / 18;
  const z = varS > 0 ? (S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0) : 0;
  return { S, varS, z, p: 2 * (1 - phi(Math.abs(z))) };
}

// Theil–Sen slope with its 95% range (Gilbert 1987), each line through its own median intercept.
export function theilSen(xs, vs, varS) {
  const slopes = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = i + 1; j < xs.length; j++) {
    if (xs[j] !== xs[i]) slopes.push((vs[j] - vs[i]) / (xs[j] - xs[i]));
  }
  slopes.sort((a, b) => a - b);
  const N = slopes.length;
  const b = median(slopes);
  const C = 1.96 * Math.sqrt(varS);
  const at = (k) => slopes[Math.min(Math.max(k, 0), N - 1)];
  const lo = at(Math.round((N - C) / 2) - 1), hi = at(Math.round((N + C) / 2));
  const icpt = (s) => median(xs.map((x, k) => vs[k] - s * x));
  return { b, a: icpt(b), lo, aLo: icpt(lo), hi, aHi: icpt(hi) };
}

// ---------- small drawing helpers

// Round "nice" top of the axis so the three ticks are readable numbers.
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

// A column with a 4 px rounded top, anchored to the baseline. Always the same path commands,
// so a change of height animates.
function col(x, w, yTop, yBase) {
  const r = Math.max(0, Math.min(4, w / 2, yBase - yTop));
  return `M${f1(x)},${f1(yBase)}V${f1(yTop + r)}Q${f1(x)},${f1(yTop)} ${f1(x + r)},${f1(yTop)}H${f1(x + w - r)}Q${f1(x + w)},${f1(yTop)} ${f1(x + w)},${f1(yTop + r)}V${f1(yBase)}Z`;
}

function axis(max, y, x0, x1) {
  return [0, max / 2, max].map((v) => `<path d="M${x0},${f1(y(v))}H${x1}" class="grid${v === 0 ? " base" : ""}"/>
    <text x="${x0 - 6}" y="${f1(y(v) + 3.5)}" class="tick" text-anchor="end">${fmtShort(v)}</text>`).join("");
}

// Tooltips and crosshairs are registered per render and looked up by the delegated listeners.
let TIPS = [], XH = {};
const tip = (html) => { TIPS.push(html); return `data-tip="${TIPS.length - 1}"`; };
const crosshair = (key, xs, rows, top, bottom) => { XH[key] = { xs, rows, top, bottom }; };

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// ---------- 1) trend

let includeEst = false;

function trendBlock(d, totals, yearFilter, observedOnly) {
  // years before 2012 are estimated from MODIS; 2012 counts as measured (only its first months are estimated)
  const rows = totals.filter((t) => Number.isFinite(t.s)).sort((a, b) => a.y - b.y)
    .map((t) => ({ ...t, est: t.est && t.y < MEASURED_FROM, partEst: t.est && t.y >= MEASURED_FROM }));
  const estYears = rows.filter((t) => t.est).map((t) => t.y);
  const useEst = includeEst && !observedOnly;
  const inTrend = (t) => !t.partial && t.y < d.lastYear && yearFilter(t.y) && (useEst || t.y >= MEASURED_FROM);
  const used = rows.filter(inTrend);
  const y0 = used.length ? used[0].y : MEASURED_FROM, y1 = used.length ? used[used.length - 1].y : d.lastYear - 1;

  let fit = null, mk = null;
  if (used.length >= 6) {
    mk = mannKendall(used.map((t) => t.s));
    fit = theilSen(used.map((t) => t.y), used.map((t) => t.s), mk.varS);
  }
  const typical = median(used.map((t) => t.s));
  const sig = fit && mk.p < 0.05 && fit.b !== 0;
  const pTxt = mk ? (mk.p < 0.001 ? "p < 0.001" : `p = ${mk.p.toFixed(mk.p < 0.01 ? 3 : 2)}`) : "";
  const per = (v) => `${fmtSig(Math.abs(v))} cell-days a year`;
  let headline, sub;
  if (!fit) {
    headline = "Too few complete years to test for a trend";
    sub = `${used.length} complete years in the selection; the test needs at least 6.`;
  } else if (sig) {
    headline = `${fit.b > 0 ? "Rising" : "Falling"} about ${per(fit.b)} since ${y0} (statistically significant)`;
    sub = `Estimate ${fit.b > 0 ? "+" : "−"}${per(fit.b)}${typical > 0 ? ` (about ${Math.round((Math.abs(fit.b) / typical) * 100)}% of a typical year)` : ""}<br>Likely range ${sg(fit.lo)} to ${sg(fit.hi)} a year<br>Mann–Kendall ${pTxt} · ${used.length} years, ${y0}–${y1}<br><span class="muted">Theil–Sen slope; likely range is the 95% interval.</span>`;
  } else {
    headline = `No clear trend since ${y0}`;
    sub = `Estimate ${fit.b >= 0 ? "+" : "−"}${per(fit.b)}, not statistically significant<br>Likely range ${sg(fit.lo)} to ${sg(fit.hi)} a year<br>Mann–Kendall ${pTxt} · ${used.length} years, ${y0}–${y1}<br><span class="muted">Theil–Sen slope; likely range is the 95% interval.</span>`;
  }

  const W = 560, H = 200, padL = 44, padR = 58, padT = 18, padB = 22;
  const max = niceMax(Math.max(1, ...rows.map((t) => (t.est ? t.hi : t.s))));
  const y = (v) => padT + (H - padT - padB) * (1 - Math.max(v, 0) / max);
  const bw = (W - padL - padR) / Math.max(rows.length, 1);
  const cw = Math.min(24, Math.max(2, bw * 0.62));
  const cx = (k) => padL + k * bw + bw / 2;
  const kOf = new Map(rows.map((t, k) => [t.y, k]));
  const xOfYear = (yr) => cx(0) + (yr - rows[0].y) * bw;

  // estimated years: a quiet background band with a label
  const estK = estYears.map((yr) => kOf.get(yr));
  const estBand = estK.length ? `<rect x="${f1(padL + Math.min(...estK) * bw)}" y="${padT - 14}" width="${f1((Math.max(...estK) - Math.min(...estK) + 1) * bw)}" height="${H - padB - padT + 14}" class="est-zone"/>
    <text x="${f1(padL + Math.min(...estK) * bw + 4)}" y="${padT - 4}" class="tick">estimated from MODIS</text>` : "";

  const every = rows.length > 16 ? 5 : rows.length > 8 ? 2 : 1;
  const bars = rows.map((t, k) => {
    const x = cx(k) - cw / 2;
    const cls = `tbar${t.est ? " est" : ""}${t.partial ? " partial" : ""}${inTrend(t) ? "" : " off"}`;
    const whisk = t.est ? `M${f1(cx(k))},${f1(y(t.hi))}V${f1(y(t.lo))}` : `M${f1(cx(k))},${f1(y(t.s))}V${f1(y(t.s))}`;
    const status = t.partial ? (t.y === d.lastYear ? "to date, not in the trend" : "part year, not in the trend")
      : t.est ? `estimated from MODIS${inTrend(t) ? "" : ", not in the trend"}` : t.partEst ? `measured (${t.estLabel})` : "measured";
    const html = `<strong>${fmt(t.s)}</strong> cell-days${t.est ? ` <span class="muted">(likely ${fmt(t.lo)}–${fmt(t.hi)})</span>` : ""}<br>
      <span class="muted">${t.y} · ${status}</span>${fit && inTrend(t) ? `<br><span class="muted">trend line ${fmt(Math.max(0, fit.a + fit.b * t.y))}</span>` : ""}`;
    return `<path d="${col(x, cw, y(t.s), y(0))}" class="${cls}"/><path d="${whisk}" class="err${t.est ? "" : " none"}"/>
      ${t.y % every === 0 ? `<text x="${f1(cx(k))}" y="${H - 7}" class="tick" text-anchor="middle">${t.y}</text>` : ""}
      <rect x="${f1(padL + k * bw)}" y="${padT}" width="${f1(bw)}" height="${H - padT - padB}" class="hit" tabindex="0"
        aria-label="${t.y}: ${fmt(t.s)} cell-days, ${status}" ${tip(html)}/>`;
  }).join("");

  let line = "", band = "", endLab = "";
  if (fit) {
    const xa = xOfYear(y0), xb = xOfYear(y1);
    const at = (a, b, yr) => y(a + b * yr);
    band = `<path d="M${f1(xa)},${f1(at(fit.aLo, fit.lo, y0))}L${f1(xb)},${f1(at(fit.aLo, fit.lo, y1))}L${f1(xb)},${f1(at(fit.aHi, fit.hi, y1))}L${f1(xa)},${f1(at(fit.aHi, fit.hi, y0))}Z" class="tband"/>`;
    line = `<path d="M${f1(xa)},${f1(at(fit.a, fit.b, y0))}L${f1(xb)},${f1(at(fit.a, fit.b, y1))}" class="tline${sig ? "" : " weak"}"/>`;
    endLab = `<text x="${f1(xb + bw / 2 + 4)}" y="${f1(at(fit.a, fit.b, y1) + 3.5)}" class="tick strong">trend</text>`;
  }

  const estToggle = estYears.length ? `<label class="chk${observedOnly ? " disabled" : ""}"${observedOnly ? ` title="Switch the calendar to All years to include them"` : ""}>
      <input type="checkbox" id="trend-est"${useEst ? " checked" : ""}${observedOnly ? " disabled" : ""}/> Include estimated years (${span(estYears.filter((yr) => !rows.find((t) => t.y === yr).partial))})</label>` : "";

  return `<section class="cblock" data-b="trend">
    <h3 class="cb-title">Yearly totals, ${rows.length ? `${rows[0].y} to ${rows[rows.length - 1].y}` : ""}</h3>
    ${estToggle}
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Fire cell-days per year with the trend line. ${headline}.">
      <defs><pattern id="hatch" width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="4" height="4" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="4" class="hatch-line"/></pattern>
        <clipPath id="trend-clip"><rect x="${padL}" y="${padT}" width="${W - padL}" height="${H - padT - padB}"/></clipPath></defs>
      ${estBand}${axis(max, y, padL, W - padR + 20)}${bars}
      <g clip-path="url(#trend-clip)" class="nohit">${band}${line}</g>${endLab}</svg>
    <ul class="legend">
      <li><span class="sw key-bar"></span>measured</li>
      ${estYears.length ? `<li><span class="sw key-hatch"></span>estimated, with likely range</li>` : ""}
      <li><span class="sw key-light"></span>${d.lastYear} to date</li>
      ${fit ? `<li><span class="sw key-trend${sig ? "" : " dash"}"></span>trend ${y0}–${y1}</li><li><span class="sw key-tband"></span>likely range of the trend</li>` : ""}
    </ul>
    <p class="reading">${headline}${infoIcon(sub)}</p>
  </section>`;
}

// ---------- 2) anomalies

function anomalyBlock(d, agg, years) {
  const shown = new Set(years);
  const ms = d.months.map((info, i) => ({ info, i })).filter(({ info }) => shown.has(info.y));
  const byM = MONTHS.map(() => []);
  for (const { info, i } of ms) if (!info.partial) byM[info.m - 1].push({ y: info.y, v: agg.totals[i] });

  const rows = ms.map(({ info, i }) => {
    const v = agg.totals[i];
    const base = byM[info.m - 1].filter((o) => o.y !== info.y).map((o) => o.v);
    const ok = !info.partial && base.length >= ANOM_MIN_YEARS;
    const med = ok ? median(base) : NaN, q90 = ok ? quantile(base, 0.9) : NaN;
    const anom = ok && v > q90 && v > 2 * med && v >= ANOM_MIN;
    return { info, i, v, med, q90, anom, r: v / Math.max(med, 1) };
  });
  const anoms = rows.filter((r) => r.anom);
  const top = [...anoms].sort((a, b) => b.r - a.r).slice(0, ANOM_TOP);
  const label = (r) => `${MONTHS[r.info.m - 1]} ${r.info.y}`;
  // a typical value under 1 cell-day makes a ratio meaningless, so say so instead
  const times = (r) => (r.med < 1 ? "" : r.r >= 10 ? `${Math.round(r.r)}×` : `${r.r.toFixed(1)}×`);
  const vsTyp = (r) => (r.med < 1 ? "where there is usually almost none" : `${times(r)} typical`);
  const headline = anoms.length
    ? `${anoms.length === 1 ? "One month was" : `${anoms.length} months were`} unusually high for the time of year.`
    : "No month stood out as unusually high for its time of year.";

  const W = 560, H = 150, padL = 44, padR = 10, padT = 14, padB = 22;
  const n = Math.max(rows.length, 1);
  const bw = (W - padL - padR) / n;
  const max = niceMax(Math.max(1, ...rows.map((r) => r.v)));
  const y = (v) => padT + (H - padT - padB) * (1 - Math.max(v, 0) / max);
  const x = (k) => padL + k * bw;
  const w = Math.max(bw - (bw > 3 ? 1 : 0.3), 0.8);
  const estK = rows.map((r, k) => (r.info.y < MEASURED_FROM ? k : -1)).filter((k) => k >= 0);
  const estZone = estK.length ? `<rect x="${f1(x(estK[0]))}" y="${padT - 10}" width="${f1((estK[estK.length - 1] - estK[0] + 1) * bw)}" height="${H - padB - padT + 10}" class="est-zone"/>
    <text x="${f1(x(estK[0]) + 4)}" y="${padT - 1}" class="tick">estimated</text>` : "";
  const bars = rows.map((r, k) => `<path d="${col(x(k), w, y(r.v), y(0))}" class="mbar${r.anom ? " anom" : ""}${r.info.partial ? " partial" : ""}" data-m="${r.i}"/>`).join("");
  const rug = rows.map((r, k) => `<rect x="${f1(x(k))}" y="${H - padB + 2}" width="${f1(Math.max(w, 1.2))}" height="3" class="rug${r.anom ? " on" : ""}"/>`).join("");
  const xt = rows.map((r, k) => (r.info.m === 1 && r.info.y % 5 === 0 ? `<text x="${f1(x(k))}" y="${H - 6}" class="tick" text-anchor="middle">${r.info.y}</text>` : "")).join("");
  const xs = rows.map((_, k) => x(k) + bw / 2);
  crosshair("anom", xs, rows.map((r) => `<strong>${fmt(r.v)}</strong> cell-days<br><span class="muted">${label(r)}${r.info.y < MEASURED_FROM ? " · estimated" : ""}${r.info.partial ? " · partial month" : ""}</span>
    ${Number.isFinite(r.med) ? `<br>${r.med < 1 ? "usually almost none" : `${times(r)} typical`} <span class="muted">(median ${fmt(r.med)}, 90th percentile ${fmt(r.q90)})</span>${r.anom ? `<br><b>Unusually high</b>` : ""}` : `<br><span class="muted">not compared</span>`}`), padT, H - padB);

  const list = top.length ? `<ol class="anoms">${top.map((r) => `<li data-hl="${r.i}" tabindex="0">
      <span class="ad">${LONG[r.info.m - 1]} ${r.info.y}${r.info.y < MEASURED_FROM ? ` <span class="est-tag">est.</span>` : ""}</span>
      <span class="av">${fmt(r.v)}</span>
      <span class="ar">${r.med < 1 ? `<span class="muted">usually ~0</span>` : `${times(r)} typical <span class="muted">(${fmt(r.med)})</span>`}</span></li>`).join("")}</ol>` : "";

  return `<section class="cblock" data-b="anom">
    <h3 class="cb-title">Month by month, ${years.length ? `${Math.min(...years)} to ${Math.max(...years)}` : ""}</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Fire cell-days per month, unusually high months highlighted. ${headline}.">
      ${estZone}${axis(max, y, padL, W - padR)}${bars}${rug}${xt}
      <path d="M0,0" class="xh" hidden/><rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB + 6}" class="hit" data-xh="anom"/></svg>
    <ul class="legend"><li><span class="sw key-mbar"></span>month</li><li><span class="sw key-anom"></span>unusually high</li></ul>
    <p class="reading">${headline}${infoIcon(`A month counts as unusually high when it is above the 90th percentile and above twice the median of the same month in the other years shown, and at least ${ANOM_MIN} cell-days. Partial months are left out.`)}</p>
    ${list}
  </section>`;
}

// ---------- 3) this year vs typical

// ---------- 3) this year so far, against past years
// Like for like: an unfinished month is compared with the same days of that month in past years,
// using the same_days totals the pipeline writes for exactly that window.

function nowVsPast(d, agg, yearFilter) {
  const lastI = d.months.length - 1, last = d.months[lastI];
  const sd = d.manifest.same_days;
  const partial = last.partial && sd && sd.month === last.m && sd.year === last.y;
  const monthName = LONG[last.m - 1];
  let points, now, axisTitle, noun, note;

  if (partial) {
    // 1-N of this month against 1-N of the same month in past years
    const nDays = sd.days;
    points = sd.years.filter((y) => y !== last.y && yearFilter(y))
      .map((y) => ({ year: y, value: agg.sameDays.get(y) || 0 }));
    now = { label: `${last.y}`, value: agg.totals[lastI] };
    axisTitle = `1–${nDays} ${MONTHS[last.m - 1]}, past years`;
    noun = `${monthName}s so far`;
    note = `Each dot is 1–${nDays} ${monthName} of one past year, the same days as ${last.y} so far.`;
  } else {
    // the latest complete month against the same month in past years
    let k = lastI;
    while (k > 0 && d.months[k].partial) k--;
    const info = d.months[k];
    points = [];
    for (let y = d.firstYear; y < info.y; y++) {
      const m = d.monthIndex.get(y * 100 + info.m);
      if (m === undefined || d.months[m].partial || !yearFilter(y)) continue;
      points.push({ year: y, value: agg.totals[m] });
    }
    now = { label: `${info.y}`, value: agg.totals[k] };
    axisTitle = `Past ${LONG[info.m - 1]}s`;
    noun = `${LONG[info.m - 1]}s`;
    note = `Each dot is one past ${LONG[info.m - 1]}.`;
  }
  if (!points.length) return "";
  const title = partial ? `${monthName} 1–${sd.days}, ${last.y} against past years` : `${axisTitle.replace("Past ", "")}, ${now.label} against past years`;
  const tipFor = (p) => tip(`<strong>${fmt(p.value)}</strong> cell-days<br><span class="muted">${p.year}</span>`);
  return `<section class="cblock" data-b="now">
    <h3 class="cb-title">${title}</h3>
    ${distributionStrip({ points, now, axisTitle, tipFor })}
    <p class="reading">${rankSentence({ points, now, noun })}${infoIcon(`${note}<br>Typical is the median of those years.<br><span class="muted">Fire cell-days in the current selection.</span>`)}</p>
  </section>`;
}

function cumulative(d, agg, yearsShown, yearFilter) {
  const Y = d.lastYear, last = d.lastMonth;
  const lines = [];
  for (const y of [...yearsShown].sort((a, b) => a - b)) {
    let c = 0;
    const pts = [];
    for (let m = 1; m <= 12; m++) {
      const i = d.monthIndex.get(y * 100 + m);
      if (i === undefined) { if (pts.length) break; continue; }
      if (!pts.length) pts.push([m - 1, 0]);
      c += agg.totals[i];
      pts.push([m, c]);
    }
    if (pts.length) lines.push({ y, pts, est: y < MEASURED_FROM, now: y === Y, full: pts[0][0] === 0 && pts.length === 13 });
  }
  const nDays = monthDays(last);
  const sameDay = (y) => {
    let c = 0;
    for (let m = 1; m < last.m; m++) { const i = d.monthIndex.get(y * 100 + m); if (i !== undefined) c += agg.totals[i]; }
    if (y === Y || !last.partial) { const i = d.monthIndex.get(y * 100 + last.m); if (i !== undefined) c += agg.totals[i]; }
    else c += agg.sameDays.get(y) || 0;
    return c;
  };
  const others = lines.filter((l) => !l.now && l.full && yearFilter(l.y)).map((l) => l.y);
  const cur = sameDay(Y);
  const rank = others.filter((y) => sameDay(y) > cur).length + 1;
  const dateTxt = `${nDays} ${MONTHS[last.m - 1]}`;
  const headline = others.length
    ? `${rank === 1 ? "The highest" : `The ${ordinal(rank)} highest`} of ${others.length + 1} years at this date.`
    : `${Y} to ${dateTxt}.`;
  const sub = others.length ? `${fmt(cur)} cell-days so far against a typical ${fmt(median(others.map(sameDay)))} by this date (median ${span(others)}).` : "";

  const W = 560, H = 190, padL = 44, padR = 40, padB = 22, padT = 10;
  const max = niceMax(Math.max(1, ...lines.map((l) => l.pts[l.pts.length - 1][1])));
  const x = (m) => padL + (m * (W - padL - padR)) / 12;
  const yy = (v) => padT + (H - padT - padB) * (1 - v / max);
  const path = (l) => `M${l.pts.map(([m, v]) => `${f1(x(m))},${f1(yy(v))}`).join("L")}`;
  const back = lines.filter((l) => !l.now).map((l) => `<path d="${path(l)}" class="cum${l.est ? " est" : ""}"/>`).join("");
  const nowL = lines.find((l) => l.now);
  const end = nowL ? nowL.pts[nowL.pts.length - 1] : null;
  const front = nowL ? `<path d="${path(nowL)}" class="cum-now"/><text x="${f1(x(end[0]) + 5)}" y="${f1(yy(end[1]) + 3.5)}" class="tick strong">${Y}</text>` : "";
  const xt = MONTHS.map((m, k) => `<text x="${f1(x(k + 0.5))}" y="${H - 7}" class="tick" text-anchor="middle">${m[0]}</text>`).join("");
  // crosshair: month ends 1..12
  const full = lines.filter((l) => !l.now && l.full && yearFilter(l.y));
  const rows = MONTHS.map((_, k) => {
    const m = k + 1;
    const vals = full.map((l) => [l.y, l.pts[m][1]]);
    const hiY = vals.reduce((a, b) => (b[1] > a[1] ? b : a), [0, -1]);
    const now = nowL && nowL.pts.find((p) => p[0] === m);
    return `<span class="muted">to the end of ${LONG[k]}</span>${now ? `<br><strong>${fmt(now[1])}</strong> in ${Y}${m === last.m && last.partial ? ` <span class="muted">(to ${dateTxt})</span>` : ""}` : ""}
      ${vals.length ? `<br>${fmt(median(vals.map((v) => v[1])))} typical<br>${fmt(hiY[1])} highest <span class="muted">(${hiY[0]})</span>` : ""}`;
  });
  crosshair("ytd", MONTHS.map((_, k) => x(k + 1)), rows, padT, H - padB);
  return `<section class="cblock" data-b="ytd">
    <h3 class="cb-title">Fire so far this year, against every past year</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Cumulative fire cell-days through the year for every year, ${Y} highlighted. ${headline}.">
      ${axis(max, yy, padL, W - padR)}${back}${front}${xt}
      <path d="M0,0" class="xh" hidden/><rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" class="hit" data-xh="ytd"/></svg>
    <ul class="legend"><li><span class="sw key-cumnow"></span>${Y}</li><li><span class="sw key-cum"></span>other years</li>
      <li><span class="sw key-cum dash"></span>estimated years</li></ul>
    <p class="reading">${headline}${sub ? infoIcon(sub) : ""}</p></section>`;
}

function seasonal(d, agg, medianYears) {
  const per = MONTHS.map((_, k) => medianYears.map((y) => {
    const i = d.monthIndex.get(y * 100 + k + 1);
    return i === undefined || d.months[i].partial ? NaN : agg.totals[i];
  }).filter(Number.isFinite));
  const med = per.map((v) => median(v)), q1 = per.map((v) => quantile(v, 0.25)), q3 = per.map((v) => quantile(v, 0.75));
  const Y = d.lastYear;
  const cur = MONTHS.map((_, k) => {
    const i = d.monthIndex.get(Y * 100 + k + 1);
    return i === undefined ? null : { v: agg.totals[i], partial: d.months[i].partial, nrt: d.months[i].source === "near_real_time" };
  });
  const complete = cur.map((c, k) => (c && !c.partial && Number.isFinite(med[k]) ? k : -1)).filter((k) => k >= 0);
  const above = complete.filter((k) => cur[k].v > med[k]).length;
  const peak = med.reduce((a, v, k) => (v > med[a] ? k : a), 0);
  const headline = complete.length
    ? `${above} of ${complete.length} complete months in ${Y} were above typical`
    : `No complete month yet in ${Y}`;
  const sub = med[peak] > 0 ? `Fire here usually peaks in ${LONG[peak]} (median ${fmt(med[peak])} cell-days, ${span(medianYears)}).` : "";

  const W = 560, H = 170, padL = 44, padR = 40, padB = 22, padT = 10;
  const max = niceMax(Math.max(1, ...q3.filter(Number.isFinite), ...cur.filter(Boolean).map((c) => c.v)));
  const x = (k) => padL + 6 + (k * (W - padL - padR - 12)) / 11;
  const y = (v) => padT + (H - padT - padB) * (1 - (v || 0) / max);
  const band = `M${q3.map((v, k) => `${f1(x(k))},${f1(y(v))}`).join("L")}L${q1.map((v, k) => `${f1(x(k))},${f1(y(v))}`).reverse().join("L")}Z`;
  const medPath = `M${med.map((v, k) => `${f1(x(k))},${f1(y(v))}`).join("L")}`;
  const pts = cur.map((c, k) => (c ? [k, c] : null)).filter(Boolean);
  const curPath = pts.length ? `M${pts.map(([k, c]) => `${f1(x(k))},${f1(y(c.v))}`).join("L")}` : "M0,0";
  const dots = pts.map(([k, c]) => `<circle cx="${f1(x(k))}" cy="${f1(y(c.v))}" r="3.5" class="${c.partial ? "dot-partial" : "dot-now"}"/>`).join("");
  const lastPt = pts[pts.length - 1];
  const endLab = lastPt ? `<text x="${f1(x(lastPt[0]) + 7)}" y="${f1(y(lastPt[1].v) + 3.5)}" class="tick strong">${Y}</text>` : "";
  const xt = MONTHS.map((m, k) => `<text x="${f1(x(k))}" y="${H - 7}" class="tick" text-anchor="middle">${m[0]}</text>`).join("");
  crosshair("season", MONTHS.map((_, k) => x(k)), MONTHS.map((_, k) => {
    const c = cur[k];
    return `<span class="muted">${LONG[k]}</span>${c ? `<br><strong>${fmt(c.v)}</strong> in ${Y}${c.partial ? ` <span class="muted">(partial)</span>` : ""}${c.nrt ? ` <span class="muted">· provisional</span>` : ""}` : ""}
      <br>${fmt(med[k])} typical<br><span class="muted">middle half ${fmt(q1[k])}–${fmt(q3[k])}</span>`;
  }), padT, H - padB);
  return `<section class="cblock" data-b="season">
    <h3 class="cb-title">Each month of ${Y} against a typical year</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Typical fire cell-days by month with ${Y} overlaid. ${headline}.">
      ${axis(max, y, padL, W - padR)}<path d="${band}" class="iqr"/><path d="${medPath}" class="medcurve"/><path d="${curPath}" class="nowcurve"/>${dots}${endLab}${xt}
      <path d="M0,0" class="xh" hidden/><rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" class="hit" data-xh="season"/></svg>
    <ul class="legend">
      <li><span class="sw key-now"></span>${Y}</li>
      <li><span class="sw key-medcurve"></span>typical (median ${span(medianYears)})</li>
      <li><span class="sw key-iqr"></span>middle half of years</li>
      <li><span class="sw key-hollow"></span>partial month</li>
    </ul>
    <p class="reading">${headline}${sub ? infoIcon(sub) : ""}</p></section>`;
}

// ---------- 2) when the fire season runs, by year
// One bar per year from the first month with fire to the last, a dot on the peak month, and the
// bar coloured by that year's total on the fire ramp. Oldest year at the top, so reading down the
// chart is reading forward in time: a season starting earlier shows as bars creeping left.

function seasonBlock(d, agg, years, yearFilter) {
  const ys = [...years].filter(yearFilter).sort((a, b) => a - b);
  const rows = [];
  for (const y of ys) {
    const vs = [];
    let total = 0, est = false, months = 0, anyPartial = false;
    for (let m = 1; m <= 12; m++) {
      const i = d.monthIndex.get(y * 100 + m);
      const v = i === undefined ? 0 : agg.totals[i];
      if (i !== undefined) {
        months++;
        if (d.months[i].partial) anyPartial = true;
        if (isEstimatedSource(d.months[i].source)) est = true;
      }
      vs.push(v);
      total += v;
    }
    // Same rule as the yearly totals chart: a year needs all twelve months, none of them partial.
    // 2000 starts in November, so it has no bar; the current year is kept and marked "to date".
    const partial = months < 12 || anyPartial;
    if (partial && y !== d.lastYear) continue;
    if (total <= 0) continue;
    // The season is where the fire is, not where a single detection is: the months holding the
    // middle 80% of the year's cell-days. A month is split in halves so the edges can fall
    // mid-month, which is what makes a shift of a few weeks visible.
    const edge = (target) => {
      let run = 0;
      for (let m = 0; m < 12; m++) {
        if (run + vs[m] >= target) return m + 1 + (vs[m] > 0 ? (target - run) / vs[m] : 0);
        run += vs[m];
      }
      return 12;
    };
    const first = edge(total * 0.1), last = edge(total * 0.9);
    let peak = 1, peakV = 0;
    vs.forEach((v, k) => { if (v > peakV) { peakV = v; peak = k + 1; } });
    rows.push({ y, first, last, peak, total, est, partial });
  }
  if (rows.length < 3) return "";

  const scale = makeScale(rows.map((r) => r.total));
  const W = 560, padL = 42, padR = 14, padT = 18, rowH = Math.max(7, Math.min(13, Math.floor(260 / rows.length)));
  const H = padT + rows.length * rowH + 22;
  // the domain runs from the start of January (1) to the end of December (13), so December has
  // width and no bar runs off the right edge
  const x = (m) => padL + ((W - padL - padR) * (m - 1)) / 12;
  const barH = Math.max(4, rowH - 3);
  // "mid-May", "late October": name the part of the year an edge falls in
  const partOf = (f) => {
    const m = Math.min(12, Math.max(1, Math.floor(f)));
    const frac = f - m;
    return `${frac < 0.34 ? "early" : frac < 0.67 ? "mid-" : "late "}${LONG[m - 1]}`.replace("early", "early ");
  };

  const bars = rows.map((r, k) => {
    const y0 = padT + k * rowH;
    const x0 = x(r.first), x1 = x(r.last);
    const html = `<strong>${fmt(r.total)}</strong> cell-days in ${r.y}${r.partial ? " <span class=\"muted\">(to date)</span>" : ""}<br>
      <span class="muted">most fire from ${partOf(r.first)} to ${partOf(r.last)}, peak in ${LONG[r.peak - 1]}</span>${r.est ? `<br><span class="muted">estimated from MODIS</span>` : ""}`;
    return `<rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(Math.max(x1 - x0, 2.5))}" height="${barH}" rx="${Math.min(3, barH / 2)}"
        fill="${scale.color(r.total)}" class="sb-bar${r.est ? " est" : ""}${r.partial ? " partial" : ""}"/>
      <circle cx="${f1(x(r.peak + 0.5))}" cy="${f1(y0 + barH / 2)}" r="${Math.min(3, barH / 2 + 0.5)}" class="sb-peak"/>
      ${k % Math.ceil(rows.length / 9) === 0 ? `<text x="${padL - 6}" y="${f1(y0 + barH - 1)}" class="tick" text-anchor="end">${r.y}</text>` : ""}
      <rect x="${padL}" y="${f1(y0)}" width="${W - padL - padR}" height="${barH}" class="hit" tabindex="0"
        aria-label="${r.y}${r.partial ? " to date" : ""}: most fire from ${partOf(r.first)} to ${partOf(r.last)}, peak ${LONG[r.peak - 1]}, ${fmt(r.total)} cell-days" ${tip(html)}/>`;
  }).join("");
  const xt = MONTHS.map((m, k) => (k % 2 === 0 ? `<text x="${f1(x(k + 1.5))}" y="${H - 6}" class="tick" text-anchor="middle">${m}</text>` : "")).join("");

  // How the season edges have moved. Measured years only: estimated years sit about three weeks
  // wider at both ends, and MODIS and VIIRS agree to 0.2 weeks over the same years, so that step
  // is an artefact of the estimation rather than a real shift. With too few measured years, say
  // nothing rather than compare across the step.
  const solid = rows.filter((r) => !r.partial && !r.est && r.y >= MEASURED_FROM);
  const weeks = (months) => { const w = Math.abs(months * 4.35); return `${w.toFixed(w < 2 ? 1 : 0)} week${w >= 1.5 ? "s" : ""}`; };
  let reading = "";
  if (solid.length >= 9) {
    const third = Math.max(3, Math.floor(solid.length / 3));
    const early = solid.slice(0, third), late = solid.slice(-third);
    const mean = (arr, key) => arr.reduce((a, r) => a + r[key], 0) / arr.length;
    const dStart = mean(late, "first") - mean(early, "first");
    const dEnd = mean(late, "last") - mean(early, "last");
    const part = [];
    if (Math.abs(dStart) >= 0.25) part.push(`starts about ${weeks(dStart)} ${dStart < 0 ? "earlier" : "later"}`);
    if (Math.abs(dEnd) >= 0.25) part.push(`ends about ${weeks(dEnd)} ${dEnd > 0 ? "later" : "earlier"}`);
    const early1 = `${early[0].y}–${early[early.length - 1].y}`;
    reading = part.length
      ? `Against ${early1}, the season now ${part.join(" and ")}.`
      : `The season runs at about the same time as in ${early1}.`;
  }

  return `<section class="cblock" data-b="season-timing">
    <h3 class="cb-title">When the fire season runs, ${rows[0].y} to ${rows[rows.length - 1].y}</h3>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="The part of each year holding most of its fire, oldest at the top, with the peak month marked">
      ${bars}${xt}</svg>
    <ul class="legend">
      <li><span class="sw" style="background:${RAMP[1]}"></span><span class="sw" style="background:${RAMP[3]}"></span><span class="sw" style="background:${RAMP[5]}"></span>&nbsp;less to more fire that year</li>
      <li><span class="sw key-peak"></span>peak month</li>
    </ul>
    <p class="reading">${reading}${infoIcon(`Each bar spans the months holding the middle 80% of that year's fire cell-days in the current selection, so a few early or late detections do not stretch it. The dot marks the month with the most fire.<br>
      Years without twelve complete months are left out; the current year is shown to date.<br>
      ${reading ? `The comparison uses measured years only (${MEASURED_FROM} onwards): estimated years run about three weeks wider at both ends, which is an artefact of the estimation, not a real shift.<br>` : ""}
      <span class="muted">Years estimated from MODIS are outlined.</span>`)}</p>
  </section>`;
}

// ---------- raw view: each satellite's own yearly cell-days

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
  const W = 560, H = 210, padL = 44, padR = 96, padB = 22, padT = 12;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.pts.filter(Number.isFinite))));
  const x = (j) => padL + (j * (W - padL - padR)) / Math.max(ys.length - 1, 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const step = ys.indexOf(MEASURED_FROM);
  const stepLine = step > 0 ? `<path d="M${f1(x(step))},${padT}V${H - padB}" class="stepline"/>
    <text x="${f1(x(step) + 4)}" y="${padT + 10}" class="tick strong">VIIRS starts</text>` : "";
  const lines = series.map((s) => {
    let dpath = "", pen = false, lastJ = -1;
    s.pts.forEach((v, j) => {
      if (!Number.isFinite(v)) { pen = false; return; }
      dpath += `${pen ? "L" : "M"}${f1(x(j))},${f1(y(v))}`;
      pen = true; lastJ = j;
    });
    s.end = lastJ >= 0 ? { x: x(lastJ) + 6, y: y(s.pts[lastJ]) + 4 } : null;
    return `<path d="${dpath || "M0,0"}" class="rawline ${s.inst}${s.dash ? " dash" : ""}"/>`;
  }).join("");
  const ends = series.filter((s) => s.end).sort((a, b) => a.end.y - b.end.y);
  for (let k = 1; k < ends.length; k++) ends[k].end.y = Math.max(ends[k].end.y, ends[k - 1].end.y + 12);
  const over = ends.length ? ends[ends.length - 1].end.y - (H - padB) : 0;
  if (over > 0) ends.forEach((s) => { s.end.y -= over; });
  const labels = ends.map((s) => `<text x="${f1(s.end.x)}" y="${f1(s.end.y)}" class="tick strong">${s.name}</text>`).join("");
  const every = ys.length > 16 ? 5 : 1;
  const xt = ys.map((yy, j) => (yy % every === 0 ? `<text x="${f1(x(j))}" y="${H - 7}" class="tick" text-anchor="middle">${yy}</text>` : "")).join("");
  crosshair("raw", ys.map((_, j) => x(j)), ys.map((yr, j) => `<span class="muted">${yr}, raw cell-days</span>${series
    .filter((s) => Number.isFinite(s.pts[j])).map((s) => `<br><strong>${fmt(s.pts[j])}</strong> ${s.name}`).join("")}`), padT, H - padB);
  return `<section class="cblock" data-b="raw">
    <p class="kicker">Yearly totals by satellite, raw</p>
    <p class="headline">Each satellite's own count, not converted${infoIcon("VIIRS sees about four times more fire cell-days than MODIS, so the raw record steps up in 2012. Trends and unusual months are in the harmonised view.")}</p>
    <svg viewBox="0 0 ${W} ${H}" class="ychart" role="img" aria-label="Raw fire cell-days per year for each satellite">
      ${axis(max, y, padL, W - padR)}${stepLine}${lines}${labels}${xt}
      <path d="M0,0" class="xh" hidden/><rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" class="hit" data-xh="raw"/></svg>
    <ul class="legend">${SENSORS.map(([, n, inst, dash]) => `<li><span class="sw key-${inst}${dash ? " dash" : ""}"></span>${n}</li>`).join("")}</ul>
  </section>`;
}

// ---------- patching in place, so marks animate between selections

const sig = (n) => (n.nodeType === 1 ? `${n.nodeName}(${[...n.childNodes].map(sig).join(",")})` : "#");
function patch(a, b) {
  if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (a.nodeName === "INPUT") { a.checked = b.hasAttribute("checked"); a.disabled = b.hasAttribute("disabled"); }
  const ac = a.childNodes, bc = b.childNodes;
  for (let k = 0; k < ac.length; k++) patch(ac[k], bc[k]);
}
function morph(el, html) {
  const next = document.createElement("div");
  next.innerHTML = html;
  const nb = [...next.children], ob = [...el.children];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || nb.length !== ob.length || nb.some((b, k) => b.dataset.b !== ob[k].dataset.b)) {
    el.replaceChildren(...nb);
    if (!reduce) nb.forEach((b) => b.classList.add("fadein"));
    return;
  }
  nb.forEach((b, k) => {
    const a = ob[k];
    if (sig(a) === sig(b)) patch(a, b);
    else { b.classList.add("fadein"); a.replaceWith(b); }
  });
}

// ---------- tooltips, crosshairs and the estimated-years switch (bound once)

let LAST = null;
function bind(el) {
  if (el.dataset.bound) return;
  el.dataset.bound = "1";
  const tipEl = document.getElementById("tip");
  const show = (html, px, py) => {
    tipEl.innerHTML = html;
    tipEl.hidden = false;
    const r = tipEl.getBoundingClientRect();
    tipEl.style.left = `${Math.max(8, Math.min(px + 14, innerWidth - r.width - 8))}px`;
    tipEl.style.top = `${Math.max(8, Math.min(py + 14, innerHeight - r.height - 8))}px`;
  };
  const hideXh = () => el.querySelectorAll(".xh:not([hidden])").forEach((p) => p.setAttribute("hidden", ""));
  const hide = () => { tipEl.hidden = true; hideXh(); };
  el.addEventListener("pointermove", (e) => {
    if (e.target.closest(".info-i")) return;
    const t = e.target.closest("[data-tip]");
    if (t) { hideXh(); show(TIPS[+t.dataset.tip], e.clientX, e.clientY); return; }
    const o = e.target.closest("[data-xh]");
    const spec = o && XH[o.dataset.xh];
    if (!spec) { hide(); return; }
    const svg = o.ownerSVGElement, r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) * svg.viewBox.baseVal.width) / r.width;
    let k = 0;
    spec.xs.forEach((xv, j) => { if (Math.abs(xv - vx) < Math.abs(spec.xs[k] - vx)) k = j; });
    const line = svg.querySelector(".xh");
    line.setAttribute("d", `M${f1(spec.xs[k])},${spec.top}V${spec.bottom}`);
    line.removeAttribute("hidden");
    show(spec.rows[k], e.clientX, e.clientY);
  });
  el.addEventListener("pointerleave", hide);
  el.addEventListener("focusin", (e) => {
    const t = e.target.closest("[data-tip]");
    if (t) { const r = t.getBoundingClientRect(); show(TIPS[+t.dataset.tip], r.left + r.width / 2, r.top); }
    const li = e.target.closest("[data-hl]");
    if (li) highlight(li.dataset.hl);
  });
  el.addEventListener("focusout", (e) => { if (!e.target.closest(".info-i")) tipEl.hidden = true; highlight(null); });
  const highlight = (m) => {
    el.querySelectorAll(".mbar.hl").forEach((n) => n.classList.remove("hl"));
    if (m != null) el.querySelectorAll(`.mbar[data-m="${m}"]`).forEach((n) => n.classList.add("hl"));
  };
  el.addEventListener("pointerover", (e) => {
    const li = e.target.closest("[data-hl]");
    highlight(li ? li.dataset.hl : null);
  });
  el.addEventListener("change", (e) => {
    if (e.target.id !== "trend-est" || !LAST) return;
    includeEst = e.target.checked;
    renderCompare(...LAST);
  });
}

export function renderCompare(el, d, agg, opts) {
  LAST = [el, d, agg, opts];
  bind(el);
  TIPS = [];
  XH = {};
  const { yearFilter, totals, mode = "harmonised", years, medianYears = [] } = opts;
  if (mode === "raw") { morph(el, rawYearly(d, agg, years)); return; }
  const observedOnly = !yearFilter(MEASURED_FROM - 1);
  // widest timescale first, narrowing: years, then the season's shape, then this year, then months
  morph(el, trendBlock(d, totals, yearFilter, observedOnly)
    + seasonBlock(d, agg, years, yearFilter)
    + nowVsPast(d, agg, yearFilter)
    + cumulative(d, agg, years, yearFilter)
    + seasonal(d, agg, medianYears)
    + anomalyBlock(d, agg, years));
}
