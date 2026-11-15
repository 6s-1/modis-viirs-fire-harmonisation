// The mascot and its tour: six steps, one sentence each, each spotlighting a real control.
// It never opens by itself; a dot on the mascot invites it on a first visit.

const SEEN = "ember:tour-seen";

const STEPS = [
  { target: "#draw", text: "Draw a box on the globe, or pick the Okanagan, to choose an area." },
  { target: "#sec-calendar", text: "The calendar shows every month since 2000, darker where more burned." },
  { target: "#calendar", text: "Click a month, or a cell on the map, to see why it burned." },
  { target: "#sec-compare", text: "Compared with past years puts this year against the whole record." },
  { target: "#compare-btn", text: "Compare splits the globe in two, so fire and people line up." },
  { target: ".modebar", text: "Live swaps the record for hotspots from the last day or week." },
];

export function initTour(host) {
  const mascot = document.createElement("button");
  mascot.type = "button";
  mascot.className = "mascot";
  mascot.setAttribute("aria-label", "Take a short tour of Ember");
  let seen = false;
  try { seen = localStorage.getItem(SEEN) === "1"; } catch { /* storage unavailable */ }
  mascot.innerHTML = `<img src="./brand/mascot.svg" alt="" />${seen ? "" : `<span class="mascot-dot" aria-hidden="true"></span>`}`;
  host.appendChild(mascot);

  let layer = null, step = 0;

  const stop = () => {
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

  mascot.addEventListener("click", () => {
    try { localStorage.setItem(SEEN, "1"); } catch { /* ignore */ }
    mascot.querySelector(".mascot-dot")?.remove();
    mascot.setAttribute("aria-expanded", "true");
    show(0);
  });
  addEventListener("resize", () => { if (layer) show(step); });
}
