'use strict';
// Fire calls: phone people when a fire may be breaking out.
//
// Two ways in, one code path:
//   1. automatic  - alerts.js calls autoCall() when a sensor moves UP to ALERT / WARNING / FIRE
//   2. on request - POST /api/calls/fire (see callsapi.js) lets the Raspberry Pi, another system or an admin trigger it
//
// Who is called: the admin phone, plus every verified subscriber whose home is within CALL_KM of the sensor and who has
// text message (SMS) alerts on OR has ticked "Phone call alerts". So anyone who gets the SMS also gets the call.
// Safety rails: a cooldown per sensor (a repeat at the same or a lower level inside the cooldown is skipped, a worse level always goes out),
// a cap on calls per event, and spoken text that the server builds itself.
//
//   CALLS_AUTO=0          turns off the automatic calls (the API still works)
//   CALL_MIN_LEVEL=ALERT  the lowest level that triggers a call: ALERT (early warning), WARNING or FIRE
//   CALL_KM=1             radius around the sensor
//   CALL_COOLDOWN_MIN=10  minutes before the same sensor may call again at the same or a lower level
//   CALL_MAX=50           most calls for one event
const Alerts = require('./alerts');
const Brief = require('./brief');
const Voice = require('./voice');

const numEnv = (name, def) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : def;
};
const LEVELS = ['ALERT', 'WARNING', 'FIRE'];

const callKm = () => numEnv('CALL_KM', Alerts.SMS_KM) || Alerts.SMS_KM;
const cooldownMs = () => numEnv('CALL_COOLDOWN_MIN', 10) * 60 * 1000;
const maxCalls = () => Math.max(1, Math.floor(numEnv('CALL_MAX', 50)));
const minLevel = () => {
  const l = String(process.env.CALL_MIN_LEVEL || 'ALERT').trim().toUpperCase();
  return LEVELS.includes(l) ? l : 'ALERT';
};
const autoOn = () => process.env.CALLS_AUTO !== '0';

let ready = null;
function db() {
  const d = require('../db').db;
  if (ready !== d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS call_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        level TEXT,
        source TEXT NOT NULL,
        placed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        mode TEXT,
        details TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_call_log_dev ON call_log (device_id, id);
    `);
    ready = d;
  }
  return d;
}

// ---------------- the words that are spoken ----------------
// Digits of 112 are spaced so the voice reads "one one two", not "one hundred and twelve".
function voiceFor(kind, level, label) {
  if (kind === 'TEST') return 'This is a test call from Enviro Sense for ' + label + '. No fire has been detected. You do not need to do anything.';
  if (level === 'FIRE')
    return 'Enviro Sense fire alert at ' + label + '. Fire conditions have been detected. Move away from the area now. If you see fire or smoke, call 1 1 2.';
  if (level === 'WARNING')
    return 'Enviro Sense warning at ' + label + '. Temperature or smoke is past the warning limits and a fire may break out. Be ready to leave. If you see fire or smoke, move away and call 1 1 2.';
  return 'Enviro Sense early warning at ' + label + '. Conditions are heating up fast and a fire may break out. Stay alert. If you see fire or smoke, move away and call 1 1 2.';
}

// ---------------- who is called ----------------
function recipients(sensor) {
  const phones = new Set();                                    // the admin goes first, so the cap never cuts the admin
  const admin = Alerts.normPhone(process.env.ADMIN_PHONE);
  if (admin) phones.add(admin);
  const rows = db().prepare(
    `SELECT phone, home_lat, home_lon FROM alert_prefs
     WHERE (call_on = 1 OR sms_on = 1) AND phone_verified = 1 AND phone IS NOT NULL AND home_lat IS NOT NULL AND home_lon IS NOT NULL`).all();
  for (const p of rows) if (Alerts.km(sensor.lat, sensor.lon, p.home_lat, p.home_lon) <= callKm()) phones.add(p.phone);
  return [...phones];
}

// ---------------- the call itself ----------------
// source: 'auto' | 'api' | 'admin'.  force (admin only) skips the cooldown.
async function fireCall(sensor, level, { source = 'api', force = false, now = Date.now() } = {}) {
  if (!LEVELS.includes(level)) return { ok: false, skipped: true, reason: 'bad-level', placed: 0, failed: 0 };
  const d = db();
  const label = Brief.cleanName(sensor.label || sensor.device_id);

  if (!force) {
    const last = d.prepare("SELECT ts, level FROM call_log WHERE device_id = ? AND source != 'test' AND placed > 0 ORDER BY id DESC LIMIT 1").get(sensor.device_id);
    if (last && now - last.ts < cooldownMs() && Alerts.rankOf(last.level) >= Alerts.rankOf(level))
      return { ok: false, skipped: true, reason: 'cooldown', retryAfterSec: Math.ceil((cooldownMs() - (now - last.ts)) / 1000), placed: 0, failed: 0 };
  }

  const numbers = recipients(sensor).slice(0, maxCalls());
  const row = d.prepare('INSERT INTO call_log (ts, device_id, level, source) VALUES (?, ?, ?, ?)').run(now, sensor.device_id, level, source);
  const id = Number(row.lastInsertRowid);

  const out = numbers.length
    ? await Voice.placeCalls(numbers, voiceFor('ALERT', level, label), { device_id: sensor.device_id, level })
    : { placed: 0, failed: 0, errors: [], mode: Voice.provider() };

  d.prepare('UPDATE call_log SET placed = ?, failed = ?, mode = ?, details = ? WHERE id = ?')
    .run(out.placed, out.failed, out.mode, out.errors.length ? out.errors.join(' | ').slice(0, 500) : null, id);
  if (out.failed) console.error('Fire call problems:', out.errors.join(' | '));
  console.log('FIRE CALL ' + level + ' at ' + label + ': ' + out.placed + ' placed, ' + out.failed + ' failed (' + out.mode + ')');
  return { ok: out.placed > 0, id, level, placed: out.placed, failed: out.failed, mode: out.mode, errors: out.errors, noRecipients: !numbers.length };
}

// Used by alerts.js on every move UP. Calls only at CALL_MIN_LEVEL or worse.
async function autoCall(sensor, level) {
  if (!autoOn() || Alerts.rankOf(level) < Alerts.rankOf(minLevel())) return { skipped: true, reason: 'auto-off-or-below-minimum' };
  return fireCall(sensor, level, { source: 'auto' });
}

// Admin test: calls the admin phone only, never anybody else, and never counts toward the cooldown.
async function testCall(sensor) {
  const admin = Alerts.normPhone(process.env.ADMIN_PHONE);
  if (!admin) return { ok: false, reason: 'no-admin-phone', placed: 0, failed: 0 };
  const label = Brief.cleanName(sensor.label || sensor.device_id);
  const out = await Voice.placeCalls([admin], voiceFor('TEST', 'TEST', label), { device_id: sensor.device_id, level: 'TEST' });
  db().prepare('INSERT INTO call_log (ts, device_id, level, source, placed, failed, mode, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), sensor.device_id, 'TEST', 'test', out.placed, out.failed, out.mode, out.errors.length ? out.errors.join(' | ').slice(0, 500) : null);
  return { ok: out.placed > 0, placed: out.placed, failed: out.failed, mode: out.mode, errors: out.errors };
}

const recent = (limit = 50) =>
  db().prepare('SELECT id, ts, device_id, level, source, placed, failed, mode, details FROM call_log ORDER BY id DESC LIMIT ?').all(limit);

module.exports = { fireCall, autoCall, testCall, recipients, voiceFor, recent, LEVELS, minLevel, autoOn, callKm };
