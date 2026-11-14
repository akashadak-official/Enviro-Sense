const express = require('express');
const { db } = require('./db');
const { requireAuth, requireAdmin } = require('./auth');
const { toMs } = require('./services/util');
const Alerts = require('./services/alerts');
const Brief = require('./services/brief');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const clean = s => String(s == null ? '' : s).slice(0, 80);
const lim = (v, d) => Math.min(Math.max(parseInt(v, 10) || d, 1), 500);
const one = (sql, ...p) => db.prepare(sql).get(...p);

// the big satellite table is only counted every few minutes
let fireCache = { t: 0, rows: null, last: null };
function fireStats() {
  if (Date.now() - fireCache.t < 10 * 60 * 1000) return fireCache;
  let rows = null, last = null;
  try { rows = one('SELECT COUNT(*) c FROM fire_cells').c; last = one('SELECT MAX(date) d FROM fire_cells').d; } catch (e) { /* table missing */ }
  fireCache = { t: Date.now(), rows, last };
  return fireCache;
}

router.get('/overview', (req, res) => {
  try {
    const now = Date.now();
    const sensors = db.prepare('SELECT device_id, label, lat, lon, ip FROM sensors').all().map(s => {
      const r = one('SELECT ts, temperature, humidity, smoke, status FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1', s.device_id);
      const ts = r ? toMs(r.ts) : null;
      return {
        device_id: s.device_id, label: clean(s.label), lat: s.lat, lon: s.lon, ip: clean(s.ip),
        last: r ? { ts, temperature: r.temperature, humidity: r.humidity, smoke: r.smoke, status: r.status } : null,
        online: ts !== null && now - ts < 30000,
        incident: Alerts.activeIncident(s.device_id) ? true : false
      };
    });

    const recentLogins = db.prepare('SELECT logged_at FROM login_history ORDER BY id DESC LIMIT 1000').all().map(l => toMs(l.logged_at));
    const fire = fireStats();
    res.json({
      users: one('SELECT COUNT(*) c FROM users').c,
      verified: one('SELECT COUNT(*) c FROM users WHERE email_verified = 1').c,
      admins: one("SELECT COUNT(*) c FROM users WHERE role = 'admin'").c,
      logins24h: recentLogins.filter(t => t && now - t < 24 * 3600 * 1000).length,
      views: one('SELECT COUNT(*) c FROM view_history').c,
      alerts: one("SELECT COUNT(*) c FROM alert_events WHERE kind = 'ALERT'").c,
      sensors,
      satellite: { rows: fire.rows, lastDate: fire.last },
      ai: Brief.statusLine(),
      calls: require('./services/voice').statusLine()
    });
  } catch (e) {
    console.error('Admin /overview:', e);
    res.status(500).json({ error: 'Could not load the overview' });
  }
});

router.get('/users', (req, res) => {
  try {
    const logins = new Map(db.prepare('SELECT user_id, MAX(logged_at) m, COUNT(*) n FROM login_history GROUP BY user_id').all().map(r => [r.user_id, r]));
    const views = new Map(db.prepare('SELECT user_id, COUNT(*) n FROM view_history GROUP BY user_id').all().map(r => [r.user_id, r.n]));
    const prefs = new Map(db.prepare('SELECT user_id, email_on, sms_on, phone_verified FROM alert_prefs').all().map(r => [r.user_id, r]));
    const users = db.prepare('SELECT id, username, email, phone, role, email_verified, created_at FROM users ORDER BY id').all().map(u => {
      const l = logins.get(u.id) || {}, p = prefs.get(u.id) || {};
      return {
        id: u.id, username: clean(u.username), email: clean(u.email), role: u.role,
        emailVerified: !!u.email_verified, created: toMs(u.created_at),
        lastLogin: toMs(l.m), logins: l.n || 0, views: views.get(u.id) || 0,
        alerts: { email: !!p.email_on, sms: !!p.sms_on }
      };
    });
    res.json({ users });
  } catch (e) {
    console.error('Admin /users:', e);
    res.status(500).json({ error: 'Could not load the users' });
  }
});

router.get('/logins', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT l.id, l.mode, l.location, l.logged_at, u.username FROM login_history l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?'
    ).all(lim(req.query.limit, 100));
    res.json({ logins: rows.map(r => ({ id: r.id, user: clean(r.username || '(deleted)'), mode: r.mode, location: clean(r.location), ts: toMs(r.logged_at) })) });
  } catch (e) {
    console.error('Admin /logins:', e);
    res.status(500).json({ error: 'Could not load the logins' });
  }
});

router.get('/views', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT v.id, v.mode, v.place, v.lat, v.lon, v.ts, u.username FROM view_history v LEFT JOIN users u ON u.id = v.user_id ORDER BY v.id DESC LIMIT ?'
    ).all(lim(req.query.limit, 100));
    res.json({ views: rows.map(r => ({ id: r.id, user: clean(r.username || '(deleted)'), mode: r.mode, place: clean(r.place), lat: r.lat, lon: r.lon, ts: toMs(r.ts) })) });
  } catch (e) {
    console.error('Admin /views:', e);
    res.status(500).json({ error: 'Could not load the place history' });
  }
});

// Remove a normal user and the data tied to them. Admins and your own account are protected.
router.post('/users/delete', (req, res) => {
  try {
    const id = Number((req.body || {}).id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Which user?' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    const u = one('SELECT id, role FROM users WHERE id = ?', id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be deleted here' });

    for (const t of ['login_history', 'view_history', 'alert_prefs', 'phone_codes', 'otps']) {
      try { db.prepare('DELETE FROM ' + t + ' WHERE user_id = ?').run(id); } catch (e) { /* table or column not present */ }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('Admin /users/delete:', e);
    res.status(500).json({ error: 'Could not delete that user' });
  }
});

module.exports = router;
