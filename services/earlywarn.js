'use strict';
// Short-term sensor early warning. It looks at how FAST temperature, humidity and smoke are
// changing over the last 90 seconds, so it can warn before the fixed WARNING/FIRE thresholds.
// Pure functions: no database access.

const WINDOW_MS = 90 * 1000;
const MIN_POINTS = 8;
const STALE_MS = 30 * 1000;
const LIMITS = { temp: 42, smoke: 300 };                 // mirrors the WARNING limits in sensor.js
const TRIGGER = { temp: 1.5, smoke: 40, hum: -4 };       // per minute

// Least-squares slope. points: [{ t (minutes), v }]. Returns units per minute.
function slope(points) {
  const n = points.length;
  const mt = points.reduce((s, p) => s + p.t, 0) / n;
  const mv = points.reduce((s, p) => s + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.t - mt) * (p.v - mv); den += (p.t - mt) ** 2; }
  return den ? num / den : 0;
}

// rows: [{ ts (ms), temperature, humidity, smoke, status }] oldest first
function assess(rows, now = Date.now()) {
  if (!rows || !rows.length) return { level: 'NO_DATA', signals: [] };

  const last = rows[rows.length - 1];
  const age = now - last.ts;
  const base = {
    temperature: last.temperature, humidity: last.humidity, smoke: last.smoke,
    ageSeconds: Math.round(age / 1000), sensorStatus: last.status
  };
  if (age > STALE_MS) return { level: 'OFFLINE', signals: [], ...base };

  const recent = rows.filter(r => r.ts >= now - WINDOW_MS);
  if (recent.length < MIN_POINTS) return { level: 'NO_DATA', signals: [], ...base };

  const t0 = recent[0].ts;
  const pts = key => recent.map(r => ({ t: (r.ts - t0) / 60000, v: r[key] }));
  const sT = slope(pts('temperature')), sH = slope(pts('humidity')), sS = slope(pts('smoke'));

  const signals = [];
  if (sT >= TRIGGER.temp) signals.push(`Temperature rising ${sT.toFixed(1)} °C/min`);
  if (sS >= TRIGGER.smoke) signals.push(`Smoke rising ${Math.round(sS)} per min`);
  if (sH <= TRIGGER.hum) signals.push(`Humidity falling ${Math.abs(sH).toFixed(1)} %/min`);

  const dry = last.temperature >= 33 && last.humidity <= 30;

  let level = 'NORMAL';
  if (last.status === 'FIRE') level = 'FIRE';
  else if (last.status === 'WARNING') level = 'WARNING';
  else if (signals.length >= 2) level = 'ALERT';
  else if (signals.length === 1 || dry) level = 'WATCH';

  // At the current speed, how long until the WARNING limit?
  let etaMin = null, etaWhat = null;
  if (level === 'WATCH' || level === 'ALERT') {
    const cands = [];
    if (sT > 0.05 && last.temperature < LIMITS.temp)
      cands.push({ min: (LIMITS.temp - last.temperature) / sT, what: `${LIMITS.temp}°C` });
    if (sS > 1 && last.smoke < LIMITS.smoke)
      cands.push({ min: (LIMITS.smoke - last.smoke) / sS, what: `smoke level ${LIMITS.smoke}` });
    if (cands.length) {
      cands.sort((a, b) => a.min - b.min);
      if (cands[0].min <= 30) { etaMin = Math.round(cands[0].min * 10) / 10; etaWhat = cands[0].what; }
    }
  }

  return {
    level, signals, dry, etaMin, etaWhat,
    slopes: { temperature: Math.round(sT * 100) / 100, humidity: Math.round(sH * 100) / 100, smoke: Math.round(sS * 10) / 10 },
    windowSeconds: Math.round((recent[recent.length - 1].ts - t0) / 1000),
    ...base
  };
}

module.exports = { assess, slope };
