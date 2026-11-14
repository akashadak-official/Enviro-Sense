'use strict';
// A built-in simulated sensor for the online demo (VIRTUAL_SENSOR=1), so the live panel works
// without the Raspberry Pi. It behaves like pi/simulator.py. If a real sensor is sending readings
// for the same device, this one stays quiet.
const { db } = require('../db');

const DEVICE = 'haldia-01';
const LOCATION = 'Haldia';
const FIRE_MS = 40 * 1000;
const SMOLDER_MS = 240 * 1000;
const COOLDOWN_MS = 3 * 60 * 1000;        // visitors can start a demo event every 3 minutes at most
const KEEP_DAYS = Number(process.env.KEEP_READING_DAYS) || 3;

let fireStart = 0, smolderStart = 0, lastTrigger = 0, lastOwnTs = 0;
let timers = [];

const rnd = (a, b) => a + Math.random() * (b - a);
const r1 = x => Math.round(x * 10) / 10;

function classify(t, h, s) {                // same rule as sensor.js
  if (s >= 600 || t >= 55) return 'FIRE';
  if (s >= 300 || t >= 42 || (t >= 35 && h <= 25)) return 'WARNING';
  return 'NORMAL';
}

function makeReading(now) {
  const ist = new Date(now + 5.5 * 3600 * 1000);
  const hour = ist.getUTCHours() + ist.getUTCMinutes() / 60;

  let temp = 29 + 6 * Math.sin((hour - 9) / 24 * 2 * Math.PI) + rnd(-0.6, 0.6);
  let hum = 72 - (temp - 23) * 2.2 + rnd(-2, 2);
  let smoke = 60 + rnd(-15, 25);

  if (fireStart && now - fireStart < FIRE_MS) {
    const el = (now - fireStart) / 1000;
    const k = Math.min(1, el / 12);                       // ramps up over about 12 s
    temp += 22 * k + rnd(0, 2);
    hum -= 30 * k;
    smoke += 700 * k + rnd(-40, 60);
  } else if (fireStart && now - fireStart >= FIRE_MS) fireStart = 0;

  if (smolderStart) {
    const el = now - smolderStart;
    if (el < SMOLDER_MS + 20000) {
      const f = Math.min(1, el / SMOLDER_MS);
      temp += 16 * f; hum -= 22 * f; smoke += 330 * f + rnd(-10, 20);
    } else smolderStart = 0;
  }

  temp = r1(temp); hum = r1(Math.max(5, Math.min(100, hum))); smoke = r1(Math.max(0, smoke));
  return { temp, hum, smoke, cpu: r1(45 + rnd(-2, 3)) };
}

function tick(now = Date.now()) {
  const last = db.prepare('SELECT ts FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1').get(DEVICE);
  if (last && last.ts !== lastOwnTs && now - last.ts < 30000) return false;     // a real sensor is reporting

  const r = makeReading(now);
  db.prepare(`INSERT INTO readings (device_id, location, temperature, humidity, smoke, cpu_temp, status, ts)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(DEVICE, LOCATION, r.temp, r.hum, r.smoke, r.cpu, classify(r.temp, r.hum, r.smoke), now);
  lastOwnTs = now;
  return true;
}

// kind: 'fire' or 'smolder'. Visitors are limited by a cooldown; the admin is not.
function trigger(kind, { force = false } = {}, now = Date.now()) {
  if (kind !== 'fire' && kind !== 'smolder') return { ok: false, error: 'Unknown demo event' };
  const wait = COOLDOWN_MS - (now - lastTrigger);
  if (!force && wait > 0) return { ok: false, wait: Math.ceil(wait / 1000), error: 'A demo event was started a moment ago. Try again in ' + Math.ceil(wait / 1000) + ' s.' };
  lastTrigger = now;
  if (kind === 'fire') fireStart = now; else smolderStart = now;
  return { ok: true, message: kind === 'fire'
    ? 'A fast fire has started at the Haldia sensor. Watch the live panel and the alert banner (about 40 seconds).'
    : 'A slow burn has started at the Haldia sensor. The early warning should appear first, then the warning (about 4 minutes).' };
}

function prune() {
  try { db.prepare('DELETE FROM readings WHERE ts < ?').run(Date.now() - KEEP_DAYS * 86400000); }
  catch (e) { console.error('Could not prune old readings:', e.message); }
}

function start() {
  if (timers.length) return;
  prune();
  timers.push(setInterval(() => { try { tick(); } catch (e) { console.error('Virtual sensor:', e.message); } }, 5000));
  timers.push(setInterval(prune, 3600 * 1000));
  console.log('Virtual sensor: ON (simulated ' + DEVICE + ', readings every 5 s)');
}

function stop() { timers.forEach(clearInterval); timers = []; }

module.exports = { start, stop, tick, trigger, makeReading, classify, DEVICE, COOLDOWN_MS };
