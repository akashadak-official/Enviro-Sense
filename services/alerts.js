'use strict';
// Step 11: automatic alerts.
// A background monitor checks every sensor every few seconds, even when nobody has the dashboard open.
// When a sensor moves UP to ALERT, WARNING or FIRE it sends:
//   - email to the admin and to opted-in users whose home is within 100 km of the sensor
//   - SMS to the admin phone and to verified, opted-in subscribers whose home is within 1 km of the sensor
//   - a voice call (see calls.js) to the admin phone and to verified subscribers within 1 km who switched calls on
// Messages go out at once with built-in wording. An AI writer (if configured) then adds a clearer
// version in the background; it never delays an alert.
const Warn = require('./earlywarn');
const Brief = require('./brief');
const Risk = require('./riskmodel');

const RANK = { ALERT: 2, WARNING: 3, FIRE: 4 };
const rankOf = level => RANK[level] || 0;

const TICK_MS = 10 * 1000;
const CLEAR_HOLD_MS = 3 * 60 * 1000;          // readings must stay NORMAL this long before "all clear"
const INCIDENT_MAX_MS = 60 * 60 * 1000;       // an incident closes by itself after an hour without a new alert level
const EMAIL_KM = 100;
const SMS_KM = 1;

let db = null;
let timer = null;
let busy = false;
const deps = {};                               // tests replace deps.sendEmail / deps.sendSms

// ---------------- setup ----------------
function init(database) {
  db = database || require('../db').db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_prefs (
      user_id INTEGER PRIMARY KEY,
      email_on INTEGER NOT NULL DEFAULT 0,
      sms_on INTEGER NOT NULL DEFAULT 0,
      phone TEXT,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      home_lat REAL, home_lon REAL, home_name TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS phone_codes (
      user_id INTEGER PRIMARY KEY,
      phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_state (
      device_id TEXT PRIMARY KEY,
      notified_rank INTEGER NOT NULL DEFAULT 0,
      since INTEGER,
      normal_since INTEGER,
      event_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      label TEXT,
      kind TEXT NOT NULL,
      level TEXT,
      headline TEXT,
      text TEXT,
      ai_text TEXT,
      emails INTEGER NOT NULL DEFAULT 0,
      sms INTEGER NOT NULL DEFAULT 0,
      details TEXT
    );
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_readings_dev_ts ON readings (device_id, ts)'); } catch (e) { /* readings table not there yet */ }

  // Columns added later: CREATE TABLE IF NOT EXISTS does not add them to a database that already has the table.
  //   call_on      1 = also phone me (voice call) when a sensor near my home shows an early warning, warning or fire. Off until chosen.
  //   circular_on  1 = send me the monthly safety circular (1st and 15th). On for people who already have alerts on; they can switch it off.
  const have = db.prepare('PRAGMA table_info(alert_prefs)').all().map(c => c.name);
  if (!have.includes('call_on')) db.exec('ALTER TABLE alert_prefs ADD COLUMN call_on INTEGER NOT NULL DEFAULT 0');
  if (!have.includes('circular_on')) db.exec('ALTER TABLE alert_prefs ADD COLUMN circular_on INTEGER NOT NULL DEFAULT 1');
  return db;
}

function start() {
  init();
  if (timer) return;
  timer = setInterval(() => { tick().catch(e => console.error('Alert monitor error:', e)); }, TICK_MS);
  setTimeout(() => { tick().catch(e => console.error('Alert monitor error:', e)); }, 3000);
  console.log('Alert monitor: ON (checks every ' + TICK_MS / 1000 + ' s; email within ' + EMAIL_KM + ' km, SMS within ' + SMS_KM + ' km)');
}

function stop() { if (timer) clearInterval(timer); timer = null; }

// ---------------- helpers ----------------
function km(lat1, lon1, lat2, lon2) {
  const R = 6371, r = x => x * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Indian mobile numbers: 10 digits starting 6-9. Accepts +91..., 91..., 0...
function normPhone(input) {
  let d = String(input || '').replace(/[\s\-()]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

const maskPhone = p => (p ? '******' + String(p).slice(-4) : '');
const stamp = ts => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

// ---------------- senders (print to the terminal when no real keys are set) ----------------
let transporter = null;

async function sendEmail(to, subject, text) {
  if (deps.sendEmail) return deps.sendEmail(to, subject, text);
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!user || !pass || process.env.DEMO_OUTPUT === '1') {          // DEMO_OUTPUT=1: print instead of sending, even if keys are set
    console.log('\n[DEMO EMAIL] to ' + to + '\n  Subject: ' + subject + '\n  ' + text.replace(/\n/g, '\n  ') + '\n');
    return 'demo';
  }
  if (!transporter) transporter = require('nodemailer').createTransport({ service: 'gmail', auth: { user, pass } });
  await transporter.sendMail({ from: process.env.MAIL_FROM || user, to, subject, text });
  return 'sent';
}

async function sendSms(numbers, message) {
  if (deps.sendSms) return deps.sendSms(numbers, message);
  if (!numbers.length) return 'none';
  const key = process.env.FAST2SMS_KEY;
  if (!key || process.env.DEMO_OUTPUT === '1') {                    // DEMO_OUTPUT=1: print instead of sending, even if a key is set
    console.log('\n[DEMO SMS] to ' + numbers.join(', ') + '\n  ' + message + '\n');
    return 'demo';
  }
  for (let i = 0; i < numbers.length; i += 100) {
    const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ route: process.env.FAST2SMS_ROUTE || 'q', message, numbers: numbers.slice(i, i + 100).join(','), flash: 0 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.return === false) throw new Error('SMS provider refused: HTTP ' + res.status + ' ' + JSON.stringify(body.message || '').slice(0, 120));
  }
  return 'sent';
}

// ---------------- who gets told ----------------
function adminEmails() {                       // the admin account's email, plus ADMIN_EMAIL from .env if set
  const set = new Set();
  for (const a of db.prepare("SELECT email FROM users WHERE role = 'admin'").all()) if (a.email) set.add(a.email);
  const extra = String(process.env.ADMIN_EMAIL || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extra)) set.add(extra);
  return [...set];
}

function recipients(sensor) {
  const emails = new Set(adminEmails()), phones = new Set();
  const adminPhone = normPhone(process.env.ADMIN_PHONE);
  if (adminPhone) phones.add(adminPhone);

  const rows = db.prepare(
    `SELECT p.*, u.email, u.email_verified FROM alert_prefs p JOIN users u ON u.id = p.user_id
     WHERE p.home_lat IS NOT NULL AND p.home_lon IS NOT NULL`).all();
  for (const p of rows) {
    const d = km(sensor.lat, sensor.lon, p.home_lat, p.home_lon);
    if (p.email_on && p.email && p.email_verified && d <= EMAIL_KM) emails.add(p.email);
    if (p.sms_on && p.phone && p.phone_verified && d <= SMS_KM) phones.add(p.phone);
  }
  return { emails: [...emails], phones: [...phones] };
}

// ---------------- message wording ----------------
function headlineFor(level, label) {
  if (level === 'FIRE') return 'FIRE conditions at ' + label;
  if (level === 'WARNING') return 'Warning limits exceeded at ' + label;
  return 'Early warning at ' + label;
}

function smsFor(kind, level, label, w) {
  if (kind === 'CLEAR') return 'Enviro Sense: all clear at ' + label + '. Readings are back to normal. Stay careful.';
  const now = w.temperature + 'C, smoke ' + w.smoke;
  const act = level === 'ALERT' ? 'Conditions are heating up fast. Stay alert.'
    : 'If you see fire or smoke move away and call 112.';
  return 'Enviro Sense ' + (level === 'ALERT' ? 'EARLY WARNING' : level) + ' at ' + label + ' (' + now + '). ' + act;
}

const FOOTER = '\n\nYou get this because alerts are switched on for your Enviro Sense account (turn them off any time under My alerts on the dashboard). ' +
  'This is an automated sensor-based alert, not an official warning. In an emergency call 112.';

function outlookFor(lat, lon) {                 // satellite part of the briefing; never blocks or breaks an alert
  try {
    const F = require('./firms');
    const [w, s, e, n] = F.COVERAGE;
    if (!(lon >= w && lon <= e && lat >= s && lat <= n)) return { outOfCoverage: true };
    const built = require('../fire').buildSeries(lat, lon, 50);
    return built ? Risk.buildOutlook(built.series, built.last) : { empty: true };
  } catch (e) {
    return { empty: true };
  }
}

// ---------------- sending one alert ----------------
async function deliver(eventId, sensor, kind, level, w, briefing) {
  const label = Brief.cleanName(sensor.label || sensor.device_id);
  const who = recipients(sensor);
  const head = kind === 'CLEAR' ? 'All clear at ' + label : headlineFor(level, label);
  const subject = (kind === 'TEST' ? 'TEST: ' : '') + 'Enviro Sense: ' + head;
  const body = (kind === 'TEST' ? 'THIS IS A TEST ALERT. No fire has been detected.\n\n' : '') +
    head + '\nTime: ' + stamp(Date.now()) + '\n\n' + briefing + FOOTER;
  const sms = (kind === 'TEST' ? 'TEST ' : '') + smsFor(kind, level, label, w);

  const errors = [];
  let emails = 0, smsCount = 0;

  await Promise.all(who.emails.map(async to => {
    try { await sendEmail(to, subject, body); emails++; } catch (e) { errors.push('email ' + e.message); }
  }));
  try { await sendSms(who.phones, sms); smsCount = who.phones.length; } catch (e) { errors.push('sms ' + e.message); }

  db.prepare('UPDATE alert_events SET emails = ?, sms = ?, details = ? WHERE id = ?')
    .run(emails, smsCount, errors.length ? errors.join(' | ').slice(0, 500) : null, eventId);
  if (errors.length) console.error('Alert delivery problems:', errors.join(' | '));
}

function addEvent(sensor, kind, level, headline, text) {
  const r = db.prepare('INSERT INTO alert_events (ts, device_id, label, kind, level, headline, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), sensor.device_id, Brief.cleanName(sensor.label || sensor.device_id), kind, level, headline, text);
  return Number(r.lastInsertRowid);
}

function addAiText(eventId, facts, offline) {   // background: never awaited by the alert path
  if (!Brief.aiAvailable()) return;
  Brief.aiText(facts, offline)
    .then(out => db.prepare('UPDATE alert_events SET ai_text = ? WHERE id = ?').run(out.text, eventId))
    .catch(e => console.error('AI wording for the alert was skipped:', e.message));
}

async function raise(sensor, level, w, now) {
  const label = Brief.cleanName(sensor.label || sensor.device_id);
  const facts = Brief.makeFacts(label, 50, outlookFor(sensor.lat, sensor.lon), { label, ...w });
  const offline = Brief.offlineText(facts);
  const id = addEvent(sensor, 'ALERT', level, headlineFor(level, label), offline);

  db.prepare(`INSERT INTO alert_state (device_id, notified_rank, since, normal_since, event_id) VALUES (?, ?, ?, NULL, ?)
              ON CONFLICT(device_id) DO UPDATE SET notified_rank = excluded.notified_rank,
                since = COALESCE(alert_state.since, excluded.since), normal_since = NULL, event_id = excluded.event_id`)
    .run(sensor.device_id, rankOf(level), now, id);

  console.log('ALERT ' + level + ' at ' + label);
  // Phone calls start at the same moment as the email and SMS and never hold them up (and a failed call never stops them)
  require('./calls').autoCall(sensor, level, w).catch(e => console.error('Fire call skipped:', e.message));
  await deliver(id, sensor, 'ALERT', level, w, offline);
  addAiText(id, facts, offline);
  return id;
}

async function clear(sensor, w) {
  const label = Brief.cleanName(sensor.label || sensor.device_id);
  const text = 'Readings at ' + label + ' have been back to normal for ' + CLEAR_HOLD_MS / 60000 + ' minutes. The alert is closed.';
  db.prepare("UPDATE alert_state SET notified_rank = 0, since = NULL, normal_since = NULL WHERE device_id = ?").run(sensor.device_id);
  const id = addEvent(sensor, 'CLEAR', 'NORMAL', 'All clear at ' + label, text);
  console.log('ALL CLEAR at ' + label);
  await deliver(id, sensor, 'CLEAR', 'NORMAL', w, text);
}

// ---------------- one check of one sensor ----------------
async function check(sensor, now = Date.now()) {
  const rows = db.prepare('SELECT ts, temperature, humidity, smoke, status FROM readings WHERE device_id = ? AND ts >= ? ORDER BY ts ASC')
    .all(sensor.device_id, now - 120000);
  const w = Warn.assess(rows, now);
  const rank = rankOf(w.level);

  let st = db.prepare('SELECT * FROM alert_state WHERE device_id = ?').get(sensor.device_id);
  if (!st) {
    db.prepare('INSERT INTO alert_state (device_id, notified_rank) VALUES (?, 0)').run(sensor.device_id);
    st = { notified_rank: 0, since: null, normal_since: null };
  }

  if (rank > st.notified_rank) return raise(sensor, w.level, w, now);        // went UP: tell people

  if (st.notified_rank > 0) {                                                // an incident is open
    if (w.level === 'NORMAL') {
      if (!st.normal_since) db.prepare('UPDATE alert_state SET normal_since = ? WHERE device_id = ?').run(now, sensor.device_id);
      else if (now - st.normal_since >= CLEAR_HOLD_MS) return clear(sensor, w);
    } else if (st.normal_since) {
      db.prepare('UPDATE alert_state SET normal_since = NULL WHERE device_id = ?').run(sensor.device_id);
    }
    if (st.since && now - st.since >= INCIDENT_MAX_MS && rank === 0) return clear(sensor, w);
  }
}

async function tick(now = Date.now()) {
  if (busy || !db) return;
  busy = true;
  try {
    for (const s of db.prepare('SELECT device_id, label, lat, lon FROM sensors').all()) {
      try { await check(s, now); } catch (e) { console.error('Alert check failed for ' + s.device_id + ':', e.message); }
    }
  } finally { busy = false; }
}

// ---------------- admin test: goes to the admin only, changes no incident state ----------------
async function sendTest(sensor) {
  const label = Brief.cleanName(sensor.label || sensor.device_id);
  const w = { temperature: 0, smoke: 0 };
  const text = 'This is a test of the alert system. No fire has been detected.';
  const id = addEvent(sensor, 'TEST', 'TEST', 'TEST alert for ' + label, text);

  const emails = adminEmails(), phones = [];
  const ap = normPhone(process.env.ADMIN_PHONE); if (ap) phones.push(ap);

  const errors = [];
  let sentEmails = 0, sentSms = 0;
  for (const to of emails) {
    try { await sendEmail(to, 'TEST: Enviro Sense alert test for ' + label, text + '\nTime: ' + stamp(Date.now())); sentEmails++; }
    catch (e) { errors.push('email ' + e.message); }
  }
  try { await sendSms(phones, 'Enviro Sense TEST alert for ' + label + '. No fire detected.'); sentSms = phones.length; }
  catch (e) { errors.push('sms ' + e.message); }
  db.prepare('UPDATE alert_events SET emails = ?, sms = ?, details = ? WHERE id = ?')
    .run(sentEmails, sentSms, errors.length ? errors.join(' | ').slice(0, 500) : null, id);
  return { id, emails: sentEmails, sms: sentSms, errors };
}

// ---------------- reads used by the API ----------------
function activeIncident(deviceId) {
  const st = db.prepare('SELECT * FROM alert_state WHERE device_id = ?').get(deviceId);
  if (!st || !st.notified_rank || !st.event_id) return null;
  const ev = db.prepare('SELECT id, ts, device_id, label, level, headline, text, ai_text FROM alert_events WHERE id = ?').get(st.event_id);
  return ev ? { ...ev, since: st.since } : null;
}

const recent = (limit = 50) =>
  db.prepare('SELECT id, ts, device_id, label, kind, level, headline, emails, sms, details FROM alert_events ORDER BY id DESC LIMIT ?').all(limit);

module.exports = {
  init, start, stop, tick, check, sendTest, activeIncident, recent, recipients,
  sendSms, sendEmail, normPhone, maskPhone, km, rankOf, adminEmails, stamp, deps,
  EMAIL_KM, SMS_KM
};
