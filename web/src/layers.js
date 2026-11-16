// Map layers. The fire grid is the base layer and is always on. Every other overlay has its own
// on/off toggle in the Layers control, defaults to off and is remembered between visits.

const KEY = "ember:layers";
export const OVERLAYS = [
  // Places is the one overlay that starts on: without borders and town names the globe has no
  // reference points. It still has its own toggle and is remembered like the rest.
  { id: "places", label: "Places and borders", on: true },
  // "Where people live" is not here: it is a static map of where towns are, so it does not change
  // with the selection or the dates. It stays as a choice in the compare-globe pickers, where it
  // is the natural counterpart to fire.
  { id: "trend", label: "Where fire is changing", histOnly: true },
  { id: "badges", label: "Exposure badges" },
  { id: "detections", label: "Individual live detections", liveOnly: true },
];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; }
}
const saved = load();
export const overlays = Object.fromEntries(OVERLAYS.map((o) =>
  [o.id, typeof saved[o.id] === "boolean" ? saved[o.id] : o.on === true]));

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(overlays)); } catch { /* storage unavailable */ }
}

// Builds the toggles inside panelEl and calls onChange() after any change.
export function initLayersControl(buttonEl, panelEl, onChange) {
  panelEl.innerHTML = `<p class="lp-title">Layers</p>
    <label class="lp-row lp-base"><input type="checkbox" checked disabled /> Fire activity <span class="lp-note">always on</span></label>
    ${OVERLAYS.map((o) => `<label class="lp-row"${o.liveOnly ? " data-live-only" : ""}${o.histOnly ? " data-hist-only" : ""}><input type="checkbox" data-layer="${o.id}"${overlays[o.id] ? " checked" : ""} />
      ${o.label}${o.liveOnly ? ' <span class="lp-note">live mode</span>' : ""}${o.histOnly ? ' <span class="lp-note">historical</span>' : ""}</label>`).join("")}`;
  panelEl.addEventListener("change", (e) => {
    const id = e.target.dataset.layer;
    if (!id) return;
    overlays[id] = e.target.checked;
    save();
    onChange(id);
  });
  const open = (on) => {
    panelEl.hidden = !on;
    buttonEl.setAttribute("aria-expanded", String(on));
  };
  buttonEl.addEventListener("click", (e) => { e.stopPropagation(); open(panelEl.hidden); });
  // A click anywhere else closes the panel - except inside the tour, which opens the panel on
  // purpose to show what a step is talking about and would otherwise close it on the next click.
  document.addEventListener("click", (e) => {
    if (panelEl.hidden || panelEl.contains(e.target) || e.target === buttonEl) return;
    if (e.target.closest && e.target.closest(".tour")) return;
    open(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panelEl.hidden) { open(false); buttonEl.focus(); } });
}

// Live-only toggles are disabled outside live mode.
export function setLiveMode(panelEl, isLive) {
  panelEl.querySelectorAll("[data-live-only] input").forEach((i) => { i.disabled = !isLive; });
  panelEl.querySelectorAll("[data-live-only]").forEach((l) => l.classList.toggle("off", !isLive));
  panelEl.querySelectorAll("[data-hist-only] input").forEach((i) => { i.disabled = isLive; });
  panelEl.querySelectorAll("[data-hist-only]").forEach((l) => l.classList.toggle("off", isLive));
}

// A trend needs enough complete years to mean anything, so the toggle is off and unclickable
// until the date range has them. Turning it off also clears it from the map.
export function setTrendAvailable(panelEl, ok, minYears) {
  const box = panelEl.querySelector('input[data-layer="trend"]');
  if (!box) return false;
  const row = box.closest(".lp-row");
  const wasOn = box.checked;
  box.disabled = !ok;
  if (row) {
    row.classList.toggle("off", !ok);
    row.title = ok ? "" : `Needs ${minYears} or more complete years in the date range.`;
  }
  if (!ok && wasOn) { box.checked = false; overlays.trend = false; save(); return true; }
  return false;
}
