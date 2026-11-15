// View state in the URL, so a reload or a shared link reopens the same view.
//
// Precedence on restore: URL, then localStorage, then the default. Every value is validated on
// its own, so one broken setting falls back to its default without taking the rest with it.
// Writes are debounced and always use replaceState, so the back button is never flooded.

const DEBOUNCE_MS = 400;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// --- readers: each returns the parsed value, or null when it is missing or unusable

export function readUrl() {
  const q = new URLSearchParams(location.search);
  const out = {};

  const app = q.get("app");
  if (app === "live" || app === "historical") out.app = app;

  const box = q.get("box");
  if (box) {
    const p = box.split(",").map(num);
    if (p.length === 4 && p.every((v) => v !== null)) {
      const [south, north, west, east] = p;
      if (south >= -90 && north <= 90 && south < north && west >= -180 && east <= 180 && west < east) {
        out.box = { south, north, west, east };
      }
    }
  }
  if (box === "canada") out.box = null;

  const from = q.get("from"), to = q.get("to");
  if (/^\d{4}-\d{2}$/.test(from || "") && /^\d{4}-\d{2}$/.test(to || "")) out.range = { from, to };

  const win = num(q.get("win"));
  if (win === 24 || win === 48 || win === 168) out.liveHours = win;

  const view = q.get("view");
  if (view === "compare" || view === "single") out.viewMode = view;

  const top = q.get("top"), bottom = q.get("bottom");
  if (top) out.top = top;
  if (bottom) out.bottom = bottom;

  const cam = q.get("cam");
  if (cam) {
    const p = cam.split(",").map(num);
    if (p.length >= 3 && p.slice(0, 3).every((v) => v !== null)) {
      const [lng, lat, zoom, bearing, pitch] = p;
      if (lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90 && zoom >= 0 && zoom <= 22) {
        out.camera = { center: [lng, lat], zoom,
          bearing: bearing === null || !Number.isFinite(bearing) ? 0 : bearing,
          pitch: pitch === null || !Number.isFinite(pitch) ? 0 : pitch };
      }
    }
  }
  return out;
}

// --- writer

let timer = null;
export function writeUrl(get) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const s = get();
    const q = new URLSearchParams();
    if (s.app === "live") q.set("app", "live");
    q.set("box", s.box ? [s.box.south, s.box.north, s.box.west, s.box.east].map((v) => +v.toFixed(3)).join(",") : "canada");
    if (s.from && s.to) { q.set("from", s.from); q.set("to", s.to); }
    if (s.app === "live") q.set("win", String(s.liveHours));
    if (s.viewMode !== "single") {
      q.set("view", s.viewMode);
      q.set("top", s.top);
      q.set("bottom", s.bottom);
    }
    if (s.camera) {
      const { center, zoom, bearing, pitch } = s.camera;
      const parts = [center[0].toFixed(3), center[1].toFixed(3), zoom.toFixed(2)];
      if (bearing || pitch) parts.push(bearing.toFixed(1), pitch.toFixed(1));
      q.set("cam", parts.join(","));
    }
    history.replaceState(null, "", `${location.pathname}?${q}`);
  }, DEBOUNCE_MS);
}
