// "Why it burned": one card about a single place and window.
//
// Ways in: clicking a cell on the fire map (that cell, the current dates or live window), or
// clicking a month in the calendar (the selection box, that month). It always renders in the side
// panel directly below the main fire chart, never over the map.
//
// Stage A uses only what the browser already holds. Stage B adds cause, burned area and land
// cover from a separate export, loaded when the card opens.

import { MONTHS, fmt, fmtShort, isEstimated, median, quantile } from "./data.js";
import { infoIcon } from "./info.js";
import { mannKendall, theilSen } from "./compare.js";

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

// Yearly totals for one cell across the whole record, plus the months it burned in.
function cellHistory(d, i) {
  const byYear = new Map(), byMonth = new Array(12).fill(0);
  let total = 0;
  for (let r = d.rowStart[i]; r < d.rowStart[i + 1]; r++) {
    const mi = d.rowMonth[r], v = d.rowValue[r];
    if (!(v > 0)) continue;
    const info = d.months[mi];
    byYear.set(info.y, (byYear.get(info.y) || 0) + v);
    byMonth[info.m - 1] += v;
    total += v;
  }
  return { byYear, byMonth, total };
}

// Where this cell sits among the cells of its own ecozone, over the same window.
function ecozonePercentile(d, agg, i, range) {
  const zone = d.region[i];
  const mine = windowTotal(d, i, range);
  const peers = [];
  for (let k = 0; k < d.lat.length; k++) {
    if (d.region[k] !== zone) continue;
    if (!d.canada[k] && d.rowStart[k + 1] === d.rowStart[k]) continue;
    peers.push(windowTotal(d, k, range));
  }
  if (peers.length < 20) return null;
  const below = peers.filter((v) => v < mine).length;
  return { pct: Math.round((below / peers.length) * 100), n: peers.length, zone: d.manifest.regions[zone] || "" };
}

function windowTotal(d, i, range) {
  let v = 0;
  for (let r = d.rowStart[i]; r < d.rowStart[i + 1]; r++) {
    const m = d.rowMonth[r];
    if (m >= range[0] && m <= range[1]) v += d.rowValue[r];
  }
  return v;
}

// The cell's own trend over the complete years in the range, same test as the map layer.
function cellTrend(d, i, range) {
  const years = [];
  for (let y = d.months[range[0]].y; y <= d.months[range[1]].y; y++) {
    let months = 0, partial = false;
    for (let m = 1; m <= 12; m++) {
      const k = d.monthIndex.get(y * 100 + m);
      if (k === undefined || k < range[0] || k > range[1]) continue;
      months++;
      if (d.months[k].partial) partial = true;
    }
    if (months === 12 && !partial) years.push(y);
  }
  if (years.length < 8) return null;
  const slot = new Map();
  years.forEach((y, k) => { for (let m = 1; m <= 12; m++) { const j = d.monthIndex.get(y * 100 + m); if (j !== undefined) slot.set(j, k); } });
  const sums = new Array(years.length).fill(0);
  let total = 0;
  for (let r = d.rowStart[i]; r < d.rowStart[i + 1]; r++) {
    const k = slot.get(d.rowMonth[r]);
    if (k === undefined) continue;
    sums[k] += d.rowValue[r];
    total += d.rowValue[r];
  }
  if (total < 20) return null;
  const mk = mannKendall(sums);
  const fit = theilSen(years, sums, mk.varS);
  if (mk.p > 0.1 || fit.b === 0) return null;
  return { dir: fit.b > 0 ? "rising" : "falling", years: `${years[0]}–${years[years.length - 1]}` };
}

const row = (label, value) => `<div class="wc-row"><dt>${label}</dt><dd>${value}</dd></div>`;

// subject: { i, place, range, label } for a cell, or a month of the whole box.
export function renderWhyCard(el, d, agg, subject, live) {
  const { i, place, range, windowLabel, scope } = subject;
  const isCell = i !== undefined && i !== null;
  const hist = isCell ? cellHistory(d, i) : null;
  const inWindow = isCell ? windowTotal(d, i, range) : boxWindowTotal(d, agg, range);

  // live block, when the card was opened in live mode
  let liveBlock = "";
  if (live && live.feats) {
    const fs = live.feats;
    const times = fs.map((f) => f.properties.t).sort((a, b) => a - b);
    const night = fs.filter((f) => f.properties.dn === "N").length;
    const frps = fs.map((f) => +f.properties.frp).filter(Number.isFinite).sort((a, b) => a - b);
    const t = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    const third = (lo, hi) => frps.filter((v) => v >= lo && v < hi).length;
    const lo = quantile(frps, 1 / 3), mid = quantile(frps, 2 / 3);
    liveBlock = `<div class="wc-live">
      <p class="wc-kicker">${live.windowLabel}</p>
      <dl class="wc-rows">
        ${row("Hotspots", fs.length.toLocaleString("en-CA"))}
        ${times.length ? row("First detection", `${t(times[0])} UTC`) : ""}
        ${times.length ? row("Last detection", `${t(times[times.length - 1])} UTC`) : ""}
        ${fs.length ? row("At night", `${Math.round((night / fs.length) * 100)}%`) : ""}
        ${frps.length >= 3 ? row("Intensity", `${Math.round((third(-Infinity, lo) / frps.length) * 100)}% low · ${Math.round((third(lo, mid) / frps.length) * 100)}% middle · ${Math.round((frps.filter((v) => v >= mid).length / frps.length) * 100)}% high`) : ""}
      </dl>
    </div>`;
  }

  // Stage A history
  const rows = [];
  const histLabel = live ? subject.recordLabel || "" : windowLabel;
  const histValue = live && hist ? hist.total : inWindow;
  rows.push(row("Fire cell-days", `${fmt(histValue)}${histLabel ? ` <span class="muted">${histLabel}</span>` : ""}`));
  if (hist) {
    const peak = hist.byMonth.indexOf(Math.max(...hist.byMonth));
    const years = [...hist.byYear.entries()].sort((a, b) => b[1] - a[1]);
    const withFire = hist.byYear.size;
    const lastYear = Math.max(...hist.byYear.keys());
    const span = d.lastYear - d.firstYear + 1;
    if (hist.total > 0) {
      rows.push(row("Usual peak month", LONG[peak]));
      rows.push(row("Busiest year", `${years[0][0]} <span class="muted">${fmt(years[0][1])} cell-days</span>`));
      rows.push(row("Years with fire", `${withFire} of ${span}`));
      rows.push(row("Last burned", String(lastYear)));
    }
    const people = d.pop[i];
    rows.push(row("People living here", people >= 1 ? fmtShort(Math.round(people)) : people > 0 ? people.toFixed(2) : "0"));
    const tr = cellTrend(d, i, range);
    if (tr) rows.push(row("Where fire is changing", `${tr.dir} <span class="muted">${tr.years}</span>`));
    const ez = ecozonePercentile(d, agg, i, range);
    if (ez) rows.push(row("In its ecozone", `${ez.pct}th percentile <span class="muted">of ${fmt(ez.n)} cells in ${ez.zone}</span>`));
  }

  const sources = `Fire cell-days and history from the harmonised record.<br>
    Percentile compares this cell with every cell of the same ecozone over the same window.<br>
    People: WorldPop 2020, a modelled estimate.<br>
    <span class="muted">Where fire is changing is shown only when the cell's own trend is statistically significant (p ≤ 0.1).</span>`;

  el.innerHTML = `<div class="wc" role="region" aria-label="Why it burned: ${place}">
    <div class="wc-head">
      <div>
        <p class="wc-kicker">${scope === "month" ? "Selected area" : "Selected cell"}</p>
        <h3 class="wc-place">${place}</h3>
      </div>
      <button type="button" class="wc-close" aria-label="Close this card">×</button>
    </div>
    ${liveBlock}
    ${liveBlock ? `<p class="wc-kicker wc-past">Past fire here</p>` : ""}
    <dl class="wc-rows">${rows.join("")}</dl>
    <p class="wc-foot">Sources${infoIcon(sources)}</p>
  </div>`;
  el.hidden = false;
}

function boxWindowTotal(d, agg, range) {
  let v = 0;
  for (let k = range[0]; k <= range[1]; k++) v += agg.totals[k];
  return v;
}

export function closeWhyCard(el) {
  el.hidden = true;
  el.innerHTML = "";
}
