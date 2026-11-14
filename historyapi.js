const express = require('express');
const { db } = require('./db');
const { requireAuth } = require('./auth');
const { toMs } = require('./services/util');

const router = express.Router();
const clean = s => String(s == null ? '' : s).slice(0, 80);

// My own history: places I looked at and my logins
router.get('/me', requireAuth, (req, res) => {
  try {
    const uid = req.user.id;
    const views = db.prepare('SELECT id, mode, place, lat, lon, ts FROM view_history WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(uid)
      .map(v => ({ id: v.id, mode: v.mode, place: clean(v.place), lat: v.lat, lon: v.lon, ts: toMs(v.ts) }));
    const logins = db.prepare('SELECT mode, location, logged_at FROM login_history WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(uid)
      .map(l => ({ mode: l.mode, location: clean(l.location), ts: toMs(l.logged_at) }));
    const total = db.prepare('SELECT COUNT(*) c FROM view_history WHERE user_id = ?').get(uid).c;
    const user = db.prepare('SELECT username, email, role FROM users WHERE id = ?').get(uid) || {};
    res.json({ user: { username: user.username, email: user.email, role: user.role }, views, logins, totalViews: total });
  } catch (e) {
    console.error('History /me:', e);
    res.status(500).json({ error: 'Could not load your history' });
  }
});

router.post('/clear', requireAuth, (req, res) => {
  try {
    const r = db.prepare('DELETE FROM view_history WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true, removed: Number(r.changes) });
  } catch (e) {
    console.error('History /clear:', e);
    res.status(500).json({ error: 'Could not clear your history' });
  }
});

module.exports = router;
