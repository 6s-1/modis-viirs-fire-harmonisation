// The mascot and its tour: six steps, one sentence each, each spotlighting a real control.
// It never opens by itself; a dot on the mascot invites it on a first visit.

const SEEN = "ember:tour-seen";

// Six steps in each mode, in the order a reader meets the app. A step may open a view (the
// Layers panel, compare) to spotlight what it is talking about; whatever it opened is put back
// when the tour ends.
const HISTORICAL = [
  { target: "#draw", text: "Draw a box on the globe to choose an area." },
  { target: "#sec-calendar", text: "Every month since 2000; darker means more fire, dashed means estimated from older satellites." },
  { target: "#calendar", text: "Click a month or a cell to see what caused the fire, how much land burned and what kind of land it was." },
  { target: "#layers-panel", open: "layers", text: "Turn on 'Where fire is changing' to see where fire is rising or falling, or Places to find your way." },
  { target: "#sec-compare", text: "Yearly totals, when the season runs, and how many people lived where fire burned." },
  { target: "#compare-btn", open: "compare", text: "Compare puts fire and people on two linked globes; point at one and the other follows." },
];
const LIVE = [
  { target: ".modebar", text: "Live shows what NASA satellites detected in the last day or week, near real time." },
  { target: "#live-window", text: "Pick the last 24 hours, 48 hours or 7 days." },
  { target: "#map", text: "Hotspots are grouped into the same cells as the history, so live and past read the same way." },
  { target: "#map", text: "Click a cell to see the agency's name, size and status for the fire there, and its fire history." },
  { target: "#sec-exposure", text: "These are the places with fire right now, ranked by how many people live there." },
  { target: ".modebar", text: "Switch to Historical to see how today compares with the last 26 years." },
];
const stepsFor = (live) => (live ? LIVE : HISTORICAL);
let STEPS = stepsFor(false);
// what a step opened, so the tour can put it back
let opened = null;
function openFor(step, helpers) {
  if (step.open === "layers" && helpers.openLayers) { helpers.openLayers(true); opened = opened || {}; opened.layers = true; }
  if (step.open === "compare" && helpers.setCompare && !helpers.isCompare()) { helpers.setCompare(true); opened = opened || {}; opened.compare = true; }
}
function restore(helpers) {
  if (!opened) return;
  if (opened.layers && helpers.openLayers) helpers.openLayers(false);
  if (opened.compare && helpers.setCompare) helpers.setCompare(false);
  opened = null;
}

export function initTour(host, isLive = () => false, helpers = {}) {
  // the trigger is the header button; this element only holds focus state
  const mascot = document.getElementById("tour-btn") || document.createElement("button");
  let seen = false;
  try { seen = localStorage.getItem(SEEN) === "1"; } catch { /* storage unavailable */ }

  let layer = null, step = 0;

  const stop = () => {
    restore(helpers);
    if (layer) { layer.remove(); layer = null; }
    document.removeEventListener("keydown", onKey);
    mascot.setAttribute("aria-expanded", "false");
    mascot.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === "Escape") stop();
    if (e.key === "ArrowRight") show(step + 1);
    if (e.key === "ArrowLeft") show(step - 1);
  };

  function show(n) {
    if (n < 0 || n >= STEPS.length) return stop();
    step = n;
    const s = STEPS[n];
    openFor(s, helpers);
    const el = document.querySelector(s.target);
    if (!el) return show(n + 1); // a control that is not on screen in this mode
    el.scrollIntoView({ behavior: "auto", block: "nearest" }); // measure after the scroll, not during it
    const r = el.getBoundingClientRect();
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "tour";
      layer.innerHTML = `<div class="tour-spot"></div>
        <div class="tour-box" role="dialog" aria-modal="true" aria-label="Tour">
          <p class="tour-step"></p><p class="tour-text"></p>
          <div class="tour-btns">
            <button type="button" class="ghost" data-act="back">Back</button>
            <button type="button" data-act="next">Next</button>
            <button type="button" class="linkish" data-act="skip">Skip</button>
          </div>
        </div>`;
      document.body.appendChild(layer);
      layer.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (act === "next") show(step + 1);
        if (act === "back") show(step - 1);
        if (act === "skip") stop();
      });
      document.addEventListener("keydown", onKey);
    }
    const pad = 6;
    // a target taller than the window is spotlighted only where it shows
    const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    const spot = layer.querySelector(".tour-spot");
    spot.style.cssText = `left:${r.left - pad}px;top:${top - pad}px;width:${r.width + pad * 2}px;height:${Math.max(bottom - top, 24) + pad * 2}px`;
    layer.querySelector(".tour-step").textContent = `${n + 1} of ${STEPS.length}`;
    layer.querySelector(".tour-text").textContent = s.text;
    layer.querySelector('[data-act="back"]').disabled = n === 0;
    layer.querySelector('[data-act="next"]').textContent = n === STEPS.length - 1 ? "Done" : "Next";
    // the box sits below the spotlight, or above it when there is no room, and always stays on screen
    const box = layer.querySelector(".tour-box");
    const BH = 150, BW = 300;
    const wanted = bottom + 14 + BH < innerHeight ? bottom + 14 : top - BH - 14;
    box.style.top = `${Math.min(Math.max(12, wanted), Math.max(12, innerHeight - BH - 12))}px`;
    box.style.left = `${Math.min(Math.max(12, r.left), Math.max(12, innerWidth - BW - 12))}px`;
    layer.querySelector('[data-act="next"]').focus({ preventScroll: true });
  }

  const start = () => {
    try { localStorage.setItem(SEEN, "1"); } catch { /* ignore */ }
    mascot.querySelector(".mascot-dot")?.remove();
    document.querySelector(".tour-dot")?.remove();
    mascot.setAttribute("aria-expanded", "true");
    STEPS = stepsFor(isLive()); // the steps follow the mode the reader is in
    show(0);
  };
  mascot.addEventListener("click", start);
  return { start, seen };
  addEventListener("resize", () => { if (layer) show(step); });
}
