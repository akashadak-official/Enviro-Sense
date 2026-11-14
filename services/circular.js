'use strict';
// The monthly safety circular: an automatic agent that, on the 1st and 15th of every month, sends everyone within
// CIRCULAR_KM (default 1 km) of a sensor a message with
//   - the month-by-month data for that place (satellite burning cells, the local sensor's hottest reading and its alerts),
//   - an AI-written plain-language summary of what that data means and what the next 14 days look like,
//   - what to do now, and what to do if a fire breaks out.
//
// "Everyone" means people who
//   - live there:            their saved home is within the radius, or
//   - regularly visit there: they looked at a place within the radius on at least CIRCULAR_MIN_VISITS different days in the last
//                            CIRCULAR_VISIT_DAYS days (this app only knows what people look at, not where their body is)
// AND who already switched on email or SMS alerts with a verified address / number (the same consent the live alerts use)
// AND who have not switched the circular off under "My alerts". The admin always gets a copy.
//
// What the AI may and may not do: it only REWRITES the summary paragraph, and the answer is thrown away if it adds a number or a
// risk word that was not in the original (see brief.js). The month table and the safety steps are fixed text built here.
// With no AI configured, or if the AI is down or rejected, the plain built-in summary is sent instead, so the circular always goes out.
//
//   CIRCULAR=0               switch the whole thing off
//   CIRCULAR_DAYS=1,15       days of the month
//   CIRCULAR_HOUR=9          local hour from which it may go out (it is retried every 15 minutes until it has)
//   CIRCULAR_TZ=Asia/Kolkata time zone for the day and hour
//   CIRCULAR_KM=1            audience radius around each sensor
//   CIRCULAR_SAT_KM=10       radius for the satellite figures (a 1 km circle is too small to show anything)
//   CIRCULAR_VISIT_DAYS=90, CIRCULAR_MIN_VISITS=3     what "regularly visits" means
//   CIRCULAR_CATCHUP_DAYS=2  if the server was off at the scheduled time, still send within this many days
//   CRON_KEY=...             lets an outside timer call POST /api/circular/run-due (for hosts that put the server to sleep)
const Alerts = require('./alerts');
const Brief = require('./brief');
const Risk = require('./riskmodel');
const { toMs } = require('./util');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_SHOWN = 12;
const CHECK_MS = 15 * 60 * 1000;
const deps = {};                                   // tests replace deps.satellite(lat, lon, km) -> { series, last } | { outOfCoverage } | { empty }

const numEnv = (name, def) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : def;
};
const radiusKm = () => numEnv('CIRCULAR_KM', Alerts.SMS_KM) || Alerts.SMS_KM;
const satKm = () => numEnv('CIRCULAR_SAT_KM', 10) || 10;
const sendHour = () => Math.min(23, Math.floor(numEnv('CIRCULAR_HOUR', 9)));
const visitDays = () => numEnv('CIRCULAR_VISIT_DAYS', 90);
const minVisits = () => Math.max(1, Math.floor(numEnv('CIRCULAR_MIN_VISITS', 3)));
const catchupDays = () => Math.floor(numEnv('CIRCULAR_CATCHUP_DAYS', 2));
const tz = () => process.env.CIRCULAR_TZ || 'Asia/Kolkata';
const enabled = () => process.env.CIRCULAR !== '0';
const days = () => {
  const list = String(process.env.CIRCULAR_DAYS || '1,15').split(/[\s,]+/).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 28);
  return list.length ? [...new Set(list)].sort((a, b) => a - b) : [1, 15];     // 28 at most, so every month has the day
};

const ord = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const scheduleWords = () => { const o = days().map(ord); return o.length > 1 ? o.slice(0, -1).join(', ') + ' and ' + o[o.length - 1] : o[0]; };
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const fmtNum = x => (Math.round(x * 10) / 10).toString();
const fmtDay = iso => MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + Number(iso.slice(8, 10));

// ---------------- database ----------------
let ready = null;
function db() {
  const d = require('../db').db;
  if (ready !== d) {
    Alerts.init(d);                                // makes sure alert_prefs has the circular_on column
    d.exec(`
      CREATE TABLE IF NOT EXISTS circular_sent (
        run_date TEXT NOT NULL,
        device_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        emails INTEGER NOT NULL DEFAULT 0,
        sms INTEGER NOT NULL DEFAULT 0,
        ai TEXT,
        details TEXT,
        PRIMARY KEY (run_date, device_id)
      );
    `);
    ready = d;
  }
  return d;
}

// ---------------- local calendar (day and hour in CIRCULAR_TZ) ----------------
function localParts(ts = Date.now()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ts))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const pad = n => String(n).padStart(2, '0');
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, ymd: p.year + '-' + pad(p.month) + '-' + pad(p.day) };
}

function tzOffsetMin(ts = Date.now()) {            // minutes ahead of UTC, for grouping readings by local month in SQL
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz(), timeZoneName: 'longOffset' }).formatToParts(new Date(ts)).find(x => x.type === 'timeZoneName').value;
    const m = /GMT([+-])(\d\d):(\d\d)/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  } catch (e) { return 0; }
}

// Which calendar date should a circular have gone out on, if any? Newest first, today only after CIRCULAR_HOUR.
function dueDates(now = Date.now()) {
  const p = localParts(now), out = [];
  for (let k = 0; k <= catchupDays(); k++) {
    const dt = new Date(Date.UTC(p.year, p.month - 1, p.day - k));
    if (!days().includes(dt.getUTCDate())) continue;
    if (k === 0 && p.hour < sendHour()) continue;
    out.push(dt.toISOString().slice(0, 10));
  }
  return out.slice(0, 1);
}

// ---------------- the data ----------------
function monthKeys(p) {                            // the last 12 months, oldest first, the current month last
  const keys = [];
  for (let i = MONTHS_SHOWN - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(p.year, p.month - 1 - i, 1));
    const key = dt.toISOString().slice(0, 7);
    keys.push({ key, label: MONTHS[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear(), current: i === 0 });
  }
  return keys;
}

function satellite(lat, lon) {
  try {
    if (deps.satellite) return deps.satellite(lat, lon, satKm());
    const F = require('./firms');
    const [w, s, e, n] = F.COVERAGE;
    if (!(lon >= w && lon <= e && lat >= s && lat <= n)) return { outOfCoverage: true };
    const built = require('../fire').buildSeries(lat, lon, satKm());
    return built ? { series: built.series, last: built.last } : { empty: true };
  } catch (e) {
    console.error('Circular: satellite data unavailable:', e.message);
    return { empty: true };
  }
}

const placeName = sensor => Brief.cleanName(sensor.label || sensor.device_id).replace(/\s+sensor$/i, '') || 'this location';

function gather(sensor, now = Date.now()) {
  const d = db(), p = localParts(now), keys = monthKeys(p), off = tzOffsetMin(now) + ' minutes';
  const since = now - 400 * 24 * 3600 * 1000;

  // the local sensor, by month
  const sensorBy = new Map(d.prepare(
    `SELECT strftime('%Y-%m', ts / 1000, 'unixepoch', ?) AS m, COUNT(*) AS n, MAX(temperature) AS peak
     FROM readings WHERE device_id = ? AND ts >= ? GROUP BY m`).all(off, sensor.device_id, since).map(r => [r.m, r]));
  const alertsBy = new Map(d.prepare(
    `SELECT strftime('%Y-%m', ts / 1000, 'unixepoch', ?) AS m, COUNT(*) AS n
     FROM alert_events WHERE device_id = ? AND kind = 'ALERT' AND ts >= ? GROUP BY m`).all(off, sensor.device_id, since).map(r => [r.m, r.n]));

  // satellite, by month
  const sat = satellite(sensor.lat, sensor.lon);
  const cells = new Map(keys.map(k => [k.key, { cells: 0, days: 0 }]));
  let outlook = null, state = 'none';
  if (sat.outOfCoverage) state = 'out';
  else if (sat.series) {
    for (const pt of sat.series.values()) {
      if (pt.v === null) continue;
      const a = cells.get(pt.d.slice(0, 7));
      if (a) { a.cells += pt.v; a.days++; }
    }
    const o = Risk.buildOutlook(sat.series, sat.last);
    outlook = o && o.days ? o : null;
    state = 'ok';
  }

  const months = keys.map(k => {
    const s = sensorBy.get(k.key), c = cells.get(k.key);
    return {
      key: k.key, label: k.label, current: k.current,
      cells: state === 'ok' && c.days > 0 ? Math.round(c.cells) : null,
      peakTemp: s && s.n > 0 && s.peak !== null ? s.peak : null,
      alerts: s ? (alertsBy.get(k.key) || 0) : null          // null = the sensor sent nothing that month
    };
  });

  const satMonths = months.filter(m => m.cells !== null);
  const busiest = satMonths.reduce((b, m) => (!b || m.cells > b.cells ? m : b), null);
  const senMonths = months.filter(m => m.alerts !== null);
  const peak = senMonths.filter(m => m.peakTemp !== null).reduce((b, m) => (!b || m.peakTemp > b.peakTemp ? m : b), null);

  return {
    place: placeName(sensor), radius: radiusKm(), satKm: satKm(),
    date: p.day + ' ' + MONTHS[p.month - 1] + ' ' + p.year,
    months, outlook,
    sat: { state, monthsWithData: satMonths.length, total: satMonths.reduce((a, m) => a + m.cells, 0), busiest },
    sensor: { monthsWithData: senMonths.length, alerts: senMonths.reduce((a, m) => a + m.alerts, 0), peak: peak ? { t: peak.peakTemp, label: peak.label } : null }
  };
}

// ---------------- the words ----------------
// The summary paragraph: built from the data alone, so it works offline. The AI may rewrite it (and only it).
function narrativeText(f) {
  const out = [];
  out.push(`This is your Enviro Sense fire-safety update for ${f.place} and the area within ${f.radius} km of it, sent on ${f.date}.`);

  if (f.sat.state === 'ok' && f.sat.monthsWithData) {
    const span = 'Across the ' + plural(f.sat.monthsWithData, 'month') + ' of satellite data listed below';
    if (f.sat.total === 0) out.push(`${span}, satellites recorded no burning within ${f.satKm} km.`);
    else {
      let t = `${span}, satellites recorded ${f.sat.total} burning cells within ${f.satKm} km`;
      if (f.sat.monthsWithData > 1 && f.sat.busiest && f.sat.busiest.cells > 0) t += `, with ${f.sat.busiest.label} the busiest month at ${f.sat.busiest.cells}`;
      out.push(t + '.');
    }
  }
  if (f.sensor.monthsWithData) {
    let t = f.sensor.alerts === 0 ? 'The Enviro Sense sensor here raised no alerts' : `The Enviro Sense sensor here raised ${plural(f.sensor.alerts, 'alert')}`;
    t += ' over the months it has been running';
    if (f.sensor.peak) t += `, and its hottest reading was ${fmtNum(f.sensor.peak.t)} °C in ${f.sensor.peak.label}`;
    out.push(t + '.');
  }

  const o = f.outlook;
  if (f.sat.state === 'out') out.push(`${f.place} is outside the downloaded satellite region, so there is no satellite outlook for it.`);
  else if (!o) out.push('There is not enough satellite history yet to give an outlook for this place.');
  else {
    let t = `For the next ${o.horizon} days, satellite history suggests ${o.peak.level.toLowerCase()} burning activity around ${f.place}`;
    t += o.peak.level === 'LOW' ? '.' : `, peaking around ${fmtDay(o.peak.d)}.`;
    out.push(t);
    if (o.trend.direction === 'above') out.push('The last two weeks ran above normal.');
    else if (o.trend.direction === 'below') out.push('The last two weeks ran below normal.');
    out.push(`Confidence is ${o.confidence}.`);
  }
  out.push('Risk levels are relative to this place’s own history. This is a statistical outlook, not an official warning.');
  return out.join(' ');
}

// Fixed, careful wording. Never written by the AI.
const STEPS_ALWAYS = [
  'Save 112 (all emergencies) and 101 (fire service) in your phone.',
  'Agree two ways out of your home or workplace, and one meeting place outside where everyone will gather.',
  'Keep exits, stairs and passages clear. Keep a bucket of water or sand, and a fire extinguisher if you have one, where you can reach them.',
  'Do not burn rubbish, leaves or crop waste. Put out cooking fires, candles and cigarettes completely.',
  'Keep your phone charged and your Enviro Sense alerts switched on.'
];
const STEP_MODERATE = 'Clear dry grass, leaves and rubbish from around your home, and keep anything that burns easily away from walls.';
const STEP_HIGH = 'Be ready to leave quickly: keep documents, medicines and a torch together in one bag by the door.';
const IF_FIRE = [
  'Get everyone out first. Do not stop to collect belongings.',
  'Once you are outside and safe, call 112 or 101.',
  'In smoke, stay low and cover your nose and mouth with a wet cloth. Close doors behind you. Do not use lifts.',
  'Go to your meeting place and check everyone is there. Tell the firefighters at once if someone is missing.',
  'Never go back inside until the fire service says it is safe.',
  'If Enviro Sense calls or messages you about fire conditions at {place}, move away from the area at once.'
];

function lines(list) { return list.map(s => '  - ' + s).join('\n'); }

function monthLine(m) {
  const sat = m.cells === null ? 'no satellite data' : 'satellite fire cells ' + m.cells;
  const sen = m.alerts === null ? 'no sensor data' : 'sensor hottest ' + (m.peakTemp === null ? 'n/a' : fmtNum(m.peakTemp) + ' °C') + ', sensor alerts ' + m.alerts;
  return '  ' + m.label + (m.current ? ' (so far)' : '') + ': ' + sat + '; ' + sen;
}

function assemble(f, narrative, ai) {
  const level = f.outlook ? f.outlook.peak.level : null;
  const steps = [...STEPS_ALWAYS];
  if (level === 'MODERATE' || level === 'HIGH') steps.push(STEP_MODERATE);
  if (level === 'HIGH') steps.push(STEP_HIGH);

  const body = [
    'Hello,',
    '',
    narrative,
    '',
    'MONTH BY MONTH, LAST ' + MONTHS_SHOWN + ' MONTHS',
    f.months.map(monthLine).join('\n'),
    '(Satellite fire cells are burning spots seen by NASA satellites within ' + f.satKm + ' km. Sensor figures come from the Enviro Sense sensor at ' + f.place + '.)',
    '',
    'WHAT TO DO NOW, BEFORE ANYTHING HAPPENS',
    lines(steps),
    '',
    'IF A FIRE BREAKS OUT',
    IF_FIRE.map((s, i) => '  ' + (i + 1) + '. ' + s.replace('{place}', f.place)).join('\n'),
    '',
    '---',
    'You get this because you have Enviro Sense alerts switched on and you live near, or regularly look at, ' + f.place + '. ' +
    'It comes on the ' + scheduleWords() + ' of each month. Turn it off any time under My alerts on the dashboard (untick "Monthly safety circular").',
    (ai ? 'The summary at the top was written by an AI (' + ai.label + ') from the figures above and checked against them. ' : '') +
    'The figures and the safety steps are fixed text. This is an automated message, not an official warning. In an emergency call 112.'
  ].join('\n');

  const subject = 'Enviro Sense: fire-safety update for ' + f.place + ' (' + f.date + ')';

  // A text message is short, so it carries the headline numbers and the three most important steps. No AI: it cannot drift.
  let sms = 'Enviro Sense safety update, ' + f.place + ': ';
  if (f.sat.state === 'ok' && f.sat.monthsWithData) sms += f.sat.total + ' satellite fire cells within ' + f.satKm + ' km in ' + plural(f.sat.monthsWithData, 'month') + '. ';
  if (f.outlook) sms += 'Next ' + f.outlook.horizon + ' days: ' + f.outlook.peak.level + '. ';
  sms += 'Save 112, know your exits, never burn waste. Not an official warning. Turn off under My alerts.';

  return { subject, body, sms };
}

// ---------------- who gets it ----------------
function regularVisitors(sensor) {
  const R = radiusKm(), since = Date.now() - visitDays() * 24 * 3600 * 1000;
  const dLat = R / 111 * 1.5, dLon = R / (111 * Math.max(0.2, Math.cos(sensor.lat * Math.PI / 180))) * 1.5;
  const rows = db().prepare('SELECT user_id, lat, lon, ts FROM view_history WHERE ts >= ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
    .all(since, sensor.lat - dLat, sensor.lat + dLat, sensor.lon - dLon, sensor.lon + dLon);
  const seen = new Map();
  for (const r of rows) {
    if (Alerts.km(sensor.lat, sensor.lon, r.lat, r.lon) > R) continue;
    const t = toMs(r.ts);
    if (!t) continue;
    if (!seen.has(r.user_id)) seen.set(r.user_id, new Set());
    seen.get(r.user_id).add(new Date(t).toISOString().slice(0, 10));
  }
  return new Set([...seen].filter(([, set]) => set.size >= minVisits()).map(([id]) => id));
}

// `seen` holds the addresses already covered by an earlier sensor in the same run, so nobody gets two circulars.
function audience(sensor, seen) {
  const R = radiusKm(), emails = new Set(), phones = new Set();
  let live = 0, visit = 0;
  const addEmail = e => { if (e && !seen.emails.has(e)) { seen.emails.add(e); emails.add(e); } };
  const addPhone = p => { if (p && !seen.phones.has(p)) { seen.phones.add(p); phones.add(p); } };

  for (const e of Alerts.adminEmails()) addEmail(e);
  addPhone(Alerts.normPhone(process.env.ADMIN_PHONE));

  const visitors = regularVisitors(sensor);
  const rows = db().prepare(
    `SELECT p.user_id, p.email_on, p.sms_on, p.phone, p.phone_verified, p.home_lat, p.home_lon, u.email, u.email_verified
     FROM alert_prefs p JOIN users u ON u.id = p.user_id
     WHERE p.circular_on = 1 AND (p.email_on = 1 OR p.sms_on = 1)`).all();
  for (const p of rows) {
    const lives = p.home_lat != null && p.home_lon != null && Alerts.km(sensor.lat, sensor.lon, p.home_lat, p.home_lon) <= R;
    const visits = visitors.has(p.user_id);
    if (!lives && !visits) continue;
    const before = emails.size + phones.size;
    if (p.email_on && p.email && p.email_verified) addEmail(p.email);
    if (p.sms_on && p.phone && p.phone_verified) addPhone(p.phone);
    if (emails.size + phones.size > before) { if (lives) live++; else visit++; }
  }
  return { emails: [...emails], phones: [...phones], live, visit };
}

// ---------------- writing and sending ----------------
async function compose(sensor, now) {
  const f = gather(sensor, now);
  const offline = narrativeText(f);
  let narrative = offline, ai = null;
  if (Brief.aiAvailable()) {
    try {
      const out = await Brief.circularText(f, offline);
      narrative = out.text; ai = { label: out.label, model: out.model };
    } catch (e) {
      console.error('AI wording for the circular was skipped:', e.message);   // the built-in summary goes out instead
    }
  }
  return { ...assemble(f, narrative, ai), ai, facts: f };
}

async function deliver(msg, aud) {
  const errors = [];
  let emails = 0, sms = 0;
  for (let i = 0; i < aud.emails.length; i += 10) {
    await Promise.all(aud.emails.slice(i, i + 10).map(async to => {
      try { await Alerts.sendEmail(to, msg.subject, msg.body); emails++; } catch (e) { errors.push('email ' + e.message); }
    }));
  }
  if (aud.phones.length) {
    try { await Alerts.sendSms(aud.phones, msg.sms); sms = aud.phones.length; } catch (e) { errors.push('sms ' + e.message); }
  }
  return { emails, sms, errors };
}

// One circular goes to one sensor's audience once per run date. The row is claimed BEFORE sending, so a second timer tick,
// a second server or a double click can never send it twice. Failed runs (nothing sent) may be retried after 30 minutes.
function claim(runDate, deviceId, now) {
  const d = db();
  const ins = d.prepare("INSERT OR IGNORE INTO circular_sent (run_date, device_id, ts, status) VALUES (?, ?, ?, 'running')").run(runDate, deviceId, now);
  if (ins.changes) return true;
  const upd = d.prepare(
    `UPDATE circular_sent SET ts = ?, status = 'running'
     WHERE run_date = ? AND device_id = ? AND ((status = 'failed' AND ts < ?) OR (status = 'running' AND ts < ?))`)
    .run(now, runDate, deviceId, now - 30 * 60 * 1000, now - 60 * 60 * 1000);
  return upd.changes > 0;
}

async function runSensor(sensor, runDate, { now = Date.now(), seen, dryRun = false } = {}) {
  const d = db();
  if (dryRun) {
    const aud = audience(sensor, { emails: new Set(seen.emails), phones: new Set(seen.phones) });
    const msg = await compose(sensor, now);
    return { device_id: sensor.device_id, dryRun: true, subject: msg.subject, body: msg.body, sms: msg.sms, ai: msg.ai,
             audience: { emails: aud.emails.length, phones: aud.phones.length, live: aud.live, visit: aud.visit } };
  }
  if (!claim(runDate, sensor.device_id, now)) return { device_id: sensor.device_id, skipped: 'already-sent' };

  const finish = (status, r, ai, details) => d.prepare('UPDATE circular_sent SET status = ?, emails = ?, sms = ?, ai = ?, details = ?, ts = ? WHERE run_date = ? AND device_id = ?')
    .run(status, r.emails, r.sms, ai ? ai.label : null, details ? String(details).slice(0, 500) : null, now, runDate, sensor.device_id);
  try {
    const aud = audience(sensor, seen);
    if (!aud.emails.length && !aud.phones.length) { finish('done', { emails: 0, sms: 0 }, null, 'nobody to send to'); return { device_id: sensor.device_id, emails: 0, sms: 0, note: 'nobody to send to' }; }
    const msg = await compose(sensor, now);
    const r = await deliver(msg, aud);
    const status = !r.errors.length ? 'done' : (r.emails || r.sms ? 'partial' : 'failed');
    finish(status, r, msg.ai, r.errors.join(' | '));
    console.log('CIRCULAR ' + runDate + ' ' + sensor.device_id + ': ' + r.emails + ' email, ' + r.sms + ' SMS' + (msg.ai ? ' (AI: ' + msg.ai.label + ')' : ' (built-in wording)') + (r.errors.length ? ', PROBLEMS: ' + r.errors.join(' | ') : ''));
    return { device_id: sensor.device_id, status, emails: r.emails, sms: r.sms, ai: msg.ai, errors: r.errors };
  } catch (e) {
    finish('failed', { emails: 0, sms: 0 }, null, e.message);
    console.error('Circular failed for ' + sensor.device_id + ':', e.message);
    return { device_id: sensor.device_id, status: 'failed', error: e.message };
  }
}

const sensors = deviceId => {
  const rows = db().prepare('SELECT device_id, label, lat, lon FROM sensors ORDER BY id').all();
  return deviceId ? rows.filter(s => s.device_id === deviceId) : rows;
};

let busy = false;
async function guarded(fn) {
  if (busy) return { busy: true };
  busy = true;
  try { return await fn(); } finally { busy = false; }
}

// The scheduled run: does nothing unless today (or a recent day within the catch-up window) is a circular day and the hour has come.
function runIfDue(now = Date.now()) {
  return guarded(async () => {
    if (!enabled()) return { ran: false, reason: 'off' };
    const due = dueDates(now);
    if (!due.length) return { ran: false, reason: 'not-due' };
    const seen = { emails: new Set(), phones: new Set() }, results = [];
    for (const s of sensors()) results.push(await runSensor(s, due[0], { now, seen }));
    return { ran: true, runDate: due[0], results };
  });
}

// Admin: send now (any day) or just preview. Manual sends have their own run date, so they never block the scheduled one.
function runNow({ deviceId, dryRun = false, now = Date.now() } = {}) {
  return guarded(async () => {
    const list = sensors(deviceId);
    if (!list.length) return { ran: false, reason: 'no-sensor' };
    const runDate = localParts(now).ymd + '-manual-' + now;
    const seen = { emails: new Set(), phones: new Set() }, results = [];
    for (const s of list) results.push(await runSensor(s, runDate, { now, seen, dryRun }));
    return { ran: true, dryRun, results };
  });
}

let timer = null;
function start() {
  if (!enabled()) return console.log('Monthly circular: OFF (CIRCULAR=0)');
  if (timer) return;
  db();
  const tick = () => runIfDue().catch(e => console.error('Circular scheduler error:', e));
  timer = setInterval(tick, CHECK_MS);
  if (timer.unref) timer.unref();
  setTimeout(tick, 20 * 1000);
  console.log('Monthly circular: ON (' + scheduleWords() + ' of each month from ' + String(sendHour()).padStart(2, '0') + ':00 ' + tz() + ', within ' + radiusKm() + ' km of each sensor)');
}
function stop() { if (timer) clearInterval(timer); timer = null; }

const history = (limit = 50) =>
  db().prepare('SELECT run_date, device_id, ts, status, emails, sms, ai, details FROM circular_sent ORDER BY ts DESC LIMIT ?').all(limit);

module.exports = {
  start, stop, runIfDue, runNow, history,
  // exposed for tests
  dueDates, localParts, gather, narrativeText, assemble, audience, compose, regularVisitors, deps, days, scheduleWords
};
