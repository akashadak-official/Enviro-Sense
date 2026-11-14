const express = require('express');
const crypto = require('crypto');
const { db } = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    location TEXT,
    temperature REAL,
    humidity REAL,
    smoke REAL,
    cpu_temp REAL,
    status TEXT NOT NULL DEFAULT 'NORMAL',
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_dev_ts ON readings (device_id, ts);
`);

// Simple rule-based status (the AI forecast comes in Step 10)
function classify({ temperature, humidity, smoke }) {
  if (smoke >= 600 || temperature >= 55) return 'FIRE';
  if (smoke >= 300 || temperature >= 42 || (temperature >= 35 && humidity <= 25)) return 'WARNING';
  return 'NORMAL';
}

// Constant-time check of the device key
function requireDevice(req, res, next) {
  const given = Buffer.from(String(req.get('x-device-key') || ''));
  const real = Buffer.from(String(process.env.DEVICE_KEY || ''));
  if (!real.length || given.length !== real.length || !crypto.timingSafeEqual(given, real))
    return res.status(401).json({ error: 'Invalid device key' });
  next();
}

const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// ---------- Pi sends a reading ----------
router.post('/readings', requireDevice, (req, res) => {
  const { device_id, location, temperature, humidity, smoke, cpu_temp } = req.body;

  if (!device_id || typeof device_id !== 'string' || device_id.length > 40)
    return res.status(400).json({ error: 'device_id is required' });
  if (!inRange(temperature, -40, 120) || !inRange(humidity, 0, 100) ||
      !inRange(smoke, 0, 10000) || !inRange(cpu_temp, 0, 120))
    return res.status(400).json({ error: 'A sensor value is missing or out of range' });

  const status = classify({ temperature, humidity, smoke });
  db.prepare(`
    INSERT INTO readings (device_id, location, temperature, humidity, smoke, cpu_temp, status, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(device_id, String(location || '').slice(0, 60), temperature, humidity, smoke, cpu_temp, status, Date.now());

  res.json({ ok: true, status });
});

// ---------- Dashboard reads (login required) ----------
router.get('/latest', requireAuth, (req, res) => {
  const device = req.query.device;
  const row = device
    ? db.prepare('SELECT * FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1').get(device)
    : db.prepare('SELECT * FROM readings ORDER BY ts DESC LIMIT 1').get();
  if (!row) return res.json({ reading: null });
  res.json({ reading: row, ageSeconds: Math.round((Date.now() - row.ts) / 1000) });
});

router.get('/history', requireAuth, (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720);
  const since = Date.now() - hours * 3600 * 1000;
  const device = req.query.device;
  const rows = device
    ? db.prepare('SELECT * FROM readings WHERE device_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 2000').all(device, since)
    : db.prepare('SELECT * FROM readings WHERE ts >= ? ORDER BY ts ASC LIMIT 2000').all(since);
  res.json({ count: rows.length, readings: rows });
});

module.exports = router;