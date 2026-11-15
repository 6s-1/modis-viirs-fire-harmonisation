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
import { fetchActiveFires } from "./live.js";

// CWFIS stage of control, spelled out
const STAGE = { OC: "Out of control", BH: "Being held", UC: "Under control", OUT: "Out" };
const KM_NEAR = 30; // a fire this close to the cell centre counts as "in or near" it
function nearbyFires(fires, la, lo) {
  return fires
    .map((f) => ({ ...f, km: Math.hypot((f.lat - la) * 111, (f.lon - lo) * 111 * Math.cos((la * Math.PI) / 180)) }))
    .filter((f) => f.km <= KM_NEAR)
    .sort((a, b) => b.ha - a.ha)
    .slice(0, 3);
}

// ---- Stage B: cause, burned area and land cover, in one shard per ecozone, fetched when the
// card first needs that zone. Display only: none of it feeds the harmonisation model.
const slug = (name) => name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-|-$/g, "");
let whyIndex = null;
const shardCache = new Map();
async function loadShard(zoneName) {
  const zone = zoneName ? slug(zoneName) : "other";
  if (shardCache.has(zone)) return shardCache.get(zone);
  const job = (async () => {
    if (!whyIndex) whyIndex = await fetch("why/index.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!whyIndex || !whyIndex.zones[zone]) return null;
    return fetch(`why/${zone}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  })();
  shardCache.set(zone, job);
  return job;
}

const PCT = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const CAUSE_LABEL = { lightning: "Lightning", human: "Human", prescribed: "Prescribed burn", unknown: "Not recorded" };
const CAUSE_COLOR = { lightning: "#f8968a", human: "#69b9eb", prescribed: "#c9cdd4", unknown: "#4a4e57" };
const LC_LABEL = { forest: "Forest", grass_shrub: "Grass and shrub", cropland: "Cropland", other: "Other" };
const LC_COLOR = { forest: "#2f7d55", grass_shrub: "#9ab04f", cropland: "#d8a657", other: "#6a6f7a" };

// one stacked bar of shares
function shareBar(parts, labels, colors, aria) {
  const total = parts.reduce((a, [, v]) => a + v, 0);
  if (!total) return "";
  return `<div class="wc-bar" role="img" aria-label="${aria}">
      ${parts.map(([k, v]) => `<span style="width:${(v / total) * 100}%;background:${colors[k] || "#6a6f7a"}" title="${labels[k] || k}"></span>`).join("")}
    </div>
    <ul class="wc-key">${parts.map(([k, v]) => `<li><span class="sw" style="background:${colors[k] || "#6a6f7a"}"></span>${labels[k] || k} ${PCT(v, total)}%</li>`).join("")}</ul>`;
}

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

// The same history as one cell, but summed over every cell in the selection.
function areaHistory(d, agg) {
  const byYear = new Map(), byMonth = new Array(12).fill(0);
  let total = 0;
  for (let mi = 0; mi < d.months.length; mi++) {
    const v = agg.totals[mi];
    if (!(v > 0)) continue;
    const info = d.months[mi];
    byYear.set(info.y, (byYear.get(info.y) || 0) + v);
    byMonth[info.m - 1] += v;
    total += v;
  }
  return { byYear, byMonth, total };
}

// Which cells in the selection carried this month's fire, and where it was worst.
function monthDetail(d, agg, mi) {
  const cells = [];
  for (const i of agg.gridCells) {
    for (let r2 = d.rowStart[i]; r2 < d.rowStart[i + 1]; r2++) {
      if (d.rowMonth[r2] === mi && d.rowValue[r2] > 0) { cells.push({ i, v: d.rowValue[r2] }); break; }
    }
  }
  cells.sort((a, b) => b.v - a.v);
  return cells;
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

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
const row = (label, value) => `<div class="wc-row"><dt>${label}</dt><dd>${value}</dd></div>`;

// subject: { i, place, range, label } for a cell, or a month of the whole box.
export async function renderWhyCard(el, d, agg, subject, live) {
  const { i, place, range, windowLabel, scope } = subject;
  const isCell = i !== undefined && i !== null;
  const hist = isCell ? cellHistory(d, i) : areaHistory(d, agg);
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

  const placeOf = (dd, k) => (subject.nameOf ? subject.nameOf(dd.lat[k], dd.lon[k]) : "a cell");

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
    if (isCell) {
      const people = d.pop[i];
      rows.push(row("People living here", people >= 1 ? fmtShort(Math.round(people)) : people > 0 ? people.toFixed(2) : "0"));
      const tr = cellTrend(d, i, range);
      if (tr) rows.push(row("Where fire is changing", `${tr.dir} <span class="muted">${tr.years}</span>`));
      const ez = ecozonePercentile(d, agg, i, range);
      if (ez) rows.push(row("In its ecozone", `${ordinal(ez.pct)} percentile <span class="muted">of ${fmt(ez.n)} cells in ${ez.zone}</span>`));
    } else {
      // a month over the whole selection: how it ranks, and where the fire actually was
      const mi = range[0], info = d.months[mi];
      const sameMonth = [];
      for (let y = d.firstYear; y <= d.lastYear; y++) {
        const k = d.monthIndex.get(y * 100 + info.m);
        if (k === undefined || d.months[k].partial) continue;
        sameMonth.push({ y, v: agg.totals[k] });
      }
      const mine = agg.totals[mi];
      const above = sameMonth.filter((o) => o.y !== info.y && o.v > mine).length;
      const others = sameMonth.filter((o) => o.y !== info.y);
      if (others.length >= 5) {
        rows.push(row(`Against other ${LONG[info.m - 1]}s`, above === 0
          ? `the busiest of ${others.length + 1}`
          : `${ordinal(above + 1)} of ${others.length + 1}`));
        rows.push(row("Typical for this month", `${fmt(median(others.map((o) => o.v)))} cell-days`));
      }
      const cells = monthDetail(d, agg, mi);
      if (cells.length) {
        rows.push(row("Grid cells with fire", `${fmt(cells.length)} of ${fmt(agg.gridCells.length)}`));
        const top = cells[0];
        rows.push(row("Worst cell", `${placeOf(d, top.i)} <span class="muted">${fmt(top.v)} cell-days</span>`));
        const half = cells.reduce((acc, c) => acc + c.v, 0) * 0.5;
        let run = 0, n = 0;
        for (const c of cells) { run += c.v; n++; if (run >= half) break; }
        rows.push(row("Half the fire was in", `${n} cell${n === 1 ? "" : "s"}`));
      }
      const people = agg.gridCells.reduce((a, k) => a + (d.pop[k] || 0), 0);
      if (people > 0) rows.push(row("People living here", fmtShort(Math.round(people))));
    }
  }

  // ---- what the agencies report, in Live
  let official = "";
  if (live && isCell) {
    const fires = await fetchActiveFires();
    const near = nearbyFires(fires, d.lat[i], d.lon[i]);
    const note = infoIcon(`Fires reported by the provincial, territorial and Parks Canada agencies, through the Canadian Wildland Fire Information System.<br>
      Agencies update this about once a day, so it can lag the satellites in both directions.<br>
      <span class="muted">Fires within ${KM_NEAR} km of this cell's centre, largest first.</span>`);
    official = near.length
      ? `<div class="wc-official">
          <p class="wc-kicker">Reported by the agency${note}</p>
          <ul class="wc-fires">${near.map((f) => `<li>
            <b>${f.id || "Unnamed fire"}</b> <span class="muted">${f.agency}</span><br>
            <span class="muted">${f.ha >= 0 ? `${fmt(f.ha)} ha · ` : ""}${STAGE[f.stage] || f.stage}${f.start ? ` · started ${f.start.slice(0, 10)}` : ""}</span>
          </li>`).join("")}</ul>
        </div>`
      : `<div class="wc-official"><p class="wc-kicker">Reported by the agency${note}</p>
          <p class="wc-none">No agency-reported fire here.</p></div>`;
  }

  // ---- Stage B, for a single cell: cause, burned area, land cover and the rest
  let why = "", more = "";
  if (isCell) {
    const shard = await loadShard(d.manifest.regions[d.region[i]]);
    const rec = shard && shard[String(cellIdOf(d, i))];
    if (rec) {
      const years = yearsIn(d, range);
      const cause = rec.cause || {};
      const causeParts = ["lightning", "human", "prescribed", "unknown"].filter((k) => cause[k]).map((k) => [k, cause[k]]);
      const nFires = causeParts.reduce((a, [, v]) => a + v, 0);
      const lcParts = Object.entries(rec.lc || {}).sort((a, b) => b[1] - a[1]);
      if (causeParts.length || lcParts.length) {
        const thin = (rec.agency || []).filter((a) => (whyIndex?.agency_last_year?.[a] ?? 9999) < d.lastYear);
        why = `<div class="wc-why">
          <p class="wc-kicker">Why</p>
          ${causeParts.length ? `<p class="wc-sub">Cause of ${fmt(nFires)} recorded fire${nFires === 1 ? "" : "s"}</p>
            ${shareBar(causeParts, CAUSE_LABEL, CAUSE_COLOR, "Cause of recorded fires")}` : ""}
          ${lcParts.length ? `<p class="wc-sub">What burns here</p>
            ${shareBar(lcParts, LC_LABEL, LC_COLOR, "Land cover where fire is detected")}` : ""}
          ${thin.length ? `<p class="wc-note">Recent years may be incomplete for ${thin.join(", ")}.</p>` : ""}
        </div>`;
      }
      // area burned: the largest fire that reached this cell, by year in the window
      const ha = Object.entries(rec.nbac_largest_ha || {}).filter(([y]) => years.includes(+y)).sort((a, b) => b[1] - a[1]);
      const big = (rec.big || []).filter((f) => years.includes(f.y)).slice(0, 3);
      const moreRows = [];
      if (ha.length) moreRows.push(row(`Largest fire reaching here, ${ha[0][0]}`, `${fmt(ha[0][1])} ha`));
      if (big.length) {
        moreRows.push(`<div class="wc-row wc-stack"><dt>Largest fires in this window</dt><dd><ul class="wc-fires">${big.map((f) =>
          `<li>${f.name ? `<b>${f.name}</b> · ` : ""}${fmt(f.ha)} ha${f.m ? ` · ${MONTHS[f.m - 1]} ${f.y}` : ` · ${f.y}`}</li>`).join("")}</ul></dd></div>`);
      }
      if (moreRows.length) {
        more = `<details class="wc-more"><summary>More</summary><dl class="wc-rows">${moreRows.join("")}</dl></details>`;
      }
    }
  }

  const sources = `Fire cell-days and history from the harmonised record.<br>
    Cause and fire names: Canadian National Fire Database (NFDB), CWFIS. Shares are of fires with a record here, and fires whose cause is not recorded are counted as "Not recorded".<br>
    Area burned: National Burned Area Composite (NBAC). The figure is the largest fire that reached this cell that year, not the area burned inside the cell.<br>
    What burns here: ESA WorldCover at each detection.<br>
    <span class="muted">NFDB and NBAC are shown for context only; the harmonised record is unchanged.</span><br><br>
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
    ${official}
    ${liveBlock ? `<p class="wc-kicker wc-past">Past fire here</p>` : ""}
    <dl class="wc-rows">${rows.join("")}</dl>
    ${why}
    ${more}
    <p class="wc-foot">Sources${infoIcon(sources)}</p>
  </div>`;
  el.hidden = false;
}

// the h3 id the export keys on, as a decimal string
function cellIdOf(d, i) {
  return BigInt(`0x${d.cellHi[i].toString(16).padStart(8, "0")}${d.cellLo[i].toString(16).padStart(8, "0")}`).toString();
}
function yearsIn(d, range) {
  const out = [];
  for (let y = d.months[range[0]].y; y <= d.months[range[1]].y; y++) out.push(y);
  return out;
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
