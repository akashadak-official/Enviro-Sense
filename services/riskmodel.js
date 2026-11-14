'use strict';
// Fire-risk outlook model. Pure functions: no database and no network, so it can be tested alone.
// A "series" is a Map: 'YYYY-MM-DD' -> { d, v, m, vi }
// where v is the harmonized burning-cell count (null when no satellite covered that day).

const HALF_WINDOW = 7;   // look +-7 days around the same date in earlier years
const MAX_YEARS = 6;
const MIN_POINTS = 8;    // an earlier year counts only if it has this many days inside the window
const EPS = 0.5;         // smoothing, so quiet places do not give silly ratios
const DECAY_DAYS = 10;   // how fast "the last weeks were unusual" fades back to the seasonal normal
const LEVELS = ['LOW', 'MODERATE', 'HIGH'];

const iso = d => d.toISOString().slice(0, 10);
function addDays(str, n) {
  const d = new Date(str + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
function addYears(str, n) {
  const d = new Date(str + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return iso(d);
}
const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const round1 = x => Math.round(x * 10) / 10;
const round2 = x => Math.round(x * 100) / 100;

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// ---- what this date usually looks like, from the same dates in earlier years ----
function seasonal(series, date) {
  const yearMeans = [], values = [];
  for (let k = 1; k <= MAX_YEARS; k++) {
    const center = addYears(date, -k);
    const vals = [];
    for (let j = -HALF_WINDOW; j <= HALF_WINDOW; j++) {
      const p = series.get(addDays(center, j));
      if (p && p.v !== null) vals.push(p.v);
    }
    if (vals.length >= MIN_POINTS) {
      yearMeans.push(mean(vals));
      for (const v of vals) values.push(v);
    }
  }
  if (!yearMeans.length) return null;
  return { mean: mean(yearMeans), years: yearMeans.length, values };
}

// ---- are the last two weeks above or below what is normal for them? ----
function trend(series, origin, lookback = 14) {
  const actual = [], expected = [];
  for (let i = 0; i < lookback; i++) {
    const d = addDays(origin, -i);
    const p = series.get(d);
    if (!p || p.v === null) continue;
    const s = seasonal(series, d);
    if (!s) continue;
    actual.push(p.v);
    expected.push(s.mean);
  }
  if (actual.length < 7) return { ratio: 1, recent: null, expectedRecent: null, days: actual.length };
  const a = mean(actual), e = mean(expected);
  return {
    ratio: clamp((a + EPS) / (e + EPS), 1 / 3, 3),
    recent: round1(a), expectedRecent: round1(e), days: actual.length
  };
}

// ---- forecast of the next `horizon` days, using only data up to `origin` ----
function forecast(series, origin, horizon = 14) {
  const tr = trend(series, origin);
  const days = [];
  for (let h = 1; h <= horizon; h++) {
    const date = addDays(origin, h);
    const s = seasonal(series, date);
    if (!s) { days.push({ d: date, h, mean: null, low: null, high: null, normal: null, years: 0 }); continue; }
    const factor = 1 + (tr.ratio - 1) * Math.exp(-h / DECAY_DAYS);
    const m = s.mean * factor;
    const sorted = s.values.slice().sort((a, b) => a - b);
    days.push({
      d: date, h,
      mean: round1(m),
      low: round1(Math.min(quantile(sorted, 0.1) * factor, m)),
      high: round1(Math.max(quantile(sorted, 0.9) * factor, m)),
      normal: round1(s.mean),
      years: s.years
    });
  }
  return { origin, trend: tr, days };
}

// ---- risk levels are relative to this place's own history ----
function thresholds(series, cutoff) {
  const vals = [];
  for (const p of series.values()) if (p.v !== null && p.d <= cutoff) vals.push(p.v);
  if (vals.length < 60) return null;
  vals.sort((a, b) => a - b);
  const moderate = Math.max(quantile(vals, 0.6), 1);
  let high = Math.max(quantile(vals, 0.85), 3);
  if (high < moderate * 1.5) high = moderate * 1.5;
  return { moderate: round1(moderate), high: round1(high), max: vals[vals.length - 1], n: vals.length };
}

function levelOf(v, th) {
  if (v === null || v === undefined) return null;
  return v >= th.high ? 'HIGH' : v >= th.moderate ? 'MODERATE' : 'LOW';
}

// ---- honest self-test: forecast the past, compare with what really happened ----
function backtest(series, last, horizon = 14, span = 180, step = 7) {
  const errModel = [], errSeasonal = [], errPersist = [];
  let exact = 0, within1 = 0, inRange = 0, levelN = 0, origins = 0;

  for (let back = span; back >= horizon; back -= step) {
    const origin = addDays(last, -back);
    const th = thresholds(series, origin);
    const f = forecast(series, origin, horizon);

    const recent = [];
    for (let i = 0; i < 7; i++) {
      const p = series.get(addDays(origin, -i));
      if (p && p.v !== null) recent.push(p.v);
    }
    const persist = recent.length >= 4 ? mean(recent) : null;

    let used = false;
    for (const day of f.days) {
      const actual = series.get(day.d);
      if (!actual || actual.v === null || day.mean === null || persist === null) continue;
      used = true;
      errModel.push(Math.abs(day.mean - actual.v));
      errSeasonal.push(Math.abs(day.normal - actual.v));
      errPersist.push(Math.abs(persist - actual.v));
      if (actual.v >= day.low && actual.v <= day.high) inRange++;
      if (th) {
        const a = LEVELS.indexOf(levelOf(actual.v, th)), p = LEVELS.indexOf(levelOf(day.mean, th));
        levelN++;
        if (a === p) exact++;
        if (Math.abs(a - p) <= 1) within1++;
      }
    }
    if (used) origins++;
  }

  const n = errModel.length;
  if (n < 30) return null;
  const maeModel = mean(errModel), maeSeasonal = mean(errSeasonal), maePersistence = mean(errPersist);
  const best = Math.min(maeSeasonal, maePersistence);
  let verdict;
  if (Math.max(maeModel, best) < 0.1) verdict = 'n/a';
  else if (maeModel <= best * 0.95) verdict = 'better';
  else if (maeModel <= best * 1.05) verdict = 'similar';
  else verdict = 'worse';

  return {
    forecasts: origins, points: n, spanDays: span,
    maeModel: round2(maeModel), maeSeasonal: round2(maeSeasonal), maePersistence: round2(maePersistence),
    verdict,
    levelExact: levelN ? round2(exact / levelN) : null,
    levelWithinOne: levelN ? round2(within1 / levelN) : null,
    rangeCoverage: round2(inRange / n)
  };
}

// ---- everything the dashboard needs, in one object ----
function buildOutlook(series, last, horizon = 14, today = iso(new Date())) {
  const th = thresholds(series, last);
  if (!th) return { tooLittle: true };

  const f = forecast(series, last, horizon);
  const days = f.days.map(x => ({ ...x, level: x.mean === null ? null : levelOf(x.mean, th) }));
  const known = days.filter(x => x.mean !== null);
  if (!known.length) return { noBaseline: true, asOf: last };

  const peak = known.reduce((b, x) => (x.mean > b.mean ? x : b), known[0]);
  const counts = { LOW: 0, MODERATE: 0, HIGH: 0 };
  known.forEach(x => { counts[x.level]++; });

  const ratio = f.trend.ratio;
  const direction = ratio >= 1.25 ? 'above' : ratio <= 0.8 ? 'below' : 'near';
  const seasonsUsed = Math.min(...known.map(x => x.years));
  const bt = backtest(series, last, horizon);

  let confidence = seasonsUsed >= 3 ? 'good' : seasonsUsed === 2 ? 'fair' : 'low';
  if (bt && bt.verdict === 'worse') confidence = confidence === 'good' ? 'fair' : 'low';

  const quiet = th.max < 1;
  const notes = [];
  if (quiet) notes.push('Very little burning has been recorded around this place, so levels are mostly LOW.');
  if (seasonsUsed <= 1) notes.push('Only one earlier season is available for these dates, so treat the outlook as rough.');
  const stale = daysBetween(last, today) - 1;
  if (stale >= 3) notes.push(`Satellite data ends on ${last} (${stale} days ago); the outlook starts from that date.`);
  if (bt && bt.verdict === 'worse') notes.push('In the backtest this model did worse than a simple baseline here, so rely on it less.');

  return {
    asOf: last, horizon,
    thresholds: { moderate: th.moderate, high: th.high },
    days, peak: { d: peak.d, mean: peak.mean, low: peak.low, high: peak.high, level: peak.level },
    counts,
    avgForecast: round1(mean(known.map(x => x.mean))),
    avgTypical: round1(mean(known.map(x => x.normal))),
    trend: { ratio: round2(ratio), direction, recent: f.trend.recent, expectedRecent: f.trend.expectedRecent, days: f.trend.days },
    seasonsUsed, confidence, quiet, backtest: bt, notes
  };
}

module.exports = {
  seasonal, trend, forecast, thresholds, levelOf, backtest, buildOutlook,
  addDays, addYears, daysBetween
};
