const express = require('express');
const { requireAuth, requireAdmin } = require('./auth');
const F = require('./services/firms');
const { resolvePlace } = require('./geo');
const { addDays, iso, COVERAGE } = F;

const router = express.Router();
const MIN_FLAG = 5;      // ignore anomalies on days with fewer cells than this
const MIN_SEASONS = 2;   // need at least this many other years with data for the same time of year
const Z_HIGH = 2.5, Z_EXTREME = 3.5;     // how far above normal a day must be (in spreads) to be flagged

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---------- harmonized daily series for one place ----------
function buildSeries(lat, lon, radiusKm) {
  const cov = F.coverageSets();
  const all = [...cov.MODIS, ...cov.VIIRS].sort();
  if (!all.length) return null;

  const counts = F.boxCounts(lat, lon, radiusKm);
  const factor = F.calibration();
  const yesterday = addDays(iso(new Date()), -1);
  const last = all[all.length - 1] < yesterday ? all[all.length - 1] : yesterday;

  const series = new Map();
  for (let d = all[0]; d <= last; d = addDays(d, 1)) {
    const m = cov.MODIS.has(d) ? (counts.get(d + '|MODIS') || 0) : null;
    const v = cov.VIIRS.has(d) ? (counts.get(d + '|VIIRS') || 0) : null;
    const parts = [];
    if (m !== null) parts.push(m);
    if (v !== null) parts.push(v * factor);
    const value = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    series.set(d, { d, v: value === null ? null : Math.round(value * 10) / 10, m, vi: v });
  }
  return { series, factor, from: all[0], last };
}

// ---------- anomaly: same time of year, other years (+-7 days) ----------
function anomaly(series, date, value) {
  if (value === null) return null;
  const y = Number(date.slice(0, 4)), md = date.slice(5);
  const base = [];
  const seasons = new Set();
  for (let y2 = y - 6; y2 <= y + 1; y2++) {
    if (y2 === y) continue;
    const center = `${y2}-${md}`;
    if (isNaN(new Date(center + 'T00:00:00Z'))) continue;
    for (let k = -7; k <= 7; k++) {
      const p = series.get(addDays(center, k));
      if (p && p.v !== null) { base.push(p.v); seasons.add(y2); }
    }
  }
  if (base.length < 20 || seasons.size < MIN_SEASONS) return null;
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length);
  // spread = year-to-year variation plus ordinary day-to-day counting noise (a count of N varies by about sqrt(N))
  const spread = Math.sqrt(sd * sd + Math.max(mean, 1));
  const z = (value - mean) / spread;
  return { z: Math.round(z * 10) / 10, mean: Math.round(mean * 10) / 10 };
}

// ---------- calendar for the current place ----------
router.get('/calendar', requireAuth, (req, res) => {
  // In Local mode this is ALWAYS the fixed location, whatever the URL says
  const place = resolvePlace(req);
  if (place.error) return res.status(place.status).json({ error: place.error });
  const { lat, lon } = place;
  const radius = clamp(Number(req.query.radius) || 50, 10, 300);
  const placeInfo = { name: place.name, mode: place.mode };

  const [w, s, e, n] = COVERAGE;
  if (lon < w || lon > e || lat < s || lat > n)
    return res.json({ place: placeInfo, outOfCoverage: true, days: [], years: [] });

  const built = buildSeries(lat, lon, radius);
  if (!built) return res.json({ place: placeInfo, empty: true, days: [], years: [] });

  const { series, factor, from, last } = built;
  const years = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) years.push(y);
  const year = Number(req.query.year) || years[years.length - 1];

  const days = [];
  for (const p of series.values()) {
    if (!p.d.startsWith(String(year))) continue;
    const a = anomaly(series, p.d, p.v);
    let flag = null;
    // flagged only when it is well above its spread AND at least double the usual level (plus a small margin)
    if (a && p.v >= MIN_FLAG && p.v >= 2 * a.mean + 2)
      flag = a.z >= Z_EXTREME ? 'extreme' : a.z >= Z_HIGH ? 'high' : null;
    days.push({ ...p, z: a ? a.z : null, normal: a ? a.mean : null, flag });
  }

  const known = days.filter(x => x.v !== null);
  const peak = known.reduce((b, x) => (!b || x.v > b.v ? x : b), null);
  res.json({
    place: placeInfo, year, years, radius, factor: Math.round(factor * 100) / 100, days,
    dataFrom: from, dataTo: last,
    stats: {
      total: Math.round(known.reduce((a, x) => a + x.v, 0)),
      activeDays: known.filter(x => x.v > 0).length,
      peak: peak ? { d: peak.d, v: peak.v } : null,
      unusual: days.filter(x => x.flag).length
    }
  });
});

// ---------- admin: sync and import ----------
router.get('/sync/status', requireAuth, (req, res) => res.json(F.getJob()));

router.post('/sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    await F.syncRegion(clamp(Number(req.body.years) || 3, 1, 6));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Backup: upload a FIRMS CSV that covers the whole region (sensor = MODIS or VIIRS)
router.post('/import', requireAuth, requireAdmin,
  express.text({ type: '*/*', limit: '300mb' }), (req, res) => {
    const sensor = String(req.query.sensor || '').toUpperCase();
    if (!['MODIS', 'VIIRS'].includes(sensor))
      return res.status(400).json({ error: 'Use ?sensor=MODIS or VIIRS' });
    try { res.json({ ok: true, ...F.importCsv(sensor, req.body) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

router.buildSeries = buildSeries;   // used by forecastapi.js
module.exports = router;