// Live mode blocks, widest context first:
//   1 this window against the same calendar window in past years
//   2 new and continuing cells: is the fire spreading or dying down
//
// The old hourly bars split by satellite showed satellite overpass timing rather than fire, so
// they are gone; the per-satellite counts live behind the summary's info icon.
//
// Most of the year Canada has almost no fire, so a window often holds a handful of hotspots.
// Under MIN_FOR_CHART a chart would be an empty grid, and each block states its one fact instead.

import { latLngToCell } from "h3-js";
import { cellIndexOf, fmt, median } from "./data.js";
import { infoIcon } from "./info.js";
import { distributionStrip } from "./strip.js";

const H = 3600e3, D = 24 * H;
const MIN_FOR_CHART = 20;
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function liveWindow(hours, now = Date.now()) {
  if (hours >= 168) {
    const end = Math.floor(now / D) * D + D; // end of today (UTC)
    return { start: end - 7 * D, end, step: D, unit: "day" };
  }
  const end = Math.ceil(now / H) * H;
  return { start: end - hours * H, end, step: H, unit: "hour" };
}

// The same calendar window in each past year, from the record's monthly VIIRS detections.
// Monthly totals are the finest the static export carries, so a window shorter than a month is
// scaled by its share of that month; the info icon says so.
function pastWindows(d, agg, hours, now = Date.now()) {
  const end = new Date(now);
  const m = end.getUTCMonth() + 1, thisYear = end.getUTCFullYear();
  const days = hours / 24;
  const daysInMonth = new Date(Date.UTC(thisYear, m, 0)).getUTCDate();
  const share = Math.min(1, days / daysInMonth);
  const viirs = ["snpp", "noaa20"].map((p) => agg.detOf(p));
  const points = [];
  for (let y = 2012; y < thisYear; y++) { // VIIRS only: hotspot counts must compare like with like
    const i = d.monthIndex.get(y * 100 + m);
    if (i === undefined || d.months[i].partial) continue;
    points.push({ year: y, value: viirs.reduce((a, v) => a + v[i], 0) * share });
  }
  return { points, month: m, share, days, daysInMonth };
}

// Where the fire is, for the sparse case: the grid cell with the most hotspots.
let placeNamer = null;
export function setLivePlaceNamer(fn) { placeNamer = fn; }
function cellCounts(d, feats, since = -Infinity) {
  const counts = new Map();
  for (const f of feats) {
    if (f.properties.t < since) continue;
    const [lon, lat] = f.geometry.coordinates;
    const i = cellIndexOf(d, latLngToCell(lat, lon, 5));
    if (i !== undefined) counts.set(i, (counts.get(i) || 0) + 1);
  }
  return counts;
}
function largestCluster(d, feats) {
  const counts = cellCounts(d, feats);
  if (!counts.size) return "";
  const [i, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
  const name = placeNamer && placeNamer(d.lat[i], d.lon[i]);
  return name ? `near ${name} (${n} hotspot${n === 1 ? "" : "s"})` : "";
}

const windowPhrase = (label) => label.replace("last ", "");

function vsPastBlock(d, agg, feats, hours, windowLabel) {
  const past = pastWindows(d, agg, hours);
  const nowVal = feats.length;
  const monthName = LONG[past.month - 1];
  const detail = `Each dot is the same ${past.days}-day window of one past year, from this selection's VIIRS detections in the harmonised record.<br>
    Monthly totals are the finest the record carries, so each past year's ${monthName} is scaled to ${past.days} of its ${past.daysInMonth} days.<br>
    <span class="muted">Both sides are hotspot counts, so they compare directly. Live hotspots are near real time and not harmonised.</span>`;

  if (past.points.length < 5) {
    return `<section class="cblock" data-b="live-past">
      <h3 class="cb-title">This window against past years</h3>
      <p class="reading">Too few past years with VIIRS data in this selection to compare.${infoIcon(detail)}</p>
    </section>`;
  }
  const typical = median(past.points.map((p) => p.value));
  const usual = typical < 1 ? "almost none" : `about ${fmt(typical)}`;
  if (nowVal < MIN_FOR_CHART) {
    const biggest = largestCluster(d, feats);
    return `<section class="cblock" data-b="live-past">
      <h3 class="cb-title">This window against past years</h3>
      <p class="reading"><strong class="lead">${fmt(nowVal)}</strong> hotspot${nowVal === 1 ? "" : "s"} in the ${windowPhrase(windowLabel)};
        mid-${monthName} usually sees ${usual}.${biggest ? ` The largest cluster is ${biggest}.` : ""}${infoIcon(detail)}</p>
    </section>`;
  }
  return `<section class="cblock" data-b="live-past">
    <h3 class="cb-title">This window against the same days in past years</h3>
    ${distributionStrip({ points: past.points, now: { label: "Now", value: nowVal },
      axisTitle: `Same ${past.days}-day window of past ${monthName}s`, unit: "hotspots" })}
    <p class="reading">${fmt(nowVal)} hotspots in the ${windowPhrase(windowLabel)}; ${monthName} usually sees ${usual}.${infoIcon(detail)}</p>
  </section>`;
}

// Cells burning for the first time in this window, against cells that were already burning in the
// window before it. The live feed reaches back about twice the window, so both sides are equal.
function newVsContinuingBlock(d, feats, hours, windowLabel, prior) {
  const phrase = windowPhrase(windowLabel);
  const span = hours * H;
  const earlier = (prior && prior.earlier) || [];
  // How far back the feed reached before this window: without a full window of history the split
  // would call everything new, so the block says so rather than misleading.
  // Judge by the rows actually returned: FIRMS day ranges are whole UTC days, so a request for
  // "2 days" early in the day can come back with nothing before this window at all.
  const oldest = earlier.length ? Math.min(...earlier.map((f) => f.properties.t)) : null;
  const covered = oldest === null ? 0 : (Date.now() - span) - oldest;
  const enoughHistory = earlier.length > 0 && covered >= span * 0.5;
  const now = cellCounts(d, feats);
  const before = new Set(cellCounts(d, earlier).keys());
  const fresh = [...now.keys()].filter((i) => !before.has(i)).length;
  const cont = [...now.keys()].filter((i) => before.has(i)).length;
  const total = fresh + cont;
  const detail = `Grid cells (~250 km²) with at least one hotspot in the ${phrase}, split by whether the same cell also had one in the ${phrase} before it.<br>
    <span class="muted">Near real time, not harmonised. Cells, not hotspots, so one cell seen many times counts once.</span>`;
  // Shown only when both windows have data. Without a previous window to compare with, every cell
  // would read as new, so the block is left out rather than explained away on the main screen.
  if (total < 3 || !enoughHistory) return "";

  if (total < 3) {
    return `<section class="cblock" data-b="live-new">
      <h3 class="cb-title">New and continuing</h3>
      <p class="reading">${total === 0 ? `No grid cells with fire in the ${phrase}.`
        : `${total} cell${total === 1 ? "" : "s"} with fire: ${fresh} new, ${cont} already burning.`}${infoIcon(detail)}</p>
    </section>`;
  }
  const W = 560, Hh = 78, padL = 104, padR = 56, barH = 22, gap = 12;
  const max = Math.max(fresh, cont, 1);
  const x = (v) => (W - padL - padR) * (v / max);
  const row = (label, n, y, cls) => `
    <text x="${padL - 10}" y="${y + barH - 7}" class="tick" text-anchor="end">${label}</text>
    <rect x="${padL}" y="${y}" width="${Math.max(x(n), 2).toFixed(1)}" height="${barH}" rx="4" class="${cls}"/>
    <text x="${(padL + Math.max(x(n), 2) + 8).toFixed(1)}" y="${y + barH - 7}" class="tick strong">${fmt(n)}</text>`;
  const share = Math.round((fresh / total) * 100);
  const reading = fresh > cont
    ? `Fire is spreading: ${share}% of the cells burning now were not burning in the ${phrase} before.`
    : fresh === cont ? "An even split between new and continuing cells."
      : `Fire is mostly staying put: ${100 - share}% of the cells burning now were already burning.`;
  return `<section class="cblock" data-b="live-new">
    <h3 class="cb-title">New and continuing cells</h3>
    <svg viewBox="0 0 ${W} ${Hh}" class="ychart" role="img" aria-label="New cells ${fresh}, already burning ${cont}">
      ${row("new this window", fresh, 10, "lv-new")}
      ${row("already burning", cont, 10 + barH + gap, "lv-cont")}
    </svg>
    <p class="reading">${reading}${infoIcon(detail)}</p>
  </section>`;
}

export function renderLiveChart(el, feats, hours, d, agg, windowLabel, prior) {
  const win = liveWindow(hours);
  const n20 = feats.filter((f) => f.properties.sat !== "NOAA-21").length;
  el.innerHTML = d && agg
    ? vsPastBlock(d, agg, feats, hours, windowLabel) + newVsContinuingBlock(d, feats, hours, windowLabel, prior)
    : "";
  return { total: feats.length, start: win.start, end: Math.min(win.end, Date.now()), n20, n21: feats.length - n20 };
}
