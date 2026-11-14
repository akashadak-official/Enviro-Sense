const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('./db');
const { sendEmailOtp } = require('./services/mailer');
const { sendSmsOtp } = require('./services/sms');
const cookies = require('./services/cookies');

const DEMO = () => process.env.DEMO_MODE === '1';       // online demo: no email codes, no password reset

const router = express.Router();

const OTP_TTL_MS = 10 * 60 * 1000;   // code valid for 10 minutes
const RESEND_GAP_MS = 30 * 1000;     // wait 30 s between codes
const MAX_ATTEMPTS = 5;

const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');

// ---------- helpers ----------
function makeToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function setCookie(res, token) {
  res.cookie('es_token', token, cookies.options(12 * 60 * 60 * 1000));
}

// Returns a new code, or null if requested too soon
function issueOtp(userId, purpose) {
  const last = db.prepare(
    'SELECT created_at FROM otps WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1'
  ).get(userId, purpose);
  if (last && Date.now() - last.created_at < RESEND_GAP_MS) return null;

  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare('DELETE FROM otps WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare(
    'INSERT INTO otps (user_id, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, purpose, sha(code), Date.now() + OTP_TTL_MS, Date.now());
  return code;
}

function checkOtp(userId, purpose, code) {
  const row = db.prepare('SELECT * FROM otps WHERE user_id = ? AND purpose = ?').get(userId, purpose);
  if (!row) return false;
  if (row.expires_at < Date.now() || row.attempts >= MAX_ATTEMPTS) {
    db.prepare('DELETE FROM otps WHERE id = ?').run(row.id);
    return false;
  }
  if (sha(String(code).trim()) !== row.code_hash) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return false;
  }
  db.prepare('DELETE FROM otps WHERE id = ?').run(row.id);
  return true;
}

// ---------- middleware ----------
function requireAuth(req, res, next) {
  const token = req.cookies.es_token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ---------- SIGNUP ----------
router.post('/signup', async (req, res) => {
  const { username, email, phone, password } = req.body;

  if (!username || !email || !password)
    return res.status(400).json({ error: 'Username, email and password are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 100)
    return res.status(400).json({ error: 'Enter a valid email address' });
  if (!/^[\w.\-]{3,30}$/.test(username))
    return res.status(400).json({ error: 'Username: 3 to 30 letters, digits, dot, dash or underscore' });
  if (/^guest-/i.test(username))
    return res.status(400).json({ error: 'That username is reserved. Please choose another' });

  const matches = db.prepare(
    'SELECT id, email_verified FROM users WHERE username = ? OR email = ?'
  ).all(username, email);

  if (matches.some(u => u.email_verified))
    return res.status(409).json({ error: 'Username or email already in use' });

  // Old unverified attempts (for example a typo in the email) are replaced
  for (const u of matches) {
    db.prepare('DELETE FROM otps WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, email, phone, password_hash) VALUES (?, ?, ?, ?)'
  ).run(username, email, phone || null, hash);

  if (DEMO()) {                                   // online demo: no email is sent, the account works straight away
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(info.lastInsertRowid);
    const created = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    setCookie(res, makeToken(created));
    return res.json({ ok: true, demoVerified: true, user: { username: created.username, role: created.role } });
  }

  const code = issueOtp(info.lastInsertRowid, 'verify');
  try {
    await sendEmailOtp(email, code, 'verify');
  } catch (e) {
    console.error('Email error:', e.message);
    return res.status(500).json({ error: 'Account created but the email could not be sent. Try "Resend code".', needsVerification: true, email });
  }
  res.json({ ok: true, needsVerification: true, email });
});

// ---------- VERIFY EMAIL ----------
router.post('/verify-email', (req, res) => {
  const { email, code } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  if (!user || !checkOtp(user.id, 'verify', code))
    return res.status(400).json({ error: 'Invalid or expired code' });

  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
  setCookie(res, makeToken(user));
  res.json({ ok: true, user: { username: user.username, role: user.role } });
});

router.post('/resend-email', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND email_verified = 0')
                 .get(req.body.email || '');
  if (user) {
    const code = issueOtp(user.id, 'verify');
    if (!code) return res.status(429).json({ error: 'Please wait 30 seconds before asking for a new code' });
    try { await sendEmailOtp(user.email, code, 'verify'); }
    catch (e) { console.error('Email error:', e.message); }
  }
  res.json({ ok: true });
});

// ---------- LOGIN ----------
router.post('/login', async (req, res) => {
  const { username, password, mode, location } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Enter username and password' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Wrong username or password' });

  if (user.role !== 'admin' && !user.email_verified && !DEMO()) {
    const code = issueOtp(user.id, 'verify');
    if (code) {
      try { await sendEmailOtp(user.email, code, 'verify'); }
      catch (e) { console.error('Email error:', e.message); }
    }
    return res.status(403).json({ error: 'Please verify your email first', needsVerification: true, email: user.email });
  }

  db.prepare('INSERT INTO login_history (user_id, mode, location) VALUES (?, ?, ?)')
    .run(user.id, mode || null, location || null);

  setCookie(res, makeToken(user));
  res.json({ ok: true, user: { username: user.username, role: user.role } });
});

// ---------- FORGOT PASSWORD ----------
router.post('/forgot', async (req, res) => {
  if (DEMO()) return res.status(400).json({ error: 'Password reset is turned off in the demo version. Create a new account or continue as a guest.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.body.username || '');
  const isAdmin = !!user && user.role === 'admin';

  if (user) {
    const code = issueOtp(user.id, 'reset');
    if (!code) return res.status(429).json({ error: 'Please wait 30 seconds before asking for a new code' });
    try {
      if (isAdmin) await sendSmsOtp(user.phone, code);
      else await sendEmailOtp(user.email, code, 'reset');
    } catch (e) {
      console.error('Reset code error:', e.message);
    }
  }
  // Same reply whether or not the user exists
  res.json({ ok: true, channel: isAdmin ? 'phone' : 'email' });
});

router.post('/reset', (req, res) => {
  if (DEMO()) return res.status(400).json({ error: 'Password reset is turned off in the demo version.' });
  const { username, code, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user || !checkOtp(user.id, 'reset', code))
    return res.status(400).json({ error: 'Invalid or expired code' });

  db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), user.id);
  res.json({ ok: true });
});

// ---------- WHO AM I / LOGOUT ----------
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { username: req.user.username, role: req.user.role } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('es_token');
  res.json({ ok: true });
});

module.exports = { router, requireAuth, requireAdmin, makeToken, setCookie };