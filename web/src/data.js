// Loads the static harmonised export and answers area queries in the browser.

const R_EARTH_KM = 6371.0088;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export async function loadData(base = "harmonised/") {
  const [manifest, buf] = await Promise.all([
    fetch(base + "manifest.json").then((r) => {
      if (!r.ok) throw new Error(`manifest.json: ${r.status}`);
      return r.json();
    }),
    fetch(base + "harmonised.bin").then((r) => {
      if (!r.ok) throw new Error(`harmonised.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const L = manifest.binary.layout;
  const view = (name, T) => new T(buf, L[name].offset, L[name].length);
  const d = {
    manifest,
    months: manifest.months,
    cellHi: view("cell_hi", Uint32Array),
    cellLo: view("cell_lo", Uint32Array),
    lat: view("cell_lat", Float32Array),
    lon: view("cell_lon", Float32Array),
    region: view("cell_region", Uint8Array),
    province: view("cell_province", Uint8Array),
    rowCell: view("row_cell", Uint16Array),
    rowMonth: view("row_month", Uint16Array),
    rowValue: view("row_value", Float32Array),
    sdCell: L.sd_cell ? view("sd_cell", Uint16Array) : new Uint16Array(0),
    sdYear: L.sd_year ? view("sd_year", Uint16Array) : new Uint16Array(0),
    sdValue: L.sd_value ? view("sd_value", Float32Array) : new Float32Array(0),
  };
  const n = d.lat.length;
  d.rowStart = new Uint32Array(n + 1);
  let c = 0;
  for (let i = 0; i < d.rowCell.length; i++) {
    while (c <= d.rowCell[i]) d.rowStart[c++] = i;
  }
  while (c <= n) d.rowStart[c++] = d.rowCell.length;
  d.monthIndex = new Map(d.months.map((m, i) => [m.y * 100 + m.m, i]));
  d.lastMonth = d.months[d.months.length - 1];
  d.firstYear = d.months[0].y;
  d.lastYear = d.lastMonth.y;
  return d;
}

export const isEstimated = (source) => source === "estimated_from_modis" || source === "estimated_from_terra";
export const monthDays = (info) => {
  const v = Object.values(info.days || {});
  return v.length ? Math.max(...v) : 0;
};

export function h3Id(d, i) {
  return d.cellHi[i].toString(16) + d.cellLo[i].toString(16).padStart(8, "0");
}

// Geodesic area of a lat/lon box, km2.
export function boxAreaKm2(b) {
  const rad = Math.PI / 180;
  return R_EARTH_KM ** 2 * Math.abs((b.east - b.west) * rad) *
    Math.abs(Math.sin(b.north * rad) - Math.sin(b.south * rad));
}

// Sum harmonised cell-days per month for display cells whose centre lies in the box.
export function aggregate(d, b) {
  const totals = new Float64Array(d.months.length);
  const cells = [];
  const mask = new Uint8Array(d.lat.length);
  for (let i = 0; i < d.lat.length; i++) {
    const la = d.lat[i], lo = d.lon[i];
    if (la < b.south || la > b.north || lo < b.west || lo > b.east) continue;
    cells.push(i);
    mask[i] = 1;
    for (let r = d.rowStart[i]; r < d.rowStart[i + 1]; r++) totals[d.rowMonth[r]] += d.rowValue[r];
  }
  const sameDays = new Map();
  for (let r = 0; r < d.sdCell.length; r++) {
    if (mask[d.sdCell[r]]) sameDays.set(d.sdYear[r], (sameDays.get(d.sdYear[r]) || 0) + d.sdValue[r]);
  }
  return { totals, cells, mask, sameDays, areaKm2: boxAreaKm2(b) };
}

// Uncertainty factors (q10, q50, q90 of observed / predicted) for an area, interpolated on
// log(area) between the validated scales. Returns null for observed sources.
export function uncertaintyFactors(d, areaKm2, period, source) {
  if (!isEstimated(source)) return null;
  const scales = d.manifest.uncertainty.scales;
  const x = Math.log(Math.max(areaKm2, 1));
  const pts = scales.map((s) => ({ x: Math.log(s.area_km2), q: s[period][source] }));
  if (x <= pts[0].x) return pts[0].q;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].q;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return a.q.map((v, j) => Math.exp(Math.log(v) * (1 - t) + Math.log(b.q[j]) * t));
    }
  }
  return null;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export const fmt = (v) =>
  !Number.isFinite(v) ? "–" : v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString("en-CA") : v >= 10 ? v.toFixed(0) : v.toFixed(1);

// Compact form for ranges: 86,086 -> 86k, 1,234,567 -> 1.2M
export const fmtShort = (v) =>
  !Number.isFinite(v) ? "–" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k`
    : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : fmt(v);

export const SOURCE_LABEL = {
  observed: "observed (VIIRS)",
  near_real_time: "near real time (VIIRS, provisional)",
  estimated_from_modis: "estimated from MODIS (Aqua and Terra)",
  estimated_from_terra: "estimated from MODIS Terra",
};
