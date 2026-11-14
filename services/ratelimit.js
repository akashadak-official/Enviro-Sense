'use strict';
// Small in-memory rate limiter (no extra packages). It resets when the server restarts.
function limiter({ windowMs, max, key, message }) {
  const hits = new Map();
  let lastSweep = Date.now();

  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
      lastSweep = now;
    }
    if (hits.size > 20000) hits.clear();                   // never grow without limit

    const k = key ? key(req) : req.ip;
    let h = hits.get(k);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    if (++h.n > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

module.exports = { limiter };
