const express = require('express');
const { db } = require('./db');
const { requireAuth } = require('./auth');
const { limiter } = require('./services/ratelimit');
const { safeEqual } = require('./services/util');
const Calls = require('./services/calls');
const Voice = require('./services/voice');

// Fire-call API.
//   POST /api/calls/fire    { "device_id": "haldia-01", "level": "FIRE" }   level = ALERT | WARNING | FIRE (default FIRE)
//        Header  x-device-key: <DEVICE_KEY>   (the same key the Raspberry Pi uses)   OR   a logged-in admin session.
//        Phones the admin and every verified subscriber within CALL_KM of that sensor who switched calls on.
//        429 + Retry-After when that sensor already called recently at the same or a higher level.
//   POST /api/calls/test    admin only, calls the admin phone and nobody else
//   GET  /api/calls/status  admin only
//   GET  /api/calls/log     admin only
// Nothing in the request body is ever read aloud: the spoken text is built by the server from the level and the sensor name.
const router = express.Router();

const getSensor = id => db.prepare('SELECT device_id, label, lat, lon FROM sensors WHERE device_id = ?').get(String(id || '').trim());

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// The device key (for machines) or an admin login (for people)
function deviceOrAdmin(req, res, next) {
  if (req.get('x-device-key')) {
    if (!safeEqual(req.get('x-device-key'), process.env.DEVICE_KEY)) return res.status(401).json({ error: 'Invalid device key' });
    req.via = 'device';
    return next();
  }
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    req.via = 'admin';
    next();
  });
}

// Every call can cost money and wake somebody up at night, so even a valid key is limited
router.post('/fire', limiter({ windowMs: 10 * 60 * 1000, max: 20 }), deviceOrAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const sensor = getSensor(b.device_id);
    if (!sensor) return res.status(404).json({ error: 'Unknown device_id' });
    const level = String(b.level || 'FIRE').toUpperCase();
    if (!Calls.LEVELS.includes(level)) return res.status(400).json({ error: 'level must be ALERT, WARNING or FIRE' });

    const r = await Calls.fireCall(sensor, level, {
      source: req.via === 'admin' ? 'admin' : 'api',
      force: req.via === 'admin' && b.force === true          // only a logged-in admin may skip the cooldown
    });
    if (r.skipped && r.reason === 'cooldown') {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: 'A call for this sensor already went out recently', ...r });
    }
    res.json(r);
  } catch (e) {
    console.error('Calls /fire:', e);
    res.status(500).json({ error: 'The fire call failed' });
  }
});

router.post('/test', requireAuth, adminOnly, async (req, res) => {
  try {
    const id = (req.body || {}).device_id;
    const sensor = id ? getSensor(id) : db.prepare('SELECT device_id, label, lat, lon FROM sensors ORDER BY id LIMIT 1').get();
    if (!sensor) return res.status(404).json({ error: 'No sensor is registered' });
    res.json(await Calls.testCall(sensor));
  } catch (e) {
    console.error('Calls /test:', e);
    res.status(500).json({ error: 'The test call failed' });
  }
});

router.get('/status', requireAuth, adminOnly, (req, res) => {
  res.json({
    provider: Voice.provider(), line: Voice.statusLine(),
    auto: Calls.autoOn(), minLevel: Calls.minLevel(), radiusKm: Calls.callKm()
  });
});

router.get('/log', requireAuth, adminOnly, (req, res) => {
  try { res.json({ calls: Calls.recent(50) }); }
  catch (e) { console.error('Calls /log:', e); res.status(500).json({ error: 'Could not load the call log' }); }
});

module.exports = router;
