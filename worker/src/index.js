// Proxy for NASA FIRMS near-real-time fire detections (area API).
// The FIRMS map key stays here as a secret; the browser never sees it.
//
//   GET /health                                   -> {"ok": true}
//   GET /fires?source=noaa20|noaa21&days=1|2|3|7&bbox=west,south,east,north  -> FIRMS CSV
//
// Responses are cached for 15 minutes: the FIRMS request is cached at Cloudflare's edge
// (cf.cacheTtl) and in the isolate's memory. The bbox is rounded outward to 0.5 degrees so
// nearby views share cache entries.

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

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json({ error: "method not allowed" }, cors, 405);
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: Boolean(env.FIRMS_MAP_KEY) }, cors, env.FIRMS_MAP_KEY ? 200 : 503);
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
    if (hit && Date.now() - hit.t < TTL_S * 1000) return new Response(hit.body, { headers: { ...headers, "X-Cache": "memory" } });

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
      body += body ? text.slice(text.indexOf("\n") + 1) : text;
    }
    memory.set(key, { t: Date.now(), body });
    if (memory.size > 200) memory.delete(memory.keys().next().value);
    return new Response(body, { headers: { ...headers, "X-Cache": "miss" } });
  },
};
