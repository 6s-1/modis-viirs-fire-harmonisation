// Info icon: an "i" that shows its details in the shared tooltip on hover or keyboard focus.
// Details live here instead of on the main screen.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = (html) => html.replace(/<br\s*\/?>/g, ". ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// html may contain simple markup (<br>, <strong>, <span class="muted">).
export const infoIcon = (html, cls = "") =>
  `<span class="info-i${cls ? ` ${cls}` : ""}" tabindex="0" role="img" aria-label="${esc(plain(html))}" data-info="${esc(html)}">i</span>`;

export function attachInfoTips(tip) {
  let owner = null;
  const show = (el) => {
    owner = el;
    tip.innerHTML = el.dataset.info;
    tip.hidden = false;
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 8));
    const below = r.bottom + 8 + t.height < innerHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - t.height - 8)}px`;
  };
  const hide = (el) => { if (owner === el) { tip.hidden = true; owner = null; } };
  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.(".info-i[data-info]");
    if (el) show(el); else if (owner) hide(owner);
  });
  document.addEventListener("focusin", (e) => { const el = e.target.closest?.(".info-i[data-info]"); if (el) show(el); });
  document.addEventListener("focusout", (e) => { const el = e.target.closest?.(".info-i[data-info]"); if (el) hide(el); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && owner) hide(owner); });
}
