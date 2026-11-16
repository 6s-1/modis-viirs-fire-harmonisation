// "Aa" text size: three steps, remembered between visits. It scales the root font size, and the
// whole interface is sized in rem and em from there, so nothing has to be restyled per step.

const KEY = "ember:textsize";
const STEPS = [
  { id: "default", label: "Default", scale: 1, aria: "Default text size", tip: "Default text size" },
  { id: "large", label: "Large", scale: 1.125, aria: "Large text, 112.5 percent", tip: "Large text (112%)" },
  { id: "larger", label: "Larger", scale: 1.25, aria: "Larger text, 125 percent", tip: "Larger text (125%)" },
];

function read() {
  try {
    const v = localStorage.getItem(KEY);
    return STEPS.some((s) => s.id === v) ? v : "default";
  } catch { return "default"; }
}

function apply(id) {
  const step = STEPS.find((s) => s.id === id) || STEPS[0];
  document.documentElement.style.fontSize = `${step.scale * 100}%`;
  document.documentElement.dataset.textsize = step.id;
}

export function initTextSize(host = document.querySelector(".textsize")) {
  let current = read();
  apply(current);
  if (!host) return;
  // title as well as aria-label: the single letters say nothing on their own, so pointing at one
  // explains what it does rather than leaving the reader to click and find out.
  host.title = "Text size: make everything in the app larger or smaller";
  host.innerHTML = `<span class="ts-label" aria-hidden="true" title="Text size">Aa</span>${STEPS.map((s) =>
    `<button type="button" class="ts-btn" data-size="${s.id}" aria-label="${s.aria}" title="${s.tip}"
       aria-pressed="${s.id === current}"><span aria-hidden="true">${s.label[0]}</span></button>`).join("")}`;
  host.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-size]");
    if (!btn) return;
    current = btn.dataset.size;
    try { localStorage.setItem(KEY, current); } catch { /* storage unavailable */ }
    apply(current);
    host.querySelectorAll("[data-size]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.size === current)));
  });
}
