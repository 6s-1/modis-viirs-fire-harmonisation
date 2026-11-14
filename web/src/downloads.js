// Downloads: harmonised monthly values per cell, raw hotspots from static tiles, calendar as PNG.

import { MONTHS, SOURCE_LABEL, fmt, h3Id, isEstimated, uncertaintyFactors } from "./data.js";
import { RAMP } from "./calendar.js";

const MAX_HOTSPOT_ROWS = 1_500_000;

export function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const ym = (info) => `${info.y}-${String(info.m).padStart(2, "0")}`;
export const fileStem = (box, d, range) =>
  `S${box.south.toFixed(2)}_N${box.north.toFixed(2)}_W${box.west.toFixed(2)}_E${box.east.toFixed(2)}_${ym(d.months[range[0]])}_${ym(d.months[range[1]])}`;

// One row per display cell and month with fire in the selection and date range.
export function monthlyCSV(d, agg, range) {
  const cellArea = d.manifest.grid.cell_area_km2;
  const head = ["cell_h3", "cell_lat", "cell_lon", "ecozone", "province", "year", "month", "fire_cell_days",
    "source", "partial_month", "likely_low", "likely_high"];
  const lines = [head.join(",")];
  const q = (src) => uncertaintyFactors(d, cellArea, "month", src);
  for (const i of agg.cells) {
    const id = h3Id(d, i);
    const reg = d.manifest.regions[d.region[i]] || "";
    const prov = d.manifest.provinces[d.province[i]] || "";
    for (let r = d.rowStart[i]; r < d.rowStart[i + 1]; r++) {
      const mi = d.rowMonth[r];
      if (mi < range[0] || mi > range[1]) continue;
      const info = d.months[mi], v = d.rowValue[r], f = q(info.source);
      lines.push([id, d.lat[i].toFixed(4), d.lon[i].toFixed(4), `"${reg}"`, `"${prov}"`, info.y, info.m, v.toFixed(3),
        info.source, info.partial, f ? (v * f[0]).toFixed(3) : "", f ? (v * f[2]).toFixed(3) : ""].join(","));
    }
  }
  return new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
}

async function gunzipText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return new TextDecoder().decode(u8); // already decoded by the server
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

let indexCache = null;
export async function hotspotIndex(base = "hotspots/") {
  if (!indexCache) {
    const r = await fetch(base + "index.json");
    if (!r.ok) throw new Error("hotspot index not found");
    indexCache = await r.json();
  }
  return indexCache;
}

// Tiles the selection and date range need, with an upper bound on rows.
export async function hotspotPlan(box, d, range) {
  const idx = await hotspotIndex();
  const y0 = d.months[range[0]].y, y1 = d.months[range[1]].y, deg = idx.tile_deg;
  const tiles = idx.tiles.filter((t) => t.y >= y0 && t.y <= y1 &&
    t.lat0 + deg > box.south && t.lat0 < box.north && t.lon0 + deg > box.west && t.lon0 < box.east);
  return { idx, tiles, rows: tiles.reduce((s, t) => s + t.rows, 0), bytes: tiles.reduce((s, t) => s + t.bytes, 0),
    tooBig: tiles.reduce((s, t) => s + t.rows, 0) > MAX_HOTSPOT_ROWS };
}

export async function hotspotsCSV(box, d, range, plan, onProgress) {
  const a = d.months[range[0]], b = d.months[range[1]];
  const start = `${ym(a)}-01`;
  const endDay = new Date(Date.UTC(b.y, b.m, 0)).getUTCDate();
  const end = `${ym(b)}-${String(endDay).padStart(2, "0")}`;
  const parts = [plan.idx.columns.join(",") + "\n"];
  let kept = 0, done = 0;
  for (const t of plan.tiles) {
    const r = await fetch(`hotspots/${t.y}/${t.lat0}_${t.lon0}.csv.gz`);
    if (!r.ok) throw new Error(`tile ${t.y}/${t.lat0}_${t.lon0}: ${r.status}`);
    const text = await gunzipText(await r.arrayBuffer());
    let out = "";
    let p = 0;
    while (p < text.length) {
      let e = text.indexOf("\n", p);
      if (e < 0) e = text.length;
      const line = text.slice(p, e);
      p = e + 1;
      if (!line) continue;
      const c1 = line.indexOf(","), c2 = line.indexOf(",", c1 + 1), c3 = line.indexOf(",", c2 + 1);
      const lat = +line.slice(0, c1), lon = +line.slice(c1 + 1, c2), date = line.slice(c2 + 1, c3);
      if (lat < box.south || lat > box.north || lon < box.west || lon > box.east || date < start || date > end) continue;
      out += line + "\n";
      kept++;
    }
    parts.push(out);
    onProgress?.(++done, plan.tiles.length, kept);
  }
  return { blob: new Blob(parts, { type: "text/csv" }), rows: kept };
}

// Calendar as a PNG, drawn on a canvas (light theme).
export function calendarPNG(d, agg, cal, opts) {
  const { years, title, subtitle, lowConfidence } = opts;
  const cw = 46, ch = 20, gap = 2, left = 120, top = 118, totW = 190, pad = 20;
  const W = left + 12 * (cw + gap) + totW + pad, H = top + (years.length + 1) * (ch + gap) + 80;
  const scaleK = 2;
  const cv = document.createElement("canvas");
  cv.width = W * scaleK; cv.height = H * scaleK;
  const g = cv.getContext("2d");
  g.scale(scaleK, scaleK);
  const INK = "#0b0b0b", INK2 = "#52514e", ZERO = "#ecebe7", LINE = "#e4e3df";
  g.fillStyle = "#fcfcfb"; g.fillRect(0, 0, W, H);
  g.fillStyle = INK; g.font = "600 18px system-ui, sans-serif"; g.fillText(title, pad, 32);
  g.fillStyle = INK2; g.font = "12px system-ui, sans-serif"; g.fillText(subtitle, pad, 52);
  g.fillText("Fire cell-days per month. Brighter (yellow) means more fire. Dashed outline: estimated from MODIS.", pad, 70);
  // legend
  let x = pad;
  const legend = [["0", ZERO], ...cal.scale.colors.map((c, k) => [k === 0 ? "> 0" : fmt(cal.scale.edges[k - 1]), c])];
  g.font = "11px system-ui, sans-serif";
  for (const [lab, col] of legend) {
    g.fillStyle = col; g.fillRect(x, 82, 16, 12);
    g.fillStyle = INK2; g.fillText(lab, x + 20, 92);
    x += 26 + g.measureText(lab).width;
  }
  // header
  g.fillStyle = INK2; g.font = "11px system-ui, sans-serif"; g.textAlign = "center";
  MONTHS.forEach((m, k) => g.fillText(m, left + k * (cw + gap) + cw / 2, top - 6));
  g.textAlign = "left"; g.fillText("Year total", left + 12 * (cw + gap) + 6, top - 6);
  const maxT = Math.max(...cal.totals.map((t) => t.s).filter(Number.isFinite), 1);
  const colorOf = (v) => { const c = cal.scale.color(v); return c.startsWith("var") ? ZERO : c; };
  cal.totals.forEach((t, r) => {
    const yy = top + r * (ch + gap);
    g.fillStyle = INK; g.textAlign = "right"; g.font = "12px system-ui, sans-serif";
    g.fillText(`${t.y}${t.est ? ` ${t.estLabel === "est." ? "est." : "part est."}${lowConfidence ? " · low conf." : ""}` : ""}`, left - 8, yy + 14);
    g.textAlign = "left";
    for (let m = 1; m <= 12; m++) {
      const xx = left + (m - 1) * (cw + gap);
      const i = d.monthIndex.get(t.y * 100 + m);
      if (i === undefined) { g.strokeStyle = LINE; g.setLineDash([3, 2]); g.strokeRect(xx + 0.5, yy + 0.5, cw - 1, ch - 1); g.setLineDash([]); continue; }
      const info = d.months[i];
      g.fillStyle = colorOf(agg.totals[i]); g.fillRect(xx, yy, cw, ch);
      if (info.partial) { g.fillStyle = "rgba(255,255,255,0.45)"; for (let s = -ch; s < cw; s += 6) { g.beginPath(); g.moveTo(xx + s, yy + ch); g.lineTo(xx + s + ch, yy); g.lineTo(xx + s + ch + 2, yy); g.lineTo(xx + s + 2, yy + ch); g.fill(); } }
      if (isEstimated(info.source)) { g.strokeStyle = "rgba(11,11,11,0.6)"; g.setLineDash([3, 2]); g.strokeRect(xx + 2.5, yy + 2.5, cw - 5, ch - 5); g.setLineDash([]); }
      if (info.source === "near_real_time") { g.fillStyle = INK; g.beginPath(); g.arc(xx + cw - 5, yy + 5, 2.5, 0, 7); g.fill(); }
    }
    const tx = left + 12 * (cw + gap) + 4;
    g.fillStyle = LINE; g.fillRect(tx, yy + 3, ((totW - 10) * (t.s || 0)) / maxT, ch - 6);
    g.fillStyle = INK; g.font = "11px system-ui, sans-serif";
    g.fillText(`${fmt(t.s)}${t.partial ? "*" : ""}${t.est && t.s > 0 ? ` (${fmt(t.lo)}–${fmt(t.hi)})` : ""}`, tx + 4, yy + 14);
  });
  const fy = top + (years.length + 1) * (ch + gap) + 10;
  g.fillStyle = INK2; g.font = "11px system-ui, sans-serif";
  g.fillText("Data: NASA FIRMS (MODIS C6.1, VIIRS 375 m) harmonised to VIIRS-equivalent fire cell-days. * part of a year.", pad, fy);
  g.fillText(`Estimated years show a likely range for this selection box area. Generated ${new Date().toISOString().slice(0, 10)}.`, pad, fy + 16);
  return new Promise((res) => cv.toBlob(res, "image/png"));
}

export { SOURCE_LABEL, RAMP };
