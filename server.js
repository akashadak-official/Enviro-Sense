require('dotenv').config();
require('./services/bootstrap').prepare();          // checks JWT_SECRET, unpacks the seed database on an empty disk

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { ensureAdmin } = require('./db');
const { router: authRouter } = require('./auth');
const sensorRouter = require('./sensor');
const fireRouter = require('./fire');
const { router: geoRouter } = require('./geo');
const forecastRouter = require('./forecastapi');
const alertsRouter = require('./alertsapi');
const historyRouter = require('./historyapi');
const adminRouter = require('./adminapi');
const demoRouter = require('./demoapi');
const callsRouter = require('./callsapi');
const circularRouter = require('./circularapi');
const Alerts = require('./services/alerts');
const Circular = require('./services/circular');
const Demo = require('./services/demo');
const Virtual = require('./services/virtual');
const { limiter } = require('./services/ratelimit');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a host's proxy (Render and similar) set TRUST_PROXY=1 so client addresses and https are seen correctly
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.disable('x-powered-by');

ensureAdmin();

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  next();
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', project: 'Enviro Sense', time: new Date().toISOString() });
});

// Limits against guessing passwords and flooding sign-ups (per visitor address)
const TEN_MIN = 10 * 60 * 1000, ONE_HOUR = 60 * 60 * 1000;
app.use('/api/auth/login', limiter({ windowMs: TEN_MIN, max: 30 }));
app.use('/api/auth/login', limiter({
  windowMs: TEN_MIN, max: 8,
  key: req => req.ip + '|' + String((req.body && req.body.username) || '').toLowerCase().slice(0, 40)
}));
app.use('/api/auth/signup', limiter({ windowMs: ONE_HOUR, max: 20 }));
app.use(['/api/auth/verify-email', '/api/auth/resend-email', '/api/auth/forgot', '/api/auth/reset'],
        limiter({ windowMs: TEN_MIN, max: 15 }));
app.use('/api/demo/guest', limiter({ windowMs: ONE_HOUR, max: 40 }));

app.use('/api/auth', authRouter);
app.use('/api/sensor', sensorRouter);
app.use('/api/fire', fireRouter);
app.use('/api/geo', geoRouter);
app.use('/api/forecast', forecastRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/history', historyRouter);
app.use('/api/admin', adminRouter);
app.use('/api/demo', demoRouter);
app.use('/api/calls', callsRouter);
app.use('/api/circular', circularRouter);

// Optional: keep the satellite data fresh. Needs FIRMS_KEY. Only missing or provisional 5-day windows are fetched.
function autoSync() {
  const F = require('./services/firms');
  if (!process.env.FIRMS_KEY || F.getJob().running) return;
  F.syncRegion(3).catch(e => console.error('Auto-sync skipped:', e.message));
}

// Listen on all interfaces so the Raspberry Pi can reach us
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Enviro Sense running on http://localhost:${PORT}`);
  console.log(require('./services/brief').statusLine());
  console.log(require('./services/voice').statusLine());
  Alerts.start();
  Circular.start();                                  // monthly safety circular: the 1st and 15th of every month
  Demo.start();
  if (Demo.enabled() && Demo.virtualSensor()) Virtual.start();
  if (process.env.AUTO_SYNC === '1') {
    console.log('Auto-sync: ON (checks NASA for new days once a day)');
    setTimeout(autoSync, 30 * 1000);
    setInterval(autoSync, 24 * 3600 * 1000);
  }
});
