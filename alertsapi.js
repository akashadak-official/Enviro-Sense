const express = require('express');
const crypto = require('crypto');
const { db } = require('./db');
const { requireAuth } = require('./auth');
const { resolvePlace, nearestSensor } = require('./geo');
const Alerts = require('./services/alerts');
const Brief = require('./services/brief');
const Calls = require('./services/calls');

Alerts.init(db);                                  // creates the alert tables if they are missing

const router = express.Router();
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_GAP_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;

const getUser = id => db.prepare('SELECT id, username, email, email_verified, role FROM users WHERE id = ?').get(id);
const isAdmin = id => { const u = getUser(id); return !!u && u.role === 'admin'; };
const getPrefs = id => db.prepare('SELECT * FROM alert_prefs WHERE user_id = ?').get(id);
const hashCode = (uid, code) => crypto.createHash('sha256').update(uid + ':' + code + ':' + (process.env.JWT_SECRET || '')).digest('hex');

function ensurePrefs(uid) {
  db.prepare('INSERT OR IGNORE INTO alert_prefs (user_id, updated_at) VALUES (?, ?)').run(uid, Date.now());
  return getPrefs(uid);
}

function shape(uid) {
  const u = getUser(uid), p = getPrefs(uid) || {};
  return {
    emailVerified: !!(u && u.email_verified),
    isAdmin: !!(u && u.role === 'admin'),
    email_on: !!p.email_on,
    sms_on: !!p.sms_on,
    call_on: !!p.call_on,
    circular_on: p.circular_on !== 0,                // on unless the person switched it off
    phone: Alerts.maskPhone(p.phone),
    phone_verified: !!p.phone_verified,
    home: p.home_lat != null ? { lat: p.home_lat, lon: p.home_lon, name: p.home_name || '' } : null,
    emailKm: Alerts.EMAIL_KM, smsKm: Alerts.SMS_KM, callKm: Calls.callKm()
  };
}

router.get('/me', requireAuth, (req, res) => {
  try { res.json(shape(req.user.id)); }
  catch (e) { console.error('Alerts /me:', e); res.status(500).json({ error: 'Could not load your alert settings' }); }
});

router.post('/prefs', requireAuth, (req, res) => {
  try {
    const uid = req.user.id, b = req.body || {};
    const cur = ensurePrefs(uid), user = getUser(uid);

    let home = cur.home_lat != null ? { lat: cur.home_lat, lon: cur.home_lon, name: cur.home_name } : null;
    if (b.home) {
      const lat = Number(b.home.lat), lon = Number(b.home.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
        return res.status(400).json({ error: 'The home location is not valid' });
      home = { lat, lon, name: Brief.cleanName(b.home.name || 'My location') };
    }

    const emailOn = b.email_on === undefined ? !!cur.email_on : !!b.email_on;      // a field that is not sent keeps its value
    const smsOn = b.sms_on === undefined ? !!cur.sms_on : !!b.sms_on;
    const callOn = b.call_on === undefined ? !!cur.call_on : !!b.call_on;
    const circularOn = b.circular_on === undefined ? cur.circular_on !== 0 : !!b.circular_on;
    if ((emailOn || smsOn || callOn) && !home) return res.status(400).json({ error: 'Set your home location first, so we know which sensors are near you' });
    if (emailOn && !(user && user.email_verified)) return res.status(400).json({ error: 'Verify your email address before turning on email alerts' });
    if (smsOn && !(cur.phone && cur.phone_verified)) return res.status(400).json({ error: 'Verify your mobile number before turning on SMS alerts' });
    if (callOn && !(cur.phone && cur.phone_verified)) return res.status(400).json({ error: 'Verify your mobile number before turning on phone calls' });

    db.prepare('UPDATE alert_prefs SET email_on = ?, sms_on = ?, call_on = ?, circular_on = ?, home_lat = ?, home_lon = ?, home_name = ?, updated_at = ? WHERE user_id = ?')
      .run(emailOn ? 1 : 0, smsOn ? 1 : 0, callOn ? 1 : 0, circularOn ? 1 : 0, home ? home.lat : null, home ? home.lon : null, home ? home.name : null, Date.now(), uid);
    res.json(shape(uid));
  } catch (e) {
    console.error('Alerts /prefs:', e);
    res.status(500).json({ error: 'Could not save your alert settings' });
  }
});

// ---------- mobile number: send a code, then verify it (so nobody can enroll someone else's number) ----------
router.post('/phone/send', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const phone = Alerts.normPhone((req.body || {}).phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });

    const taken = db.prepare('SELECT user_id FROM alert_prefs WHERE phone = ? AND phone_verified = 1 AND user_id != ?').get(phone, uid);
    if (taken) return res.status(400).json({ error: 'That number is already used by another account' });

    const prev = db.prepare('SELECT sent_at FROM phone_codes WHERE user_id = ?').get(uid);
    if (prev && Date.now() - prev.sent_at < RESEND_GAP_MS)
      return res.status(429).json({ error: 'Please wait ' + Math.ceil((RESEND_GAP_MS - (Date.now() - prev.sent_at)) / 1000) + ' s before asking for another code' });

    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare(`INSERT INTO phone_codes (user_id, phone, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, ?, 0, ?)
                ON CONFLICT(user_id) DO UPDATE SET phone = excluded.phone, code_hash = excluded.code_hash,
                  expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`)
      .run(uid, phone, hashCode(uid, code), Date.now() + CODE_TTL_MS, Date.now());

    try {
      await Alerts.sendSms([phone], 'Enviro Sense verification code: ' + code + '. It is valid for 10 minutes.');
    } catch (e) {
      console.error('Verification SMS failed:', e.message, '\n  Tip: to see the code in this terminal instead, set DEMO_OUTPUT=1 in .env and restart.');
      return res.status(502).json({ error: 'The SMS could not be sent. Try again in a minute.' });
    }
    res.json({ ok: true, phone: Alerts.maskPhone(phone) });
  } catch (e) {
    console.error('Alerts /phone/send:', e);
    res.status(500).json({ error: 'Could not send the code' });
  }
});

router.post('/phone/verify', requireAuth, (req, res) => {
  try {
    const uid = req.user.id;
    const code = String((req.body || {}).code || '').trim();
    const row = db.prepare('SELECT * FROM phone_codes WHERE user_id = ?').get(uid);
    if (!row) return res.status(400).json({ error: 'Ask for a code first' });
    if (Date.now() > row.expires_at) { db.prepare('DELETE FROM phone_codes WHERE user_id = ?').run(uid); return res.status(400).json({ error: 'The code expired. Ask for a new one' }); }
    if (row.attempts >= MAX_ATTEMPTS) { db.prepare('DELETE FROM phone_codes WHERE user_id = ?').run(uid); return res.status(429).json({ error: 'Too many wrong tries. Ask for a new code' }); }

    const ok = /^\d{6}$/.test(code) &&
      crypto.timingSafeEqual(Buffer.from(hashCode(uid, code)), Buffer.from(row.code_hash));
    if (!ok) {
      db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE user_id = ?').run(uid);
      return res.status(400).json({ error: 'That code is not right' });
    }

    ensurePrefs(uid);
    db.prepare('UPDATE alert_prefs SET phone = ?, phone_verified = 1, updated_at = ? WHERE user_id = ?').run(row.phone, Date.now(), uid);
    db.prepare('DELETE FROM phone_codes WHERE user_id = ?').run(uid);
    res.json(shape(uid));
  } catch (e) {
    console.error('Alerts /phone/verify:', e);
    res.status(500).json({ error: 'Could not verify the number' });
  }
});

router.post('/phone/remove', requireAuth, (req, res) => {
  try {
    const uid = req.user.id;
    ensurePrefs(uid);
    db.prepare('UPDATE alert_prefs SET phone = NULL, phone_verified = 0, sms_on = 0, call_on = 0, updated_at = ? WHERE user_id = ?').run(Date.now(), uid);
    db.prepare('DELETE FROM phone_codes WHERE user_id = ?').run(uid);
    res.json(shape(uid));
  } catch (e) {
    console.error('Alerts /phone/remove:', e);
    res.status(500).json({ error: 'Could not remove the number' });
  }
});

// ---------- the dashboard banner: is there an open incident at the sensor for this place? ----------
router.get('/active', requireAuth, (req, res) => {
  try {
    const p = resolvePlace(req);
    if (p.error) return res.status(p.status).json({ error: p.error });
    const s = nearestSensor(p.lat, p.lon);
    res.json({ incident: s ? Alerts.activeIncident(s.device_id) : null });
  } catch (e) {
    console.error('Alerts /active:', e);
    res.status(500).json({ error: 'Could not check alerts' });
  }
});

// ---------- admin ----------
router.get('/events', requireAuth, (req, res) => {
  try {
    if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Admins only' });
    res.json({ events: Alerts.recent(50) });
  } catch (e) {
    console.error('Alerts /events:', e);
    res.status(500).json({ error: 'Could not load the alert history' });
  }
});

router.post('/test', requireAuth, async (req, res) => {
  try {
    if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Admins only' });
    const p = resolvePlace(req);
    const s = p.error ? null : nearestSensor(p.lat, p.lon);
    if (!s) return res.status(404).json({ error: 'No sensor is registered near this place' });
    res.json(await Alerts.sendTest(s));
  } catch (e) {
    console.error('Alerts /test:', e);
    res.status(500).json({ error: 'The test alert failed' });
  }
});

module.exports = router;
