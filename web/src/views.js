// Two map views:
//   single   one globe
//   compare  two globes stacked, each showing a layer the reader picks
//
// In compare the two globes are locked: a move on one is copied to the other. The copy is made
// inside a guard flag so the echo back does not start a loop, and it uses jumpTo so the follower
// lands exactly where the leader is, with no easing and no lag.
//
// The two globes never show the same layer: the one picked on either globe is disabled in the
// other's menu, and a remembered or shared setting that would collide falls back to fire above
// and people below.

export const VIEW_LAYERS = [
  { id: "fire", label: "Fire activity" },
  { id: "trend", label: "Where fire is changing" },
  { id: "people", label: "Where people live" },
];
const KEY = "ember:view";

export const view = { mode: "single", top: "fire", bottom: "people" };
try {
  const v = JSON.parse(localStorage.getItem(KEY) || "{}");
  if (v && typeof v === "object") Object.assign(view, { top: v.top || view.top, bottom: v.bottom || view.bottom });
} catch { /* storage unavailable */ }
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ top: view.top, bottom: view.bottom })); } catch { /* ignore */ }
}

const known = (id) => VIEW_LAYERS.some((l) => l.id === id);
// Validate the pair: unknown ids, or the same layer on both globes, fall back to fire and people.
export function fixPair() {
  if (!known(view.top) || !known(view.bottom) || view.top === view.bottom) {
    view.top = "fire";
    view.bottom = "people";
  }
}
fixPair();

// ---- locked cameras

let syncing = false;
export function lockCameras(maps) {
  const copy = (from) => {
    if (syncing) return;
    syncing = true; // guard: the jumpTo below fires move on the followers
    const c = from.getCenter(), z = from.getZoom(), b = from.getBearing(), p = from.getPitch();
    for (const m of maps) {
      if (m === from) continue;
      m.jumpTo({ center: c, zoom: z, bearing: b, pitch: p });
    }
    syncing = false;
  };
  const offs = [];
  for (const m of maps) {
    const h = () => copy(m);
    m.on("move", h);
    offs.push(() => m.off("move", h));
  }
  return () => offs.forEach((off) => off());
}

// ---- the small layer picker that sits on each globe

const pickers = [];
function paint() {
  for (const { el, which } of pickers) {
    const other = which === "top" ? view.bottom : view.top;
    for (const opt of el.querySelectorAll("option")) {
      const taken = opt.value === other;
      opt.disabled = taken;
      opt.title = taken ? "Already shown on the other globe" : "";
      opt.textContent = taken ? `${VIEW_LAYERS.find((l) => l.id === opt.value).label} (on the other globe)`
        : VIEW_LAYERS.find((l) => l.id === opt.value).label;
    }
    el.querySelector("select").value = view[which];
  }
}
export function layerPicker(which, onChange) {
  const el = document.createElement("div");
  el.className = "map-ui corner-tc view-pick";
  el.innerHTML = `<select aria-label="Layer shown on this map">${VIEW_LAYERS.map((l) =>
    `<option value="${l.id}">${l.label}</option>`).join("")}</select>`;
  el.querySelector("select").addEventListener("change", (e) => {
    view[which] = e.target.value;
    fixPair();
    save();
    paint();
    onChange();
  });
  pickers.push({ el, which });
  paint();
  return el;
}
export { paint as repaintPickers };
