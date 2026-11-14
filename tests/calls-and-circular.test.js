'use strict';
// Tests for the fire-call API logic and the monthly safety circular.
// Run with:  npm test        (needs Node 22 or newer, the same as the app)
// Uses a throw-away database file, never your real enviro.db. No network, no real SMS, email or calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dbFile = path.join(os.tmpdir(), 'enviro-test-' + process.pid + '.db');
process.env.DB_PATH = dbFile;
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_PHONE = '9876543210';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.CIRCULAR_TZ = 'Asia/Kolkata';
for (const k of ['BRIEF_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CALL_PROVIDER', 'TWILIO_ACCOUNT_SID', 'CALL_WEBHOOK_URL',
  'CALL_MIN_LEVEL', 'CALLS_AUTO', 'CALL_COOLDOWN_MIN', 'CIRCULAR', 'CIRCULAR_DAYS', 'CIRCULAR_HOUR']) delete process.env[k];

const { db } = require('../db');
db.exec(`
  CREATE TABLE IF NOT EXISTS sensors (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT UNIQUE NOT NULL, label TEXT, lat REAL NOT NULL, lon REAL NOT NULL, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS view_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, mode TEXT, place TEXT, lat REAL, lon REAL, ts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS readings (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, location TEXT, temperature REAL, humidity REAL, smoke REAL, cpu_temp REAL, status TEXT NOT NULL DEFAULT 'NORMAL', ts INTEGER NOT NULL);
`);
const Alerts = require('../services/alerts');
Alerts.init(db);
const Voice = require('../services/voice');
const Calls = require('../services/calls');
const Circular = require('../services/circular');

test.after(() => { for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(dbFile + s); } catch (e) { /* not there */ } });

// ---------------- fixtures ----------------
const SENSOR = { device_id: 'haldia-01', label: 'Haldia sensor', lat: 22.0667, lon: 88.0698 };
db.prepare('INSERT INTO sensors (device_id, label, lat, lon) VALUES (?, ?, ?, ?)').run(SENSOR.device_id, SENSOR.label, SENSOR.lat, SENSOR.lon);

const NEAR = 0.004, FAR = 0.045;                   // degrees of latitude: about 0.44 km and about 5 km
function addUser(name, { email = true, emailVerified = true, home = null, emailOn = 0, smsOn = 0, callOn = 0, circularOn = 1, phone = null, phoneVerified = 1 } = {}) {
  const id = Number(db.prepare('INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, ?, ?)')
    .run(name, email ? name + '@example.com' : null, 'x', emailVerified ? 1 : 0).lastInsertRowid);
  db.prepare(`INSERT INTO alert_prefs (user_id, email_on, sms_on, call_on, circular_on, phone, phone_verified, home_lat, home_lon, home_name, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Home', ?)`)
    .run(id, emailOn, smsOn, callOn, circularOn, phone, phone ? phoneVerified : 0, home ? SENSOR.lat + home : null, home !== null ? SENSOR.lon : null, Date.now());
  return id;
}
function view(userId, lat, daysAgoList) {
  for (const d of daysAgoList)
    db.prepare('INSERT INTO view_history (user_id, mode, place, lat, lon, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, 'local', 'Haldia', lat, SENSOR.lon, Date.now() - d * 24 * 3600 * 1000);
}

const u1 = addUser('lives_near', { home: NEAR, emailOn: 1, smsOn: 1, callOn: 0, phone: '9000000001' });   // SMS only: still gets the call
const u2 = addUser('visitor_regular', { home: FAR, emailOn: 1 });                            // lives 5 km away, looks at the place often
const u3 = addUser('visitor_rare', { home: FAR, emailOn: 1 });                               // only twice
const u4 = addUser('opted_out', { home: NEAR, emailOn: 1, circularOn: 0 });
const u5 = addUser('email_unverified', { home: NEAR, emailOn: 1, emailVerified: false });
const u6 = addUser('calls_only', { home: NEAR, callOn: 1, phone: '9000000006' });
const u7 = addUser('call_far', { home: FAR, callOn: 1, phone: '9000000007' });
const u8 = addUser('sms_unverified_phone', { home: NEAR, smsOn: 1, phone: '9000000008', phoneVerified: 0 });
view(u2, SENSOR.lat, [3, 10, 20, 40]);
view(u3, SENSOR.lat, [3, 10]);
view(u3, SENSOR.lat + FAR, [1, 2, 3, 4, 5]);       // many views, but of a place 5 km away: does not count

// ---------------- the calendar ----------------
test('circular days: 1st and 15th, from 09:00 India time, with a short catch-up', () => {
  const ist = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h, min) - 330 * 60 * 1000;
  assert.deepEqual(Circular.dueDates(ist(2026, 11, 1, 8, 59)), []);                 // too early
  assert.deepEqual(Circular.dueDates(ist(2026, 11, 1, 9, 0)), ['2026-11-01']);
  assert.deepEqual(Circular.dueDates(ist(2026, 11, 15, 23, 30)), ['2026-11-15']);
  assert.deepEqual(Circular.dueDates(ist(2026, 11, 2, 12)), ['2026-11-01']);        // catch-up after a missed day
  assert.deepEqual(Circular.dueDates(ist(2026, 11, 3, 12)), ['2026-11-01']);
  assert.deepEqual(Circular.dueDates(ist(2026, 11, 4, 12)), []);                    // too late now
  assert.deepEqual(Circular.dueDates(ist(2026, 11, 14, 12)), []);                   // an ordinary day
  assert.deepEqual(Circular.dueDates(ist(2026, 12, 1, 0, 30)), []);                 // still Nov 30 at 19:00 UTC but Dec 1 00:30 in India: before 09:00
  assert.deepEqual(Circular.dueDates(ist(2026, 12, 1, 9, 0)), ['2026-12-01']);
  assert.equal(Circular.scheduleWords(), '1st and 15th');
});

// ---------------- who gets the circular ----------------
test('circular audience: live nearby or regular visitor, opted in, verified, not opted out', () => {
  const a = Circular.audience(SENSOR, { emails: new Set(), phones: new Set() });
  assert.deepEqual(a.emails.sort(), ['admin@example.com', 'lives_near@example.com', 'visitor_regular@example.com'].sort());
  assert.deepEqual(a.phones.sort(), ['9000000001', '9876543210']);
  assert.equal(a.live, 1);
  assert.equal(a.visit, 1);
});

test('circular audience: nobody is counted twice across sensors', () => {
  const seen = { emails: new Set(), phones: new Set() };
  const first = Circular.audience(SENSOR, seen);
  const second = Circular.audience(SENSOR, seen);
  assert.ok(first.emails.length > 0);
  assert.equal(second.emails.length, 0);
  assert.equal(second.phones.length, 0);
});

// ---------------- the data and the message ----------------
// Synthetic satellite history: three full years of daily counts, busier in March and April
function fakeSatellite() {
  const series = new Map();
  let i = 0;
  for (let t = Date.UTC(2023, 0, 1); t <= Date.UTC(2026, 10, 13); t += 86400000, i++) {
    const d = new Date(t).toISOString().slice(0, 10), mo = Number(d.slice(5, 7));
    series.set(d, { d, v: ((i * 7) % 5) + (mo === 3 || mo === 4 ? 6 : 0), m: null, vi: null });
  }
  return { series, last: '2026-11-13' };
}
const NOW = Date.UTC(2026, 10, 15, 4, 30);          // 15 Nov 2026, 10:00 in India

function addReading(ts, temperature, status = 'NORMAL') {
  db.prepare('INSERT INTO readings (device_id, temperature, humidity, smoke, cpu_temp, status, ts) VALUES (?, ?, 50, 10, 40, ?, ?)')
    .run(SENSOR.device_id, temperature, status, ts);
}
addReading(Date.UTC(2026, 8, 10, 6), 41.5);                       // September
addReading(Date.UTC(2026, 8, 30, 20, 0), 44);                     // 30 Sep 20:00 UTC = 1 Oct 01:30 India, so it belongs to OCTOBER
addReading(Date.UTC(2026, 9, 12, 6), 36);                         // October
addReading(Date.UTC(2026, 10, 5, 6), 30.2);                       // November
db.prepare("INSERT INTO alert_events (ts, device_id, label, kind, level, headline, text) VALUES (?, ?, 'x', 'ALERT', 'ALERT', 'h', 't')").run(Date.UTC(2026, 8, 10, 6), SENSOR.device_id);
db.prepare("INSERT INTO alert_events (ts, device_id, label, kind, level, headline, text) VALUES (?, ?, 'x', 'ALERT', 'WARNING', 'h', 't')").run(Date.UTC(2026, 9, 12, 6), SENSOR.device_id);
db.prepare("INSERT INTO alert_events (ts, device_id, label, kind, level, headline, text) VALUES (?, ?, 'x', 'CLEAR', 'NORMAL', 'h', 't')").run(Date.UTC(2026, 9, 12, 7), SENSOR.device_id);   // a CLEAR is not an alert

test('circular data: twelve months, grouped by local month, satellite totals add up', () => {
  Circular.deps.satellite = fakeSatellite;
  const f = Circular.gather(SENSOR, NOW);
  assert.equal(f.months.length, 12);
  assert.equal(f.months[0].label, 'Dec 2025');
  assert.equal(f.months[11].label, 'Nov 2026');
  assert.equal(f.months[11].current, true);
  const by = k => f.months.find(m => m.key === k);

  assert.equal(by('2026-09').peakTemp, 41.5);
  assert.equal(by('2026-10').peakTemp, 44);                        // the 01:30 India reading landed in October, not September
  assert.equal(by('2026-11').peakTemp, 30.2);
  assert.equal(by('2026-09').alerts, 1);
  assert.equal(by('2026-10').alerts, 1);                           // the CLEAR event is not counted
  assert.equal(by('2026-08').alerts, null);                        // the sensor sent nothing that month

  const { series } = fakeSatellite();
  for (const key of ['2026-03', '2026-07', '2026-11']) {
    let sum = 0;
    for (const p of series.values()) if (p.d.startsWith(key)) sum += p.v;
    assert.equal(by(key).cells, Math.round(sum), 'satellite total for ' + key);
  }
  assert.ok(f.sat.busiest.label === 'Mar 2026' || f.sat.busiest.label === 'Apr 2026');
  assert.ok(f.outlook, 'the 14-day outlook is built from the same series');
});

test('circular message: built-in wording has the table, the steps and a short text message', async () => {
  Circular.deps.satellite = fakeSatellite;
  const m = await Circular.compose(SENSOR, NOW);
  assert.equal(m.ai, null);
  assert.match(m.subject, /Haldia \(15 Nov 2026\)/);
  assert.match(m.body, /MONTH BY MONTH, LAST 12 MONTHS/);
  assert.equal((m.body.match(/satellite fire cells|no satellite data/g) || []).length, 12);
  assert.match(m.body, /Oct 2026: .*sensor hottest 44 °C, sensor alerts 1/);
  assert.match(m.body, /Nov 2026 \(so far\)/);
  assert.match(m.body, /WHAT TO DO NOW/);
  assert.match(m.body, /IF A FIRE BREAKS OUT/);
  assert.match(m.body, /112/);
  assert.match(m.body, /1st and 15th/);
  assert.match(m.body, /not an official warning/);
  assert.doesNotMatch(m.body, /written by an AI/);
  assert.ok(m.sms.length <= 320, 'text message is ' + m.sms.length + ' characters');
  assert.match(m.sms, /Haldia/);
  assert.match(m.sms, /112/);
});

test('circular message: no satellite data still produces a complete message', async () => {
  Circular.deps.satellite = () => ({ outOfCoverage: true });
  const m = await Circular.compose(SENSOR, NOW);
  assert.match(m.body, /outside the downloaded satellite region/);
  assert.match(m.body, /no satellite data/);
  assert.match(m.body, /IF A FIRE BREAKS OUT/);
  Circular.deps.satellite = () => ({ empty: true });
  const n = await Circular.compose(SENSOR, NOW);
  assert.match(n.body, /not enough satellite history/);
});

// ---------------- the AI writer (a local fake of the Claude API) ----------------
function fakeClaude(answer) {                                      // answer(text) -> { status, text }
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const sent = JSON.parse(raw).messages[0].content.replace(/^Summary to rewrite:\n/, '');
        const a = answer(sent);
        res.writeHead(a.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: a.text || '' }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
async function withClaude(answer, fn) {
  const server = await fakeClaude(answer);
  Object.assign(process.env, { BRIEF_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'test', ANTHROPIC_API_URL: 'http://127.0.0.1:' + server.address().port + '/v1/messages' });
  try { return await fn(); }
  finally { server.close(); for (const k of ['BRIEF_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_URL']) delete process.env[k]; }
}

test('circular AI: a faithful rewrite is used and disclosed', async () => {
  Circular.deps.satellite = fakeSatellite;
  const m = await withClaude(t => ({ text: 'Hello neighbours. ' + t }), () => Circular.compose(SENSOR, NOW));
  assert.ok(m.ai, 'AI wording was accepted');
  assert.match(m.body, /Hello neighbours\./);
  assert.match(m.body, /written by an AI \(Claude\)/);
  assert.match(m.body, /IF A FIRE BREAKS OUT/);                    // the fixed parts are still there
});

test('circular AI: a rewrite that invents a number, or a risk word, is thrown away', async () => {
  Circular.deps.satellite = fakeSatellite;
  const origError = console.error; console.error = () => {};
  try {
    const bad = await withClaude(t => ({ text: t + ' About 99 homes were affected last year.' }), () => Circular.compose(SENSOR, NOW));
    assert.equal(bad.ai, null);
    assert.doesNotMatch(bad.body, /99 homes/);
    const risky = await withClaude(t => ({ text: t.replace('Confidence is', 'The danger is severe. Confidence is') }), () => Circular.compose(SENSOR, NOW));
    assert.equal(risky.ai, null);
    const down = await withClaude(() => ({ status: 500, text: '' }), () => Circular.compose(SENSOR, NOW));
    assert.equal(down.ai, null);
    assert.match(down.body, /MONTH BY MONTH/);                      // the circular still goes out
  } finally { console.error = origError; }
});

// ---------------- sending on the 1st and 15th ----------------
function captureSenders() {
  const sent = { emails: [], sms: [] };
  Alerts.deps.sendEmail = async (to, subject, text) => { sent.emails.push({ to, subject, text }); return 'sent'; };
  Alerts.deps.sendSms = async (numbers, message) => { sent.sms.push({ numbers, message }); return 'sent'; };
  return sent;
}
const ist = (y, m, d, h) => Date.UTC(y, m - 1, d, h) - 330 * 60 * 1000;

test('circular run: goes out once on the 15th, never twice, nothing on other days', async () => {
  Circular.deps.satellite = fakeSatellite;
  const sent = captureSenders();

  const quiet = await Circular.runIfDue(ist(2026, 11, 14, 12));
  assert.equal(quiet.ran, false);
  assert.equal(sent.emails.length, 0);

  const first = await Circular.runIfDue(ist(2026, 11, 15, 10));
  assert.equal(first.ran, true);
  assert.equal(first.runDate, '2026-11-15');
  assert.equal(sent.emails.length, 3);
  assert.equal(sent.sms.length, 1);
  assert.deepEqual(sent.sms[0].numbers.sort(), ['9000000001', '9876543210']);
  assert.ok(sent.emails.every(e => /MONTH BY MONTH/.test(e.text)));

  const again = await Circular.runIfDue(ist(2026, 11, 15, 11));
  assert.equal(again.results[0].skipped, 'already-sent');
  assert.equal(sent.emails.length, 3, 'no second copy');

  const row = db.prepare("SELECT status, emails, sms FROM circular_sent WHERE run_date = '2026-11-15'").get();
  assert.deepEqual({ ...row }, { status: 'done', emails: 3, sms: 2 });
});

test('circular run: two timers at once cannot double-send', async () => {
  Circular.deps.satellite = fakeSatellite;
  const sent = captureSenders();
  const [a, b] = await Promise.all([Circular.runIfDue(ist(2026, 12, 1, 10)), Circular.runIfDue(ist(2026, 12, 1, 10))]);
  assert.equal([a, b].filter(r => r.busy).length, 1);
  assert.equal(sent.emails.length, 3);
});

test('circular run: if everything fails nothing is lost, and it retries after 30 minutes', async () => {
  Circular.deps.satellite = fakeSatellite;
  const sent = captureSenders();
  Alerts.deps.sendEmail = async () => { throw new Error('SMTP down'); };
  Alerts.deps.sendSms = async () => { throw new Error('SMS down'); };
  const origError = console.error; console.error = () => {};
  try {
    const t0 = ist(2027, 1, 1, 10);
    const r1 = await Circular.runIfDue(t0);
    assert.equal(r1.results[0].status, 'failed');
    const r2 = await Circular.runIfDue(t0 + 10 * 60 * 1000);
    assert.equal(r2.results[0].skipped, 'already-sent', 'not retried after only 10 minutes');

    Alerts.deps.sendEmail = async (to) => { sent.emails.push({ to }); };
    Alerts.deps.sendSms = async (n) => { sent.sms.push({ n }); };
    const r3 = await Circular.runIfDue(t0 + 40 * 60 * 1000);
    assert.equal(r3.results[0].status, 'done');
    assert.equal(sent.emails.length, 3);
  } finally { console.error = origError; }
});

test('circular admin send: previews send nothing, a manual send does not block the scheduled one', async () => {
  Circular.deps.satellite = fakeSatellite;
  const sent = captureSenders();
  const pre = await Circular.runNow({ dryRun: true, now: NOW });
  assert.equal(pre.results[0].dryRun, true);
  assert.equal(pre.results[0].audience.emails, 3);
  assert.equal(pre.results[0].audience.phones, 2);
  assert.equal(sent.emails.length + sent.sms.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM circular_sent WHERE run_date LIKE '%manual%'").get().c, 0);

  const real = await Circular.runNow({ now: NOW });
  assert.equal(real.results[0].status, 'done');
  assert.equal(sent.emails.length, 3);

  const scheduled = await Circular.runIfDue(ist(2027, 2, 1, 10));
  assert.equal(scheduled.results[0].status, 'done');
  assert.equal(sent.emails.length, 6);
});

test('circular can be switched off', async () => {
  process.env.CIRCULAR = '0';
  try { assert.deepEqual(await Circular.runIfDue(ist(2027, 3, 1, 10)), { ran: false, reason: 'off' }); }
  finally { delete process.env.CIRCULAR; }
});

// ---------------- fire calls ----------------
function captureCalls() {
  const calls = [];
  Voice.deps.placeCall = async (number, message, ctx) => { calls.push({ number, message, ctx }); };
  return calls;
}
const resetCalls = () => db.prepare('DELETE FROM call_log').run();

test('fire calls: who is called', () => {
  // admin + the near subscriber with SMS on (u1, no call tick needed) + the near subscriber who ticked calls only (u6).
  // Not called: u7 (calls on but 5 km away) and u8 (SMS on but the phone is not verified).
  assert.deepEqual(Calls.recipients(SENSOR).sort(), ['9000000001', '9000000006', '9876543210']);
});

test('fire calls: the call says what is happening, in words the server wrote', async () => {
  resetCalls();
  const calls = captureCalls();
  const r = await Calls.fireCall(SENSOR, 'FIRE', { source: 'api' });
  assert.equal(r.placed, 3);
  assert.equal(r.failed, 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].number, '9876543210', 'the admin is called first');
  assert.match(calls[0].message, /fire alert at Haldia sensor/);
  assert.match(calls[0].message, /1 1 2/);
  assert.deepEqual(calls[0].ctx, { device_id: 'haldia-01', level: 'FIRE' });
});

test('fire calls: cooldown stops repeats, but a worse level always goes out', async () => {
  resetCalls();
  const calls = captureCalls();
  const t0 = Date.now();

  assert.equal((await Calls.fireCall(SENSOR, 'ALERT', { source: 'auto', now: t0 })).placed, 3);
  const repeat = await Calls.fireCall(SENSOR, 'ALERT', { source: 'api', now: t0 + 60 * 1000 });
  assert.equal(repeat.skipped, true);
  assert.equal(repeat.reason, 'cooldown');
  assert.ok(repeat.retryAfterSec > 0 && repeat.retryAfterSec <= 600);
  assert.equal(calls.length, 3);

  assert.equal((await Calls.fireCall(SENSOR, 'FIRE', { source: 'api', now: t0 + 2 * 60 * 1000 })).placed, 3, 'escalation is not held back');
  assert.equal((await Calls.fireCall(SENSOR, 'WARNING', { source: 'api', now: t0 + 3 * 60 * 1000 })).reason, 'cooldown', 'a lower level right after FIRE is skipped');
  assert.equal((await Calls.fireCall(SENSOR, 'FIRE', { source: 'api', now: t0 + 13 * 60 * 1000 })).placed, 3, 'more than 10 minutes after the last call it may call again');
  assert.equal((await Calls.fireCall(SENSOR, 'FIRE', { source: 'api', now: t0 + 14 * 60 * 1000 })).reason, 'cooldown');
  assert.equal((await Calls.fireCall(SENSOR, 'FIRE', { source: 'admin', force: true, now: t0 + 14 * 60 * 1000 })).placed, 3, 'an admin may force it');
});

test('fire calls: a failed call does not stop the others, and does not start the cooldown', async () => {
  resetCalls();
  const calls = [];
  Voice.deps.placeCall = async (number) => { if (number === '9000000001') throw new Error('busy line'); calls.push(number); };
  const origError = console.error; console.error = () => {};
  try {
    const r = await Calls.fireCall(SENSOR, 'FIRE', { source: 'api' });
    assert.equal(r.placed, 2);
    assert.equal(r.failed, 1);
    assert.match(r.errors[0], /^\*{6}0001: busy line/);              // the number is masked in logs
  } finally { console.error = origError; }

  resetCalls();
  Voice.deps.placeCall = async () => { throw new Error('provider down'); };
  console.error = () => {};
  try {
    const none = await Calls.fireCall(SENSOR, 'FIRE', { source: 'api' });
    assert.equal(none.placed, 0);
    Voice.deps.placeCall = async () => {};
    assert.equal((await Calls.fireCall(SENSOR, 'FIRE', { source: 'api' })).placed, 3, 'retry is allowed because nothing went out');
  } finally { console.error = origError; }
});

test('fire calls: automatic calls follow CALL_MIN_LEVEL and CALLS_AUTO', async () => {
  resetCalls();
  const calls = captureCalls();
  assert.equal((await Calls.autoCall(SENSOR, 'ALERT')).placed, 3);                 // default: from early warning up

  resetCalls(); calls.length = 0;
  process.env.CALL_MIN_LEVEL = 'FIRE';
  assert.equal((await Calls.autoCall(SENSOR, 'WARNING')).skipped, true);
  assert.equal(calls.length, 0);
  assert.equal((await Calls.autoCall(SENSOR, 'FIRE')).placed, 3);
  delete process.env.CALL_MIN_LEVEL;

  resetCalls(); calls.length = 0;
  process.env.CALLS_AUTO = '0';
  assert.equal((await Calls.autoCall(SENSOR, 'FIRE')).skipped, true);
  assert.equal(calls.length, 0);
  delete process.env.CALLS_AUTO;
});

test('fire calls: a real alert from the monitor starts the calls (end to end)', async () => {
  resetCalls();
  Alerts.deps.sendEmail = async () => 'sent';
  Alerts.deps.sendSms = async () => 'sent';
  const calls = captureCalls();
  const now = Date.now();
  for (let i = 0; i < 10; i++) addReading(now - 9000 + i * 1000, 60, 'FIRE');
  db.prepare("UPDATE readings SET smoke = 900 WHERE ts >= ?").run(now - 20000);
  await Alerts.tick(now);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls.length, 3, 'the monitor raised a FIRE alert and the three people were phoned');
  assert.equal(db.prepare("SELECT level FROM call_log ORDER BY id DESC LIMIT 1").get().level, 'FIRE');
});

test('fire calls: test call goes to the admin only and never counts toward the cooldown', async () => {
  resetCalls();
  const calls = captureCalls();
  const r = await Calls.testCall(SENSOR);
  assert.equal(r.placed, 1);
  assert.equal(calls[0].number, '9876543210');
  assert.match(calls[0].message, /test call/i);
  assert.match(calls[0].message, /No fire has been detected/);
  assert.equal((await Calls.fireCall(SENSOR, 'FIRE', { source: 'api' })).placed, 3);
});

test('voice providers: demo mode by default, twilio and webhook only with their keys', () => {
  delete Voice.deps.placeCall;
  assert.equal(Voice.provider(), 'demo');
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550001111' });
  assert.equal(Voice.provider(), 'twilio');
  process.env.CALL_PROVIDER = 'webhook';
  assert.equal(Voice.provider(), 'demo', 'webhook asked for but its URL is missing');
  process.env.CALL_WEBHOOK_URL = 'https://example.com/hook';
  assert.equal(Voice.provider(), 'webhook');
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'CALL_PROVIDER', 'CALL_WEBHOOK_URL']) delete process.env[k];
  assert.equal(Voice.provider(), 'demo');
});

test('voice providers: the webhook receives the number, the server-built text and the level', async () => {
  delete Voice.deps.placeCall;
  let got = null;
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let raw = ''; req.on('data', c => { raw += c; });
      req.on('end', () => { got = { auth: req.headers.authorization, body: JSON.parse(raw) }; res.end('{}'); });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  Object.assign(process.env, { CALL_PROVIDER: 'webhook', CALL_WEBHOOK_URL: 'http://127.0.0.1:' + server.address().port + '/call', CALL_WEBHOOK_TOKEN: 'secret' });
  try {
    const out = await Voice.placeCalls(['9876543210'], 'Hello there', { device_id: 'haldia-01', level: 'FIRE' });
    assert.equal(out.placed, 1);
    assert.deepEqual(got.body, { to: '+919876543210', message: 'Hello there', device_id: 'haldia-01', level: 'FIRE' });
    assert.equal(got.auth, 'Bearer secret');
  } finally {
    server.close();
    for (const k of ['CALL_PROVIDER', 'CALL_WEBHOOK_URL', 'CALL_WEBHOOK_TOKEN']) delete process.env[k];
  }
});

test('preferences: the new columns exist and default correctly on an existing database', () => {
  const cols = db.prepare('PRAGMA table_info(alert_prefs)').all().map(c => c.name);
  assert.ok(cols.includes('call_on') && cols.includes('circular_on'));
  Alerts.init(db);                                                  // running init again on an upgraded database changes nothing
  const id = Number(db.prepare("INSERT INTO users (username, password_hash) VALUES ('newbie', 'x')").run().lastInsertRowid);
  db.prepare('INSERT INTO alert_prefs (user_id) VALUES (?)').run(id);
  const p = db.prepare('SELECT call_on, circular_on FROM alert_prefs WHERE user_id = ?').get(id);
  assert.equal(p.call_on, 0, 'calls are opt-in');
  assert.equal(p.circular_on, 1, 'the circular is on unless switched off');
});

test('DEMO_OUTPUT=1 prints codes, SMS, emails and calls in the terminal even when real keys are set', async () => {
  const saved = { sms: Alerts.deps.sendSms, email: Alerts.deps.sendEmail, call: Voice.deps.placeCall, fetch: global.fetch, log: console.log };
  delete Alerts.deps.sendSms; delete Alerts.deps.sendEmail; delete Voice.deps.placeCall;
  const keys = { DEMO_OUTPUT: '1', FAST2SMS_KEY: 'real-looking-key', SMTP_USER: 'a@b.c', SMTP_PASS: 'pw', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550001111' };
  Object.assign(process.env, keys);
  const printed = [];
  console.log = (...a) => { printed.push(a.join(' ')); };
  global.fetch = async () => { throw new Error('a real request was made'); };
  try {
    assert.equal(await Alerts.sendSms(['9000000001'], 'Enviro Sense verification code: 123456. It is valid for 10 minutes.'), 'demo');
    assert.equal(await Alerts.sendEmail('x@example.com', 'Subject', 'Body'), 'demo');
    await require('../services/sms').sendSmsOtp('9000000001', '654321');
    const out = await Voice.placeCalls(['9000000001'], 'Hello there', {});
    assert.equal(out.placed, 1);
    assert.equal(out.mode, 'demo');
    assert.match(Voice.statusLine(), /DEMO_OUTPUT=1/);
  } finally {
    console.log = saved.log; global.fetch = saved.fetch;
    Object.assign(Alerts.deps, { sendSms: saved.sms, sendEmail: saved.email }); Voice.deps.placeCall = saved.call;
    for (const k of Object.keys(keys)) delete process.env[k];
  }
  const all = printed.join('\n');
  assert.match(all, /\[DEMO SMS\] to 9000000001\s+Enviro Sense verification code: 123456/);
  assert.match(all, /\[DEMO EMAIL\] to x@example.com/);
  assert.match(all, /\[DEMO SMS\] To: 9000000001 \| Enviro Sense admin reset CODE: 654321/);
  assert.match(all, /\[DEMO CALL\] to 9000000001/);
});
