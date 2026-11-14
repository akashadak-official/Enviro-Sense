const express = require('express');
const { requireAuth } = require('./auth');
const { limiter } = require('./services/ratelimit');
const { safeEqual } = require('./services/util');
const Circular = require('./services/circular');

// Monthly safety circular (sent by the server itself on the 1st and 15th; see services/circular.js).
//   GET  /api/circular/preview?device_id=   admin: the message and how many people it would reach. Sends nothing.
//   POST /api/circular/send                 admin: send it now to one sensor's audience ({ device_id }) or all sensors. { dryRun: true } = preview
//   GET  /api/circular/history              admin: what went out and when
//   POST /api/circular/run-due              header x-cron-key: <CRON_KEY>. For an outside timer (cron-job.org and similar) on hosts
//                                           that put the server to sleep: it only sends if today is a circular day and it has not gone out yet.
const router = express.Router();

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

router.get('/preview', requireAuth, adminOnly, async (req, res) => {
  try {
    const r = await Circular.runNow({ deviceId: req.query.device_id ? String(req.query.device_id) : undefined, dryRun: true });
    if (r.busy) return res.status(409).json({ error: 'A circular is being prepared right now. Try again in a moment.' });
    if (!r.ran) return res.status(404).json({ error: 'No sensor is registered' });
    res.json(r);
  } catch (e) {
    console.error('Circular /preview:', e);
    res.status(500).json({ error: 'Could not prepare the preview' });
  }
});

router.post('/send', requireAuth, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await Circular.runNow({ deviceId: b.device_id ? String(b.device_id) : undefined, dryRun: b.dryRun === true });
    if (r.busy) return res.status(409).json({ error: 'A circular is being sent right now. Try again in a moment.' });
    if (!r.ran) return res.status(404).json({ error: 'No sensor is registered' });
    res.json(r);
  } catch (e) {
    console.error('Circular /send:', e);
    res.status(500).json({ error: 'The circular could not be sent' });
  }
});

router.get('/history', requireAuth, adminOnly, (req, res) => {
  try { res.json({ runs: Circular.history(50) }); }
  catch (e) { console.error('Circular /history:', e); res.status(500).json({ error: 'Could not load the history' }); }
});

router.post('/run-due', limiter({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res) => {
  if (!safeEqual(req.get('x-cron-key'), process.env.CRON_KEY)) return res.status(401).json({ error: 'Invalid cron key' });
  try {
    const r = await Circular.runIfDue();
    // only counts go back to the caller, never addresses or message text
    res.json({
      ran: !!r.ran, busy: !!r.busy, reason: r.reason || null, runDate: r.runDate || null,
      results: (r.results || []).map(x => ({ device_id: x.device_id, status: x.status || x.skipped || null, emails: x.emails || 0, sms: x.sms || 0 }))
    });
  } catch (e) {
    console.error('Circular /run-due:', e);
    res.status(500).json({ error: 'The scheduled run failed' });
  }
});

module.exports = router;
