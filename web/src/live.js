// Live fire layer: near-real-time VIIRS detections (NOAA-20, NOAA-21) from NASA FIRMS, fetched
// through the Cloudflare Worker that holds the FIRMS key. Unharmonised; shown as points.

const LIVE_URL = (import.meta.env.VITE_LIVE_URL || "").replace(/\/$/, "");
// hours -> FIRMS day range to request. The Worker accepts 1, 2, 3 or 7 only, so these must be one
// of those: asking for 4 made it answer 400 and live mode read that as a Worker error. Each range
// covers its window twice over where it can, so "new and continuing" can see the equally long
// window before this one; 7 days is the cap FIRMS allows.
const WINDOWS = { 24: 2, 48: 7, 168: 7 };
const WORKER_DAYS = new Set([1, 2, 3, 7]); // must match DAYS in worker/src/index.js
const SAT = { N20: "NOAA-20", N21: "NOAA-21", "1": "NOAA-20", "2": "NOAA-21" };

// Why live mode is unavailable, for the dev banner and the console. Each check returns one of
// these reasons, so a failure says what went wrong rather than just "unavailable".
export const LIVE_REASON = {
  NO_URL: "no Worker URL in this build",
  UNREACHABLE: "Worker unreachable",
  NO_KEY: "Worker has no FIRMS key",
  LIMIT: "FIRMS limit reached",
  ERROR: "Worker error",
};
const devWhy = (msg) => { if (import.meta.env.DEV) console.warn(`[ember] live mode unavailable: ${msg}`); };

// The health check is NOT cached: a single slow or dropped request used to wedge live mode off
// until a full reload, because the first result was kept forever. Each attempt checks again, and
// a good result is trusted for a short while so switching modes does not re-check every time.
let lastOk = 0;
const OK_FOR_MS = 60_000;
export let liveReason = null;

export async function liveAvailable() {
  if (!LIVE_URL) {
    liveReason = LIVE_REASON.NO_URL;
    devWhy("VITE_LIVE_URL is not set. Put it in web/.env.local (see the Worker section of the README) and restart the dev server.");
    return false;
  }
  if (Date.now() - lastOk < OK_FOR_MS) return true; // checked moments ago
  try {
    const r = await fetch(`${LIVE_URL}/health`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      liveReason = r.status === 503 ? LIVE_REASON.NO_KEY : LIVE_REASON.ERROR;
      devWhy(r.status === 503
        ? `the Worker at ${LIVE_URL} has no FIRMS_MAP_KEY set (health 503). Run: cd worker && npx wrangler secret put FIRMS_MAP_KEY`
        : `health check on ${LIVE_URL} returned ${r.status}.`);
      return false;
    }
    liveReason = null;
    lastOk = Date.now();
    return true;
  } catch (err) {
    liveReason = LIVE_REASON.UNREACHABLE;
    devWhy(`could not reach ${LIVE_URL} (${err.name === "TimeoutError" ? "timed out" : err.message}). `
      + `If the dev server is not on port 5173 the Worker refuses the request: CORS allows :5173 and :4173 only.`);
    return false;
  }
}

function parse(csv, sinceMs) {
  const lines = csv.trim().split("\n");
  const head = lines.shift().split(",");
  const col = (n) => head.indexOf(n);
  const [iLat, iLon, iDate, iTime, iSat, iFrp, iConf, iDn] =
    ["latitude", "longitude", "acq_date", "acq_time", "satellite", "frp", "confidence", "daynight"].map(col);
  const out = [];
  for (const line of lines) {
    const c = line.split(",");
    const t = String(c[iTime]).padStart(4, "0");
    const ms = Date.parse(`${c[iDate]}T${t.slice(0, 2)}:${t.slice(2)}:00Z`);
    if (!(ms >= sinceMs)) continue;
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [+c[iLon], +c[iLat]] },
      properties: { t: ms, sat: SAT[c[iSat]] || c[iSat], frp: +c[iFrp], conf: c[iConf], dn: c[iDn] },
    });
  }
  return out;
}

// Returns { feats, earlier, reach }: the hotspots inside the window, those from before it that
// the feed still covers, and how far back the feed actually reached (ms).
export async function fetchLive(bbox, hours) {
  const days = WINDOWS[hours];
  if (!WORKER_DAYS.has(days)) throw new Error(`live: ${days} is not a day range the Worker accepts`);
  const now = Date.now();
  const since = now - hours * 3600 * 1000;
  const reachFrom = now - days * 86400 * 1000;
  const q = `days=${days}&bbox=${bbox.map((v) => v.toFixed(2)).join(",")}`;
  const res = await Promise.all(["noaa20", "noaa21"].map(async (src) => {
    const r = await fetch(`${LIVE_URL}/fires?source=${src}&${q}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.json()).error || ""; } catch { /* not json */ }
      // FIRMS answers an exhausted transaction limit with its own text rather than a status
      liveReason = /limit|quota|transaction/i.test(detail) ? LIVE_REASON.LIMIT : LIVE_REASON.ERROR;
      devWhy(`fires request for ${src} returned ${r.status}${detail ? `: ${detail}` : ""}`);
      throw new Error(`live ${src}: ${r.status}`);
    }
    return parse(await r.text(), reachFrom); // keep the earlier rows too
  }));
  const all = res.flat();
  return { feats: all.filter((f) => f.properties.t >= since), earlier: all.filter((f) => f.properties.t < since), reachFrom };
}

export function addLiveLayer(map) {
  map.addSource("live", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "live", type: "circle", source: "live", layout: { visibility: "none" },
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2, 8, 4.5], "circle-color": "#ffffff",
      "circle-stroke-color": "#0b0d12", "circle-stroke-width": 1, "circle-opacity": 0.95 } });
}

export function attachLiveHover(map, tip) {
  map.on("mousemove", "live", (e) => {
    const p = e.features && e.features[0] && e.features[0].properties;
    if (!p) return;
    const when = new Date(+p.t).toISOString().slice(0, 16).replace("T", " ");
    tip.innerHTML = `<strong>${p.sat}</strong> · ${when} UTC<br>FRP ${(+p.frp).toFixed(1)} MW · ${p.dn === "D" ? "day" : "night"} pass
      <br><span class="muted">near real time, unharmonised hotspot</span>`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.originalEvent.clientX + 14, innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.min(e.originalEvent.clientY + 14, innerHeight - r.height - 8)}px`;
  });
  map.on("mouseleave", "live", () => { tip.hidden = true; });
}

// Fires the agencies report, from CWFIS through the Worker. Fetched once and reused: it changes
// about once a day.
let activeCache = null;
export async function fetchActiveFires() {
  if (!LIVE_URL) return [];
  if (activeCache) return activeCache;
  try {
    const r = await fetch(`${LIVE_URL}/activefires`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) { devWhy(`active fires returned ${r.status}`); return []; }
    const d = await r.json();
    activeCache = d.fires || [];
    return activeCache;
  } catch (err) {
    devWhy(`could not reach the active fires feed (${err.name === "TimeoutError" ? "timed out" : err.message})`);
    return [];
  }
}
