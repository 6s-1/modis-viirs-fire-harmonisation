// Frame-rate readout for checking compare-mode panning on a real machine.
// Off unless the URL carries ?fps=1. Dev builds only; it is never bundled into the site.

export function attachFps(getMode) {
  if (new URLSearchParams(location.search).get("fps") !== "1") return;
  const el = document.createElement("div");
  el.className = "fps-meter";
  el.innerHTML = `<b>–</b> fps <span class="fps-sub">worst – ms</span>`;
  document.body.appendChild(el);
  const out = el.querySelector("b"), sub = el.querySelector(".fps-sub");

  const recent = [];     // frame gaps in the last second, for the live number
  const session = [];    // every gap since the last reset, for the worst frame
  let last = performance.now();
  let shownAt = 0;

  const tick = (now) => {
    const gap = now - last;
    last = now;
    recent.push(gap);
    session.push(gap);
    while (recent.length > 120) recent.shift();
    if (now - shownAt > 250 && recent.length > 5) {
      shownAt = now;
      const sorted = [...recent].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const worst = Math.max(...session.slice(-600));
      const fps = 1000 / median;
      out.textContent = fps.toFixed(0);
      el.dataset.level = fps >= 50 ? "good" : fps >= 30 ? "ok" : "bad";
      sub.textContent = `worst ${worst.toFixed(0)} ms · ${getMode()}`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  el.title = "Click to reset the worst frame";
  el.addEventListener("click", () => { session.length = 0; });
}
