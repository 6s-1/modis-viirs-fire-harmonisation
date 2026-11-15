// Map layers. The fire grid is the base layer and is always on. Every other overlay has its own
// on/off toggle in the Layers control, defaults to off and is remembered between visits.

const KEY = "ember:layers";
export const OVERLAYS = [
  { id: "people", label: "Where people live" },
  { id: "badges", label: "Exposure badges" },
  { id: "detections", label: "Individual live detections", liveOnly: true },
];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; }
}
const saved = load();
export const overlays = Object.fromEntries(OVERLAYS.map((o) => [o.id, saved[o.id] === true]));

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(overlays)); } catch { /* storage unavailable */ }
}

// Builds the toggles inside panelEl and calls onChange() after any change.
export function initLayersControl(buttonEl, panelEl, onChange) {
  panelEl.innerHTML = `<p class="lp-title">Layers</p>
    <label class="lp-row lp-base"><input type="checkbox" checked disabled /> Fire activity <span class="lp-note">always on</span></label>
    ${OVERLAYS.map((o) => `<label class="lp-row"${o.liveOnly ? ' data-live-only' : ""}><input type="checkbox" data-layer="${o.id}"${overlays[o.id] ? " checked" : ""} />
      ${o.label}${o.liveOnly ? ' <span class="lp-note">live mode</span>' : ""}</label>`).join("")}`;
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
  document.addEventListener("click", (e) => { if (!panelEl.hidden && !panelEl.contains(e.target) && e.target !== buttonEl) open(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panelEl.hidden) { open(false); buttonEl.focus(); } });
}

// Live-only toggles are disabled outside live mode.
export function setLiveMode(panelEl, isLive) {
  panelEl.querySelectorAll("[data-live-only] input").forEach((i) => { i.disabled = !isLive; });
  panelEl.querySelectorAll("[data-live-only]").forEach((l) => l.classList.toggle("off", !isLive));
}
