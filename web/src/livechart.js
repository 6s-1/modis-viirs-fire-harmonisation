// Live chart: near-real-time hotspots per hour (24 h, 48 h) or per day (7 d) in the selection,
// stacked by satellite (NOAA-20, NOAA-21). Unharmonised.

import { fmt } from "./data.js";
import { infoIcon } from "./info.js";

const SATS = [["NOAA-20", "#f59450"], ["NOAA-21", "#c9cdd4"]];
const H = 3600e3, D = 24 * H;

export function liveWindow(hours, now = Date.now()) {
  if (hours >= 168) {
    const end = Math.floor(now / D) * D + D; // end of today (UTC)
    return { start: end - 7 * D, end, step: D, unit: "day" };
  }
  const end = Math.ceil(now / H) * H;
  return { start: end - hours * H, end, step: H, unit: "hour" };
}

export function renderLiveChart(el, feats, hours) {
  const win = liveWindow(hours);
  const n = Math.round((win.end - win.start) / win.step);
  const bins = Array.from({ length: n }, () => [0, 0]);
  for (const f of feats) {
    const k = Math.floor((f.properties.t - win.start) / win.step);
    if (k < 0 || k >= n) continue;
    bins[k][f.properties.sat === "NOAA-21" ? 1 : 0]++;
  }
  const W = 560, Hh = 200, padL = 40, padR = 70, padB = 24, padT = 10;
  const peak = Math.max(0, ...bins.map(([a, b]) => a + b));
  const max = Math.max(2, peak % 2 ? peak + 1 : peak); // even, so the middle tick is a whole number
  const bw = (W - padL - padR) / n;
  const y = (v) => padT + (Hh - padT - padB) * (1 - v / max);
  const label = (k) => {
    const t = new Date(win.start + k * win.step);
    return win.unit === "day" ? `${t.getUTCDate()} ${t.toLocaleString("en-CA", { month: "short", timeZone: "UTC" })}`
      : `${String(t.getUTCHours()).padStart(2, "0")}:00`;
  };
  const ticks = [0, max / 2, max].map((v) => `<g><line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
      <text x="${padL - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${Math.round(v).toLocaleString("en-CA")}</text></g>`).join("");
  const every = win.unit === "day" ? 1 : hours > 24 ? 6 : 3;
  const bars = bins.map(([a, b], k) => {
    const x = padL + k * bw + 0.5, w = Math.max(bw - 1, 1);
    const t = label(k);
    const tip = `${win.unit === "day" ? t : `${t} UTC`}: ${a + b} hotspots (NOAA-20 ${a}, NOAA-21 ${b})`;
    return `<g><title>${tip}</title>
      <rect x="${x}" y="${y(a)}" width="${w}" height="${Math.max(y(0) - y(a), 0)}" fill="${SATS[0][1]}"/>
      <rect x="${x}" y="${y(a + b)}" width="${w}" height="${Math.max(y(a) - y(a + b), 0)}" fill="${SATS[1][1]}"/>
      ${k % every === 0 ? `<text x="${x + w / 2}" y="${Hh - 8}" class="tick" text-anchor="middle">${t}</text>` : ""}</g>`;
  }).join("");
  // direct labels on the last non-empty bar
  const lastK = bins.map(([a, b]) => a + b).findLastIndex((v) => v > 0);
  const lab = lastK >= 0 ? (() => {
    const [a, b] = bins[lastK], x = W - padR + 6;
    return `<text x="${x}" y="${y(a / 2) + 4}" class="tick strong">NOAA-20</text>${b ? `<text x="${x}" y="${y(a + b / 2) + 4}" class="tick strong">NOAA-21</text>` : ""}`;
  })() : "";
  const total = bins.reduce((s, [a, b]) => s + a + b, 0);
  const startTxt = new Date(win.start).toISOString().slice(0, 16).replace("T", " ");
  const endTxt = new Date(Math.min(win.end, Date.now())).toISOString().slice(0, 16).replace("T", " ");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" class="ychart" role="img" aria-label="Live hotspots per ${win.unit} by satellite">${ticks}${bars}${lab}</svg>
    <ul class="legend">${SATS.map(([n, c]) => `<li><span class="sw" style="background:${c}"></span>${n}</li>`).join("")}
      <li>${infoIcon(`${fmt(total)} hotspots, counted per ${win.unit}, ${startTxt} – ${endTxt} UTC.<br><span class="muted">Near real time, not harmonised.</span>`)}</li></ul>`;
  return { total, start: win.start, end: Math.min(win.end, Date.now()) };
}
