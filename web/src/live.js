// Live fire layer: near-real-time VIIRS detections (NOAA-20, NOAA-21) from NASA FIRMS, fetched
// through the Cloudflare Worker that holds the FIRMS key. Unharmonised; shown as points.

const LIVE_URL = (import.meta.env.VITE_LIVE_URL || "").replace(/\/$/, "");
// hours -> FIRMS day range to request. Each covers the window twice over where FIRMS allows it,
// so "new and continuing" can see the equally long window before this one. 7 days is the cap.
const WINDOWS = { 24: 2, 48: 4, 168: 7 };
const SAT = { N20: "NOAA-20", N21: "NOAA-21", "1": "NOAA-20", "2": "NOAA-21" };

export async function liveAvailable() {
  if (!LIVE_URL) return false;
  try {
    const r = await fetch(`${LIVE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
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
  const now = Date.now();
  const since = now - hours * 3600 * 1000;
  const reachFrom = now - days * 86400 * 1000;
  const q = `days=${days}&bbox=${bbox.map((v) => v.toFixed(2)).join(",")}`;
  const res = await Promise.all(["noaa20", "noaa21"].map(async (src) => {
    const r = await fetch(`${LIVE_URL}/fires?source=${src}&${q}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`live ${src}: ${r.status}`);
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
