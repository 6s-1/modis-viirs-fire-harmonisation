// Three map views:
//   single   one globe
//   compare  two globes stacked, each showing a layer the reader picks
//   swipe    one globe with a draggable divider, a different layer either side
//
// In compare the two globes are locked: a move on one is copied to the other. The copy is made
// inside a guard flag so the echo back does not start a loop, and it uses jumpTo so the follower
// lands exactly where the leader is, with no easing and no lag.

export const VIEW_LAYERS = [
  { id: "fire", label: "Fire activity" },
  { id: "trend", label: "Where fire is changing" },
  { id: "people", label: "Where people live" },
];
const KEY = "ember:view";

export const view = { mode: "single", top: "fire", bottom: "people", split: 0.5 };
try {
  const v = JSON.parse(localStorage.getItem(KEY) || "{}");
  if (v && typeof v === "object") Object.assign(view, { top: v.top || view.top, bottom: v.bottom || view.bottom });
} catch { /* storage unavailable */ }
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ top: view.top, bottom: view.bottom })); } catch { /* ignore */ }
}

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

export function layerPicker(which, onChange) {
  const el = document.createElement("div");
  el.className = "map-ui corner-tc view-pick";
  el.innerHTML = `<select aria-label="Layer shown on this map">${VIEW_LAYERS.map((l) =>
    `<option value="${l.id}"${view[which] === l.id ? " selected" : ""}>${l.label}</option>`).join("")}</select>`;
  el.querySelector("select").addEventListener("change", (e) => {
    view[which] = e.target.value;
    save();
    onChange();
  });
  return el;
}

// ---- swipe divider

export function attachSwipe(container, onMove) {
  const handle = document.createElement("div");
  handle.className = "swipe-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", "Drag to compare, or use the arrow keys");
  handle.setAttribute("aria-valuemin", "0");
  handle.setAttribute("aria-valuemax", "100");
  handle.tabIndex = 0;
  handle.innerHTML = `<span class="swipe-grip"></span>`;
  container.appendChild(handle);
  const place = (frac) => {
    view.split = Math.min(0.95, Math.max(0.05, frac));
    handle.style.left = `${view.split * 100}%`;
    handle.setAttribute("aria-valuenow", String(Math.round(view.split * 100)));
    onMove(view.split);
  };
  const fromX = (clientX) => {
    const r = container.getBoundingClientRect();
    place((clientX - r.left) / r.width);
  };
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => { dragging = true; handle.setPointerCapture(e.pointerId); e.preventDefault(); });
  handle.addEventListener("pointermove", (e) => { if (dragging) fromX(e.clientX); });
  const stop = (e) => { if (dragging) { dragging = false; try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ } } };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") { place(view.split - step); e.preventDefault(); }
    if (e.key === "ArrowRight") { place(view.split + step); e.preventDefault(); }
  });
  place(view.split);
  return { handle, place };
}
