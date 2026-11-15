// Proxy for NASA FIRMS near-real-time fire detections (area API).
// The FIRMS map key stays here as a secret; the browser never sees it.
//
//   GET /health                                   -> {"ok": true}
//   GET /fires?source=noaa20|noaa21&days=1|2|3|7&bbox=west,south,east,north  -> FIRMS CSV
//
// Responses are cached for 15 minutes: the FIRMS request is cached at Cloudflare's edge
// (cf.cacheTtl) and in the isolate's memory. The bbox is rounded outward to 0.5 degrees so
// nearby views share cache entries. Every point is filtered to Canada (point in polygon against the
// Natural Earth boundary also used for the harmonised data), so nothing spills over the border.
import { CANADA_POLYGONS } from "./canada.js";

const SOURCES = { noaa20: "VIIRS_NOAA20_NRT", noaa21: "VIIRS_NOAA21_NRT" };
const DAYS = new Set(["1", "2", "3", "7"]);
const TTL_S = 900;
const MAX_SPAN = { lon: 120, lat: 70 };
const ALLOWED_ORIGINS = ["https://6s-1.github.io", "http://localhost:5173", "http://localhost:4173"];
const memory = new Map(); // key -> { t, body }

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Expose-Headers": "X-Cache, X-Outside-Canada-Dropped",
    Vary: "Origin",
  };
}

const json = (obj, headers, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });

function parseBbox(v) {
  const p = (v || "").split(",").map(Number);
  if (p.length !== 4 || !p.every(Number.isFinite)) return null;
  let [w, s, e, n] = p;
  w = Math.max(-180, Math.floor(w * 2) / 2); s = Math.max(-90, Math.floor(s * 2) / 2);
  e = Math.min(180, Math.ceil(e * 2) / 2); n = Math.min(90, Math.ceil(n * 2) / 2);
  if (w >= e || s >= n || e - w > MAX_SPAN.lon || n - s > MAX_SPAN.lat) return null;
  return [w, s, e, n];
}

// Even-odd ray casting over all rings of a polygon (exterior and holes).
function inPolygon(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
export function inCanada(lon, lat) {
  for (const p of CANADA_POLYGONS) {
    const [w, s, e, n] = p.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (inPolygon(lon, lat, p.rings)) return true;
  }
  return false;
}
function keepCanada(csv) {
  const lines = csv.split("\n");
  const head = lines[0].split(",");
  const iLat = head.indexOf("latitude"), iLon = head.indexOf("longitude");
  const out = [lines[0]];
  let dropped = 0;
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k];
    if (!line) continue;
    const c = line.split(",");
    if (inCanada(+c[iLon], +c[iLat])) out.push(line); else dropped++;
  }
  return { body: out.join("\n") + "\n", dropped };
}

// Fires the agencies themselves report, from the Canadian Wildland Fire Information System.
// Satellites see heat; this says who is fighting what, how big it is and whether it is held.
// Cached for an hour: the agencies update it about once a day.
const ACTIVE_URL = "https://geoserver.cwfif.nrcan.gc.ca/geoserver/ows"
  + "?service=WFS&version=2.0.1&request=GetFeature&outputFormat=csv"
  + "&typeName=public:cwfif_national_activefires";
const ACTIVE_TTL_S = 3600;
let activeCache = null;

async function activeFires(cors) {
  const headers = { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ACTIVE_TTL_S}` };
  if (activeCache && Date.now() - activeCache.t < ACTIVE_TTL_S * 1000) {
    return new Response(activeCache.body, { headers: { ...headers, "X-Cache": "memory" } });
  }
  let text;
  try {
    const res = await fetch(ACTIVE_URL, { cf: { cacheTtl: ACTIVE_TTL_S, cacheEverything: true } });
    if (!res.ok) return json({ error: `CWFIS returned ${res.status}` }, cors, 502);
    text = await res.text();
  } catch {
    return json({ error: "CWFIS unreachable" }, cors, 502);
  }
  // the feed uses CRLF, so the last column of every row would keep a trailing \r
  const lines = text.split(/\r?\n/);
  const head = lines[0].split(",").map((h) => h.trim());
  const col = (n) => head.indexOf(n);
  const iAg = col("agency_code"), iId = col("agency_fire_id"), iSize = col("fire_size"),
    iStage = col("stage_of_control_status"), iLat = col("latitude"), iLon = col("longitude"),
    iStart = col("situation_report_date"), iEnd = col("record_end");
  const now = Date.now();
  const out = [];
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(",");
    if (c.length < head.length) continue;
    const end = Date.parse(c[iEnd]);
    if (!(end > now)) continue; // only fires whose record is still current
    const lat = +c[iLat], lon = +c[iLon];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ agency: c[iAg], id: c[iId], ha: +c[iSize], stage: c[iStage], lat, lon, start: c[iStart] || null });
  }
  const body = JSON.stringify({ fires: out, fetched: new Date().toISOString() });
  activeCache = { t: Date.now(), body };
  return new Response(body, { headers: { ...headers, "X-Cache": "miss" } });
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json({ error: "method not allowed" }, cors, 405);
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: Boolean(env.FIRMS_MAP_KEY) }, cors, env.FIRMS_MAP_KEY ? 200 : 503);
    if (url.pathname === "/activefires") return activeFires(cors);
    if (url.pathname !== "/fires") return json({ error: "not found" }, cors, 404);

    const source = url.searchParams.get("source");
    const days = url.searchParams.get("days");
    const bbox = parseBbox(url.searchParams.get("bbox"));
    if (!SOURCES[source] || !DAYS.has(days) || !bbox) {
      return json({ error: "use source=noaa20|noaa21, days=1|2|3|7, bbox=west,south,east,north (max 120 x 70 degrees)" }, cors, 400);
    }
    if (!env.FIRMS_MAP_KEY) return json({ error: "service not configured" }, cors, 503);

    const key = `${source}/${days}/${bbox.join(",")}`;
    const hit = memory.get(key);
    const headers = { ...cors, "Content-Type": "text/csv; charset=utf-8", "Cache-Control": `public, max-age=${TTL_S}` };
    if (hit && Date.now() - hit.t < TTL_S * 1000) {
      return new Response(hit.body, { headers: { ...headers, "X-Cache": "memory", "X-Outside-Canada-Dropped": String(hit.dropped) } });
    }

    // FIRMS allows at most 5 days per request: longer windows are fetched in dated chunks.
    const base = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.FIRMS_MAP_KEY}/${SOURCES[source]}/${bbox.join(",")}`;
    const n = Number(days);
    const urls = [];
    if (n <= 5) urls.push(`${base}/${n}`);
    else {
      const day = (k) => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10);
      for (let left = n, back = n - 1; left > 0;) {
        const chunk = Math.min(5, left);
        urls.push(`${base}/${chunk}/${day(back)}`);
        left -= chunk; back -= chunk;
      }
    }
    let body = "";
    for (const u of urls) {
      let res;
      try {
        res = await fetch(u, { cf: { cacheTtl: TTL_S, cacheEverything: true } });
      } catch {
        return json({ error: "FIRMS unreachable" }, cors, 502); // never echo the upstream URL: it contains the key
      }
      const text = await res.text();
      if (!res.ok || !text.startsWith("latitude")) return json({ error: `FIRMS error (${res.status})` }, cors, 502);
      const part = body ? text.slice(text.indexOf("\n") + 1) : text; // drop repeated header
      body += part.endsWith("\n") || !part ? part : part + "\n"; // chunks may lack a final newline
    }
    const filtered = keepCanada(body);
    body = filtered.body;
    memory.set(key, { t: Date.now(), body, dropped: filtered.dropped });
    if (memory.size > 200) memory.delete(memory.keys().next().value);
    return new Response(body, { headers: { ...headers, "X-Cache": "miss", "X-Outside-Canada-Dropped": String(filtered.dropped) } });
  },
};
