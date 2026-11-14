const express = require('express');
const jwt = require('jsonwebtoken');
const { db } = require('./db');
const { requireAuth, requireAdmin } = require('./auth');
const { COVERAGE } = require('./services/firms');
const cookies = require('./services/cookies');

const router = express.Router();

// The fixed location used in Local mode (override in .env if you like)
const LOCAL = {
  name: process.env.LOCAL_NAME || 'Haldia',
  lat: Number(process.env.LOCAL_LAT) || 22.0667,
  lon: Number(process.env.LOCAL_LON) || 88.0698
};

// Shortcuts, also used as an offline fallback if the geocoder is unreachable
const PRESETS = [
  { name: 'Haldia',      admin1: 'West Bengal',  country: 'India', lat: 22.0667, lon: 88.0698, radius: 50 },
  { name: 'Kolkata',     admin1: 'West Bengal',  country: 'India', lat: 22.5726, lon: 88.3639, radius: 50 },
  { name: 'Durgapur',    admin1: 'West Bengal',  country: 'India', lat: 23.5204, lon: 87.3119, radius: 50 },
  { name: 'Bhubaneswar', admin1: 'Odisha',       country: 'India', lat: 20.2961, lon: 85.8245, radius: 50 },
  { name: 'Mumbai',      admin1: 'Maharashtra',  country: 'India', lat: 19.0760, lon: 72.8777, radius: 50 },
  { name: 'Delhi',       admin1: 'Delhi',        country: 'India', lat: 28.6139, lon: 77.2090, radius: 50 },
  { name: 'Ludhiana',    admin1: 'Punjab',       country: 'India', lat: 30.9010, lon: 75.8573, radius: 100 },
  { name: 'Raipur',      admin1: 'Chhattisgarh', country: 'India', lat: 21.2514, lon: 81.6296, radius: 100 },
  { name: 'Chennai',     admin1: 'Tamil Nadu',   country: 'India', lat: 13.0827, lon: 80.2707, radius: 50 },
  { name: 'Bengaluru',   admin1: 'Karnataka',    country: 'India', lat: 12.9716, lon: 77.5946, radius: 50 },
  { name: 'Hyderabad',   admin1: 'Telangana',    country: 'India', lat: 17.3850, lon: 78.4867, radius: 50 },
  { name: 'Guwahati',    admin1: 'Assam',        country: 'India', lat: 26.1445, lon: 91.7362, radius: 50 }
];

db.exec(`
  CREATE TABLE IF NOT EXISTS sensors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT UNIQUE NOT NULL,
    label TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS view_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mode TEXT,
    place TEXT,
    lat REAL,
    lon REAL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_view_user ON view_history (user_id, ts);
`);

// Seed the Haldia sensor (your Raspberry Pi) on first run
if (!db.prepare('SELECT 1 FROM sensors LIMIT 1').get()) {
  db.prepare('INSERT INTO sensors (device_id, label, lat, lon, ip) VALUES (?, ?, ?, ?, ?)')
    .run('haldia-01', 'Haldia sensor', LOCAL.lat, LOCAL.lon, '192.168.137.40');
}

// ---------- helpers ----------
const inCoverage = (lat, lon) =>
  lon >= COVERAGE[0] && lat >= COVERAGE[1] && lon <= COVERAGE[2] && lat <= COVERAGE[3];

function getMode(req) {
  const t = req.cookies && req.cookies.es_mode;
  if (!t) return null;
  try {
    const m = jwt.verify(t, process.env.JWT_SECRET).mode;
    return m === 'local' || m === 'global' ? m : null;
  } catch { return null; }
}

function hasSession(req) {
  const t = req.cookies && req.cookies.es_token;
  if (!t) return false;
  try { jwt.verify(t, process.env.JWT_SECRET); return true; } catch { return false; }
}

// The ONE place that decides which location a request is about.
// Local mode: always the fixed location, whatever the browser sends.
function resolvePlace(req) {
  const mode = getMode(req);
  if (!mode) return { error: 'Choose Local or Global mode first', status: 409 };
  if (mode === 'local') return { mode, name: LOCAL.name, lat: LOCAL.lat, lon: LOCAL.lon };

  const src = req.method === 'GET' ? req.query : (req.body || {});
  const lat = Number(src.lat), lon = Number(src.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return { error: 'Valid lat and lon are required', status: 400 };
  return { mode, name: String(src.name || 'Selected place').slice(0, 80), lat, lon };
}

function km(aLat, aLon, bLat, bLon) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestSensor(lat, lon, maxKm = 50) {
  let best = null;
  for (const s of db.prepare('SELECT * FROM sensors').all()) {
    const d = km(lat, lon, s.lat, s.lon);
    if (d <= maxKm && (!best || d < best.distanceKm)) best = { ...s, distanceKm: Math.round(d * 10) / 10 };
  }
  return best;
}

function sensorStatus(s) {
  const r = db.prepare('SELECT * FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1').get(s.device_id);
  const age = r ? Math.round((Date.now() - r.ts) / 1000) : null;
  return {
    id: s.id, device_id: s.device_id, label: s.label, ip: s.ip,
    lat: s.lat, lon: s.lon, distanceKm: s.distanceKm,
    online: age !== null && age <= 30,
    ageSeconds: age,
    reading: r ? { temperature: r.temperature, humidity: r.humidity, smoke: r.smoke,
                   cpu_temp: r.cpu_temp, status: r.status } : null
  };
}

// ---------- mode (set before login) ----------
router.post('/mode', (req, res) => {
  const mode = req.body && req.body.mode;
  if (mode !== 'local' && mode !== 'global') return res.status(400).json({ error: 'Invalid mode' });

  const current = getMode(req);
  if (hasSession(req) && current && current !== mode)
    return res.status(409).json({ error: 'You are logged in. Log out first to change the mode.' });

  const token = jwt.sign({ mode }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.cookie('es_mode', token, cookies.options(12 * 60 * 60 * 1000));
  res.json({ ok: true, mode });
});

// Logs out and forgets the mode, so the next login can choose again
router.post('/logout', (req, res) => {
  res.clearCookie('es_token');
  res.clearCookie('es_mode');
  res.json({ ok: true });
});

router.get('/config', requireAuth, (req, res) => {
  const mode = getMode(req);
  res.json({
    mode,
    local: mode === 'local' ? LOCAL : null,
    presets: mode === 'global' ? PRESETS : [],
    coverage: COVERAGE
  });
});

// ---------- city search (Global mode only) ----------
const cache = new Map();   // query -> { t, data }

router.get('/search', requireAuth, async (req, res) => {
  if (getMode(req) !== 'global')
    return res.status(403).json({ error: 'Search is available in Global mode only' });

  const q = String(req.query.q || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (q.length < 2) return res.json({ results: [] });

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return res.json({ results: hit.data });

  let results, offline = false;
  try {
    const name = q.split(',')[0].trim();
    const url = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name) +
                '&count=8&language=en&format=json';
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    results = (data.results || []).map(x => ({
      name: x.name, admin1: x.admin1 || '', country: x.country || '',
      lat: x.latitude, lon: x.longitude, population: x.population || 0
    }));
  } catch (e) {
    offline = true;
    results = PRESETS.filter(p => p.name.toLowerCase().includes(key.split(',')[0].trim()))
      .map(p => ({ name: p.name, admin1: p.admin1, country: p.country, lat: p.lat, lon: p.lon, population: 0 }));
  }

  results = results.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon))
                   .map(r => ({ ...r, covered: inCoverage(r.lat, r.lon) }));

  if (!offline) {
    if (cache.size > 200) cache.clear();
    cache.set(key, { t: Date.now(), data: results });
  }
  res.json({ results, offline });
});

// ---------- the user picked a place (logged for the history page) ----------
router.post('/select', requireAuth, (req, res) => {
  const p = resolvePlace(req);
  if (p.error) return res.status(p.status).json({ error: p.error });
  db.prepare('INSERT INTO view_history (user_id, mode, place, lat, lon, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, p.mode, p.name, p.lat, p.lon, Date.now());
  res.json({ ok: true, place: { name: p.name, lat: p.lat, lon: p.lon } });
});

// ---------- the sensor for the current place ----------
router.get('/sensor', requireAuth, (req, res) => {
  const p = resolvePlace(req);
  if (p.error) return res.status(p.status).json({ error: p.error });
  const s = nearestSensor(p.lat, p.lon);
  res.json({ sensor: s ? sensorStatus(s) : null });
});

// ---------- admin: sensor registry ----------
const okIp = ip => !ip || (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split('.').every(n => Number(n) <= 255));

router.get('/sensors', requireAuth, requireAdmin, (req, res) => {
  res.json({ sensors: db.prepare('SELECT * FROM sensors ORDER BY id').all().map(sensorStatus) });
});

router.post('/sensors', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const device_id = String(b.device_id || '').trim();
  const ip = String(b.ip || '').trim();
  const label = String(b.label || '').trim().slice(0, 60);
  const lat = Number(b.lat), lon = Number(b.lon);

  if (!/^[A-Za-z0-9_-]{2,40}$/.test(device_id))
    return res.status(400).json({ error: 'Device ID: 2 to 40 letters, digits, - or _' });
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return res.status(400).json({ error: 'Pick a place first' });
  if (!okIp(ip)) return res.status(400).json({ error: 'Enter a valid IPv4 address' });

  db.prepare(`INSERT INTO sensors (device_id, label, lat, lon, ip) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(device_id) DO UPDATE SET label = excluded.label, lat = excluded.lat,
              lon = excluded.lon, ip = excluded.ip`)
    .run(device_id, label, lat, lon, ip || null);
  res.json({ ok: true });
});

router.delete('/sensors/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM sensors WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = { router, resolvePlace, nearestSensor };