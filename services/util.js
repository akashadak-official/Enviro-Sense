'use strict';
// Timestamps in the database can be milliseconds, seconds, or text like "2026-11-02 19:00:14" (UTC).
// toMs() turns any of them into milliseconds, or null.
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
  const iso = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// Constant-time comparison of a secret sent by a caller (a header) with the real one from .env.
// False when the real secret is not set, so an unset key can never be "guessed" with an empty header.
const crypto = require('crypto');
function safeEqual(given, real) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(String(real || ''));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { toMs, safeEqual };
