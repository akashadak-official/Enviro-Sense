const express = require('express');
const { db } = require('./db');
const { requireAuth } = require('./auth');
const { resolvePlace, nearestSensor } = require('./geo');
const fire = require('./fire');
const F = require('./services/firms');
const Risk = require('./services/riskmodel');
const Warn = require('./services/earlywarn');
const Brief = require('./services/brief');

const router = express.Router();
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Same place rules as the calendar: in Local mode the location is always the fixed one
function getPlace(req, res) {
  const p = resolvePlace(req);
  if (p.error) { res.status(p.status).json({ error: p.error }); return null; }
  const [w, s, e, n] = F.COVERAGE;
  p.covered = p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;
  const src = req.method === 'GET' ? req.query : (req.body || {});
  p.radius = clamp(Number(src.radius) || 50, 10, 300);
  p.name = Brief.cleanName(p.name);
  return p;
}

// ---------- satellite outlook (cached for a few minutes) ----------
const cache = new Map();
function getOutlook(lat, lon, radius) {
  const key = lat.toFixed(2) + '|' + lon.toFixed(2) + '|' + radius;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.data;

  const built = fire.buildSeries(lat, lon, radius);
  const data = built ? Risk.buildOutlook(built.series, built.last) : { empty: true };

  if (!F.getJob().running) {                      // do not cache while a NASA download is changing the data
    if (cache.size > 100) cache.clear();
    cache.set(key, { t: Date.now(), data });
  }
  return data;
}

// ---------- sensor early warning ----------
function sensorWarning(p) {
  const s = nearestSensor(p.lat, p.lon);
  if (!s) return null;
  const rows = db.prepare(
    'SELECT ts, temperature, humidity, smoke, status FROM readings WHERE device_id = ? AND ts >= ? ORDER BY ts ASC'
  ).all(s.device_id, Date.now() - 120000);
  return { device_id: s.device_id, label: s.label || s.device_id, ...Warn.assess(rows) };
}

router.get('/outlook', requireAuth, (req, res) => {
  try {
    const p = getPlace(req, res); if (!p) return;
    const base = { place: { name: p.name, mode: p.mode }, radius: p.radius, aiAvailable: Brief.aiAvailable(), aiLabel: Brief.aiLabel() };
    if (!p.covered) return res.json({ ...base, outOfCoverage: true });
    res.json({ ...base, ...getOutlook(p.lat, p.lon, p.radius) });
  } catch (e) {
    console.error('Outlook error:', e);
    res.status(500).json({ error: 'Could not build the outlook' });
  }
});

router.get('/sensor', requireAuth, (req, res) => {
  try {
    const p = getPlace(req, res); if (!p) return;
    res.json({ warning: sensorWarning(p) });
  } catch (e) {
    console.error('Early warning error:', e);
    res.status(500).json({ error: 'Could not read the sensor' });
  }
});

// ---------- briefing: offline always, the AI writer on request ----------
const lastAi = new Map();      // user id -> time of the last AI request
const AI_GAP_MS = 20000;

router.post('/brief', requireAuth, async (req, res) => {
  try {
    const p = getPlace(req, res); if (!p) return;
    const wantAi = !!(req.body && req.body.ai);

    const outlook = p.covered ? getOutlook(p.lat, p.lon, p.radius) : { outOfCoverage: true };
    const facts = Brief.makeFacts(p.name, p.radius, outlook, sensorWarning(p));
    const offline = Brief.offlineText(facts);

    if (!wantAi) return res.json({ text: offline, source: 'offline' });
    const label = Brief.aiLabel();
    if (!Brief.aiAvailable())
      return res.json({ text: offline, source: 'offline', note: 'The AI writer is not set up on the server. Showing the offline briefing.' });

    const hit = Brief.cached(facts);
    if (hit) return res.json({ text: hit.text, source: 'ai', label: hit.label, model: hit.model, cached: true });

    const wait = AI_GAP_MS - (Date.now() - (lastAi.get(req.user.id) || 0));
    if (wait > 0) return res.status(429).json({ error: `Please wait ${Math.ceil(wait / 1000)} s before asking again` });
    lastAi.set(req.user.id, Date.now());

    try {
      const out = await Brief.aiText(facts, offline);
      res.json({ text: out.text, source: 'ai', label: out.label, model: out.model, note: out.note });
    } catch (e) {
      console.error('AI briefing failed:', e.message);
      res.json({ text: offline, source: 'offline', note: e.userMessage || `${label} could not be reached. Showing the offline briefing.` });
    }
  } catch (e) {
    console.error('Briefing error:', e);
    res.status(500).json({ error: 'Could not build the briefing' });
  }
});

module.exports = router;
