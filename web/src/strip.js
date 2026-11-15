// "Now against the past": one past period per dot on a single axis, with the current period
// marked and labelled. Used wherever the page compares now with past years, so the comparison
// always looks the same.
//
// Marks are labelled directly, so the strip needs no legend.

import { fmt, median } from "./data.js";

const f1 = (v) => v.toFixed(1);

// points: [{ year, value }] for the past periods. now: { label, value } for the current one.
// axisTitle names what the dots are, e.g. "Past Octobers".
export function distributionStrip({ points, now, axisTitle, unit = "cell-days", tipFor }) {
  const vals = points.map((p) => p.value);
  if (!vals.length) return "";
  const med = median(vals);
  const W = 560, H = 86, padL = 10, padR = 16;
  const lo = 0, hi = Math.max(...vals, now ? now.value : 0);
  const max = hi > lo ? hi * 1.06 : 1;
  const x = (v) => padL + ((W - padL - padR) * v) / max;
  const AX = 50; // the axis line

  // dots can collide; nudge equal-ish values apart vertically so each year stays visible
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const placed = [];
  const rows = [];
  for (const p of sorted) {
    const px = x(p.value);
    let row = 0;
    while (rows[row] !== undefined && px - rows[row] < 9) row++;
    rows[row] = px;
    placed.push({ ...p, px, row });
  }
  const dots = placed.map((p) => {
    const cy = AX - 9 - p.row * 9;
    return `<circle cx="${f1(p.px)}" cy="${f1(cy)}" r="3.6" class="sd-past"${tipFor ? ` ${tipFor(p)}` : ""}/>`;
  }).join("");

  const medX = x(med);
  const nowX = now ? x(now.value) : 0;
  // keep the two labels from sitting on top of each other
  const apart = now ? Math.abs(nowX - medX) > 120 : true;
  const medAnchor = medX > W - 120 ? "end" : "start";
  const nowAnchor = nowX > W - 110 ? "end" : nowX < 70 ? "start" : "middle";

  return `<svg viewBox="0 0 ${W} ${H}" class="ychart strip" role="img"
    aria-label="${axisTitle}: ${now ? `${now.label} ${fmt(now.value)} ${unit}, ` : ""}typical ${fmt(med)}, ${points.length} past periods from ${Math.min(...points.map((p) => p.year))} to ${Math.max(...points.map((p) => p.year))}">
    <path d="M${padL},${AX}H${W - padR}" class="sd-axis"/>
    ${dots}
    <path d="M${f1(medX)},${AX - 7}V${AX + 7}" class="sd-med"/>
    <text x="${f1(medAnchor === "end" ? medX - 6 : medX + 6)}" y="${AX + 20}" class="sd-lab" text-anchor="${medAnchor}">Typical: ${fmt(med)}</text>
    ${now ? `<circle cx="${f1(nowX)}" cy="${AX}" r="7" class="sd-now"/>
      <text x="${f1(nowX)}" y="${apart ? AX + 20 : AX + 34}" class="sd-lab strong" text-anchor="${nowAnchor}">${now.label}: ${fmt(now.value)}</text>` : ""}
    <text x="${padL}" y="${H - 4}" class="sd-axis-title">${axisTitle}</text>
  </svg>`;
}

// "Quieter than 25 of 26 past Octobers" / "Busier than ..." for the line under the chart.
export function rankSentence({ points, now, noun }) {
  const vals = points.map((p) => p.value);
  const n = vals.length;
  if (!n || !now) return "";
  const below = vals.filter((v) => v < now.value).length;
  const above = n - below;
  if (above === 0) return `The busiest of ${n + 1} ${noun} on record.`;
  if (below === 0) return `The quietest of ${n + 1} ${noun} on record.`;
  return above > below
    ? `Quieter than ${above} of ${n} past ${noun}.`
    : `Busier than ${below} of ${n} past ${noun}.`;
}
