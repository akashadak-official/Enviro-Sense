const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { requireAuth, makeToken, setCookie } = require('./auth');
const Demo = require('./services/demo');
const Virtual = require('./services/virtual');

const router = express.Router();
const MAX_GUESTS = 300;

router.get('/config', (req, res) => {
  res.json({ demo: Demo.enabled(), virtualSensor: Demo.enabled() && Demo.virtualSensor() });
});

// One click, no email: a throw-away account that is deleted after a day
router.post('/guest', (req, res) => {
  if (!Demo.enabled()) return res.status(404).json({ error: 'Guest login is not available' });
  try {
    const n = db.prepare("SELECT COUNT(*) c FROM users WHERE username LIKE 'guest-%'").get().c;
    if (n >= MAX_GUESTS) { Demo.purgeOldGuests(); }
    if (n >= MAX_GUESTS && db.prepare("SELECT COUNT(*) c FROM users WHERE username LIKE 'guest-%'").get().c >= MAX_GUESTS)
      return res.status(503).json({ error: 'Too many guest sessions right now. Please try again later.' });

    const { mode, location } = req.body || {};
    const username = 'guest-' + crypto.randomBytes(3).toString('hex');
    const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 4);
    const info = db.prepare('INSERT INTO users (username, password_hash, role, email_verified) VALUES (?, ?, ?, 1)')
      .run(username, hash, 'user');
    const user = { id: Number(info.lastInsertRowid), username, role: 'user' };

    db.prepare('INSERT INTO login_history (user_id, mode, location) VALUES (?, ?, ?)')
      .run(user.id, mode === 'local' || mode === 'global' ? mode : null, location ? String(location).slice(0, 60) : null);
    setCookie(res, makeToken(user));
    res.json({ ok: true, user: { username, role: 'user' } });
  } catch (e) {
    console.error('Guest login:', e);
    res.status(500).json({ error: 'Could not start a guest session' });
  }
});

// Start a simulated event on the virtual sensor
router.post('/trigger', requireAuth, (req, res) => {
  if (!(Demo.enabled() && Demo.virtualSensor()))
    return res.status(400).json({ error: 'The simulated sensor is not turned on on this server' });
  const out = Virtual.trigger(String((req.body || {}).kind || ''), { force: req.user.role === 'admin' });
  res.status(out.ok ? 200 : out.wait ? 429 : 400).json(out);
});

module.exports = router;
