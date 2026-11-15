// "Areas with fire, ranked by people exposed": for the current view, the display cells (~250 km²)
// with recent fire, ranked by the people living in them (WorldPop 2020, modelled). Recent fire is
// the live layer when it is on, otherwise the latest month in the record. Exposure only.

import { infoIcon } from "./info.js";
import { latLngToCell } from "h3-js";
import { MONTHS, cellIndexOf, fmt, fmtShort, monthDays } from "./data.js";

const CANADA = [-141.5, 41.5, -52.0, 83.5];
const TOP = 10;
let places = null;

export async function loadPlaces(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`places: ${r.status}`);
  places = (await r.json()).rows; // [name, lat, lon, pop, province]
}

function km(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180, dlat = (lat2 - lat1) * rad, dlon = (lon2 - lon1) * rad;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function compass(fromLat, fromLon, toLat, toLon) {
  const y = toLat - fromLat, x = (toLon - fromLon) * Math.cos(((fromLat + toLat) / 2) * Math.PI / 180);
  const dirs = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
  return dirs[Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 / 45) % 8];
}

// "Kelowna, BC" or "12 km NW of Kelowna, BC": the nearest place of 500+ people.
function placeName(lat, lon) {
  if (!places) return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  let best = null, bd = Infinity;
  for (const p of places) {
    if (Math.abs(p[1] - lat) > 3) continue;
    const dkm = km(lat, lon, p[1], p[2]);
    if (dkm < bd) { bd = dkm; best = p; }
  }
  if (!best) return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  const name = `${best[0]}${best[4] ? `, ${best[4]}` : ""}`;
  return bd < 5 ? name : `${Math.round(bd)} km ${compass(best[1], best[2], lat, lon)} of ${name}`;
}

// Renders the list for the selection box and returns the top areas [{ i, rank }] so the map can
// outline and number them. onPick(i) zooms to an area; onHover(rank|null) links row and map.
export function renderExposureList(el, d, box, liveFeats, liveHours, onPick, onHover) {
  const { west: w, south: s, east: e, north: n } = box;
  const counts = new Map();
  let basis;
  if (liveFeats) {
    for (const f of liveFeats) {
      const [lon, lat] = f.geometry.coordinates;
      if (lon < w || lon > e || lat < s || lat > n) continue;
      const i = cellIndexOf(d, latLngToCell(lat, lon, 5));
      if (i !== undefined) counts.set(i, (counts.get(i) || 0) + 1);
    }
    basis = `live hotspots, ${{ 24: "last 24 hours", 48: "last 48 hours", 168: "last 7 days" }[liveHours]}`;
  } else {
    const mi = d.months.length - 1, last = d.lastMonth;
    for (let i = 0; i < d.lat.length; i++) {
      const la = d.lat[i], lo = d.lon[i];
      if (la < s || la > n || lo < w || lo > e) continue;
      let c = 0;
      for (let r = d.rawStart[i]; r < d.rawStart[i + 1]; r++) if (d.rawMonth[r] === mi && d.rawDet) c += d.rawDet[r];
      if (c > 0) counts.set(i, c);
    }
    basis = `hotspots 1–${monthDays(last)} ${MONTHS[last.m - 1]} ${last.y} (latest month in the record)`;
  }
  const rows = [...counts].map(([i, c]) => ({ i, c, people: d.pop ? d.pop[i] : 0 }))
    .sort((a, b) => b.people - a.people || b.c - a.c);
  const top = rows.slice(0, TOP);
  const table = top.length ? `<table class="data exposure">
      <thead><tr><th scope="col" class="rank-h">#</th><th scope="col">Area</th><th scope="col">Hotspots</th><th scope="col" title="People living in the ~250 km² grid cell around the hotspots (WorldPop 2020, modelled)">People</th></tr></thead>
      <tbody>${top.map((r, k) => `<tr data-rank="${k + 1}"><td class="rank"><span class="exp-num">${k + 1}</span></td><th scope="row"><button type="button" class="linkish" data-i="${r.i}">${placeName(d.lat[r.i], d.lon[r.i])}</button></th>
        <td>${Math.round(r.c).toLocaleString("en-CA")}</td><td>${r.people >= 1 ? fmtShort(Math.round(r.people)) : "0"}</td></tr>`).join("")}</tbody></table>`
    : `<p class="muted small">No hotspots in the selection for ${basis}.</p>`;
  const about = infoIcon(`Exposure only: response priorities are set by emergency management agencies.<br>
    Areas are ~250 km² grid cells; fire is ${basis}.<br>People: WorldPop 2020 modelled estimates for the cell.<br>
    Place: nearest place of 500+ people (GeoNames).<br><span class="muted">Hotspots in towns can be industrial heat or other sources that are not wildfire. Click an area to zoom to it.</span>`);
  el.innerHTML = `${table}
    <p class="muted small exp-foot">${rows.length > TOP ? `Top ${TOP} of ${fmt(rows.length)} areas` : top.length ? `${top.length} area${top.length > 1 ? "s" : ""}` : ""}${about}</p>`;
  el.querySelectorAll("button[data-i]").forEach((b) => b.addEventListener("click", () => onPick(+b.dataset.i)));
  el.querySelectorAll("tr[data-rank]").forEach((tr) => {
    tr.addEventListener("mouseenter", () => onHover(+tr.dataset.rank));
    tr.addEventListener("mouseleave", () => onHover(null));
    tr.addEventListener("focusin", () => onHover(+tr.dataset.rank));
    tr.addEventListener("focusout", () => onHover(null));
  });
  return top.map((r, k) => ({ i: r.i, rank: k + 1 }));
}
