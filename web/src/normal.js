// "Is this normal?" — one yes or no, and one sentence saying the direction and how far.
//
// Normal means between the 10th and 90th percentile of the same period in every past year.
// "Usual" is their median. The ratio is value / median: "N times higher" above, a plain fraction
// below. Rank is named only for a record; otherwise it sits in the tooltip.

import { MONTHS, fmt, median, monthDays, quantile } from "./data.js";

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const MIN_YEARS = 5;

// Simple fractions read better than "0.2 times": a fifth, not 0.2.
const FRACTIONS = [
  [0.9, "about nine tenths of"], [0.8, "four fifths of"], [0.75, "three quarters of"],
  [0.67, "two thirds of"], [0.6, "three fifths of"], [0.5, "half of"], [0.4, "two fifths of"],
  [0.33, "a third of"], [0.25, "a quarter of"], [0.2, "a fifth of"], [0.1, "a tenth of"],
];
function fractionWord(r) {
  if (r <= 0) return "none of";
  if (r < 0.05) return "a twentieth of";
  let best = FRACTIONS[0];
  for (const f of FRACTIONS) if (Math.abs(Math.log(r / f[0])) < Math.abs(Math.log(r / best[0]))) best = f;
  return best[1];
}
const timesWord = (r) => `${r >= 10 ? Math.round(r) : r.toFixed(1)} times higher than`;

// values: the same period in each past year. now: this period. label: "a usual November".
export function judge({ past, now, periodLabel, ongoing }) {
  const vals = past.map((p) => p.value).filter(Number.isFinite);
  const withFire = vals.filter((v) => v > 0).length;
  if (vals.length < MIN_YEARS || withFire < MIN_YEARS) {
    return { verdict: null, text: "Not enough fire here to judge.", tone: "flat" };
  }
  const lo = quantile(vals, 0.1), hi = quantile(vals, 0.9), mid = median(vals);
  const above = vals.filter((v) => v > now).length;
  const below = vals.filter((v) => v < now).length;
  const verb = ongoing ? "is" : "was";
  const rank = above + 1, of = vals.length + 1;

  // records first: no ratio reads well against a record
  if (above === 0 && now > hi) {
    return { verdict: "No", tone: "high", rank: `#1 of ${of}`,
      text: `This ${verb} the highest fire activity on record for ${periodLabel.replace(/^a usual /, "")}.` };
  }
  if (below === 0 && now < lo) {
    return { verdict: "No", tone: "low", rank: `#${of} of ${of}`,
      text: `This ${verb} the lowest fire activity on record for ${periodLabel.replace(/^a usual /, "")}.` };
  }
  if (now >= lo && now <= hi) {
    return { verdict: "Yes", tone: "flat", rank: `#${rank} of ${of}`,
      text: `Fire activity ${verb} close to ${periodLabel}.` };
  }
  const ratio = mid > 0 ? now / mid : null;
  if (ratio === null) {
    return { verdict: "No", tone: now > hi ? "high" : "low", rank: `#${rank} of ${of}`,
      text: `Fire activity ${verb} unusual for ${periodLabel}.` };
  }
  const how = ratio >= 1 ? timesWord(ratio) : fractionWord(ratio);
  return { verdict: "No", tone: now > hi ? "high" : "low", rank: `#${rank} of ${of}`,
    text: `Fire activity ${verb} ${how} ${periodLabel}.` };
}

// ---- choosing the period to compare

const monthName = (m) => LONG[m - 1];

// A clicked month, a short date range, a live window, or the latest month in a long range.
// Returns { past: [{year, value}], now, periodLabel, ongoing } or null when it cannot be framed.
export function framePeriod(d, agg, { range, clickedMonth, live }) {
  if (live) return frameLive(d, agg, live);
  if (clickedMonth !== undefined && clickedMonth !== null) return frameMonth(d, agg, clickedMonth);

  const [a, b] = range;
  const span = b - a + 1;
  if (span <= 12) return frameSpan(d, agg, a, b);
  // A long range has no single period to judge. The latest month is the obvious choice, but for a
  // place that never burns then it says nothing; fall back to the month this area actually burns
  // in, which is the question a reader of a whole record is really asking.
  const latest = frameMonth(d, agg, b);
  if (latest && latest.past.filter((p) => p.value > 0).length >= MIN_YEARS) return latest;
  const byMonth = new Array(12).fill(0);
  for (let k = a; k <= b; k++) byMonth[d.months[k].m - 1] += agg.totals[k];
  const peak = byMonth.indexOf(Math.max(...byMonth));
  if (!(byMonth[peak] > 0)) return latest;
  // the most recent complete instance of that month inside the range
  for (let k = b; k >= a; k--) {
    if (d.months[k].m === peak + 1 && !d.months[k].partial) return frameMonth(d, agg, k);
  }
  return latest;
}

function frameMonth(d, agg, mi) {
  const info = d.months[mi];
  const partial = info.partial;
  const sd = d.manifest.same_days;
  // an unfinished month compares the same days of that month in past years
  if (partial && sd && sd.month === info.m && sd.year === info.y) {
    const past = sd.years.filter((y) => y !== info.y).map((y) => ({ year: y, value: agg.sameDays.get(y) || 0 }));
    return { past, now: agg.totals[mi], ongoing: true,
      periodLabel: `a usual 1–${sd.days} ${MONTHS[info.m - 1]}` };
  }
  const past = [];
  for (let y = d.firstYear; y <= d.lastYear; y++) {
    if (y === info.y) continue;
    const k = d.monthIndex.get(y * 100 + info.m);
    if (k === undefined || d.months[k].partial) continue;
    past.push({ year: y, value: agg.totals[k] });
  }
  return { past, now: agg.totals[mi], ongoing: partial, periodLabel: `a usual ${monthName(info.m)}` };
}

// A range of up to twelve months, against the same calendar span in every other year.
function frameSpan(d, agg, a, b) {
  const first = d.months[a], last = d.months[b];
  const months = [];
  for (let k = a; k <= b; k++) months.push(d.months[k].m);
  const ongoing = last.partial;
  let now = 0;
  for (let k = a; k <= b; k++) now += agg.totals[k];

  const past = [];
  const spanYears = last.y - first.y;
  for (let y = d.firstYear; y <= d.lastYear - spanYears; y++) {
    if (y === first.y) continue;
    let sum = 0, ok = true;
    for (let k = a; k <= b; k++) {
      const off = d.months[k].y - first.y;
      const j = d.monthIndex.get((y + off) * 100 + d.months[k].m);
      // the same span must be complete in that year to compare like with like
      if (j === undefined || d.months[j].partial) { ok = false; break; }
      sum += agg.totals[j];
    }
    if (ok) past.push({ year: y, value: sum });
  }
  const label = months.length === 1 ? `a usual ${monthName(first.m)}`
    : `a usual ${monthName(first.m)} to ${monthName(last.m)}`;
  return { past, now, ongoing, periodLabel: label };
}

// Live: this window against the same days of the year in the record's past years.
function frameLive(d, agg, live) {
  const end = new Date();
  const m = end.getUTCMonth() + 1, day = end.getUTCDate();
  const days = live.hours / 24;
  const daysInMonth = new Date(Date.UTC(end.getUTCFullYear(), m, 0)).getUTCDate();
  const share = Math.min(1, days / daysInMonth);
  const viirs = ["snpp", "noaa20"].map((p) => agg.detOf(p));
  const past = [];
  for (let y = 2012; y < end.getUTCFullYear(); y++) {
    const i = d.monthIndex.get(y * 100 + m);
    if (i === undefined || d.months[i].partial) continue;
    past.push({ year: y, value: viirs.reduce((s, v) => s + v[i], 0) * share });
  }
  const part = day <= 10 ? "early" : day <= 20 ? "mid-" : "late ";
  return { past, now: live.count, ongoing: true,
    periodLabel: `a usual ${part}${part === "mid-" ? "" : " "}${monthName(m)}`.replace("  ", " ") };
}

export { MIN_YEARS };
