const { db } = require('../db');

db.exec(`
  CREATE TABLE IF NOT EXISTS fire_cells (
    cy INTEGER NOT NULL, cx INTEGER NOT NULL,
    date TEXT NOT NULL, sensor TEXT NOT NULL,
    frp REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (cy, cx, date, sensor)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_cells_sd ON fire_cells (sensor, date);

  CREATE TABLE IF NOT EXISTS fire_cell_windows (
    sensor TEXT NOT NULL, start TEXT NOT NULL, span INTEGER NOT NULL,
    source TEXT, rows INTEGER, fetched_at INTEGER,
    PRIMARY KEY (sensor, start)
  );
`);

// west, south, east, north: one box over South Asia
const COVERAGE = [68.0, 6.5, 97.5, 36.0];
const WINDOW = 5;                 // FIRMS accepts at most 5 days per request
const ANCHOR = '2020-01-01';      // windows are aligned to this date so re-runs resume
const SOURCES = {
  MODIS: ['MODIS_SP', 'MODIS_NRT'],
  VIIRS: ['VIIRS_SNPP_SP', 'VIIRS_SNPP_NRT']
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);
function addDays(str, n) {
  const d = new Date(str + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
function alignUp(dateStr) {
  const n = daysBetween(ANCHOR, dateStr);
  return addDays(ANCHOR, Math.ceil(n / WINDOW) * WINDOW);
}

// Same confidence rule for both sensors
function confOk(sensor, raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (sensor === 'MODIS') return Number(v) >= 30;
  return v.startsWith('n') || v.startsWith('h');      // nominal / high
}

// CSV text -> unique ~1 km cells per day
function aggregateCells(text, sensor) {
  const cells = new Map();
  let rows = 0, maxDate = '';
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) return { cells, rows, maxDate };

  const head = lines[0].split(',').map(s => s.trim());
  const ix = n => head.indexOf(n);
  const iLat = ix('latitude'), iLon = ix('longitude'), iDate = ix('acq_date');
  const iConf = ix('confidence'), iFrp = ix('frp'), iType = ix('type');
  if (iLat < 0 || iLon < 0 || iDate < 0 || iConf < 0)
    throw new Error('Unexpected CSV columns: ' + head.join(','));

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < head.length) continue;
    rows++;
    const date = c[iDate].trim();
    if (date > maxDate) maxDate = date;

    if (iType >= 0 && c[iType].trim() !== '0') continue;   // vegetation fires only
    if (!confOk(sensor, c[iConf])) continue;
    const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const cy = Math.round(lat * 100), cx = Math.round(lon * 100);   // ~1 km grid
    const key = date + '|' + cy + '|' + cx;
    const frp = Number(c[iFrp]) || 0;
    const prev = cells.get(key);
    if (!prev) cells.set(key, { date, cy, cx, frp });
    else if (frp > prev.frp) prev.frp = frp;
  }
  return { cells, rows, maxDate };
}

let factorCache = null;
const invalidate = () => { factorCache = null; };

const saveWindow = db.transaction((sensor, start, span, source, rows, cells, replace) => {
  if (replace) {
    db.prepare('DELETE FROM fire_cells WHERE sensor = ? AND date BETWEEN ? AND ?')
      .run(sensor, start, addDays(start, span - 1));
  }
  const ins = db.prepare(
    'INSERT OR REPLACE INTO fire_cells (cy, cx, date, sensor, frp) VALUES (?, ?, ?, ?, ?)');
  for (const c of cells.values()) ins.run(c.cy, c.cx, c.date, sensor, c.frp);
  db.prepare(`INSERT OR REPLACE INTO fire_cell_windows (sensor, start, span, source, rows, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(sensor, start, span, source, rows, Date.now());
});

// ---------- background sync job ----------
let job = { running: false, done: 0, total: 0, failed: 0, cells: 0, message: 'Idle', error: null };
const getJob = () => ({ ...job, elapsedMs: job.startedAt ? Date.now() - job.startedAt : 0 });

const LIMIT_RE = /transaction|rate limit|exceed|too many/i;

async function fetchCsv(source, bbox, days, date) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${process.env.FIRMS_KEY}` +
              `/${source}/${bbox.join(',')}/${days}/${date}`;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
      const text = await res.text();
      if (res.ok && text.trim() === '') return '';
      if (!res.ok || !text.startsWith('latitude'))
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt === 4) break;
      const limited = LIMIT_RE.test(e.message);
      if (limited) job.message = 'FIRMS rate limit reached, waiting 65 s...';
      await sleep(limited ? 65000 : 2000 * attempt);
    }
  }
  throw lastErr;
}

async function syncRegion(years = 3) {
  if (job.running) throw new Error('A sync is already running');
  if (!process.env.FIRMS_KEY) throw new Error('FIRMS_KEY is missing in .env');

  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const endStr = iso(end);
  const start = new Date(end); start.setUTCFullYear(start.getUTCFullYear() - years);

  const windows = [];
  for (let s = alignUp(iso(start)); s <= endStr; s = addDays(s, WINDOW)) windows.push(s);

  job = { running: true, years, done: 0, total: windows.length * 2, failed: 0, cells: 0,
          message: 'Starting...', error: null, startedAt: Date.now() };

  (async () => {
    let consecutive = 0;
    try {
      for (const wStart of windows) {
        const span = Math.min(WINDOW, daysBetween(wStart, endStr) + 1);
        const wEnd = addDays(wStart, span - 1);

        for (const sensor of ['MODIS', 'VIIRS']) {
          job.message = `${wStart} ${sensor}`;

          const have = db.prepare('SELECT span, source FROM fire_cell_windows WHERE sensor=? AND start=?')
                         .get(sensor, wStart);
          if (have && span === WINDOW && have.span === WINDOW && have.source === 'SP') {
            job.done++; continue;                       // finished with final (SP) data
          }

          try {
            const [spSrc, nrtSrc] = SOURCES[sensor];
            let used = 'SP';
            let agg = aggregateCells(await fetchCsv(spSrc, COVERAGE, span, wStart), sensor);

            // SP lags by months: if it lacks the last days, try near-real-time data
            if (agg.rows === 0 || agg.maxDate < wEnd) {
              await sleep(300);
              const a2 = aggregateCells(await fetchCsv(nrtSrc, COVERAGE, span, wStart), sensor);
              if (a2.rows > 0 && a2.maxDate >= agg.maxDate) { agg = a2; used = 'NRT'; }
            }

            if (agg.rows === 0) { job.done++; continue; }   // nothing yet: leave as "no data"
            saveWindow(sensor, wStart, span, used, agg.rows, agg.cells, true);
            job.cells += agg.cells.size;
            consecutive = 0;
          } catch (e) {
            job.failed++; consecutive++; job.error = e.message;
            if (consecutive >= 5) throw new Error('Too many failures. Last error: ' + e.message);
          }
          job.done++;
          await sleep(500);                             // stay polite to the API
        }
      }
      job.message = job.failed
        ? `Finished with ${job.failed} failed windows (click the button again to retry them)`
        : 'Finished';
    } catch (e) {
      job.message = 'Stopped';
      job.error = e.message;
    }
    invalidate();
    job.running = false;
  })();
}

// ---------- offline import (CSV must cover the whole region) ----------
function importCsv(sensor, text) {
  const { cells, rows } = aggregateCells(text, sensor);
  if (!cells.size) return { dates: 0, rows };
  const dates = [...new Set([...cells.values()].map(c => c.date))].sort();
  const span = daysBetween(dates[0], dates[dates.length - 1]) + 1;
  saveWindow(sensor, dates[0], span, 'CSV', rows, cells, false);
  invalidate();
  return { dates: dates.length, rows, from: dates[0], to: dates[dates.length - 1] };
}

// ---------- reading ----------
function coverageSets() {
  const out = { MODIS: new Set(), VIIRS: new Set() };
  for (const w of db.prepare('SELECT sensor, start, span FROM fire_cell_windows').all())
    for (let i = 0; i < w.span; i++) out[w.sensor].add(addDays(w.start, i));
  return out;
}

// VIIRS -> MODIS calibration over the whole region and the overlap period
function calibration() {
  if (factorCache !== null) return factorCache;
  const cov = coverageSets();
  let f = 1;
  if (cov.MODIS.size && cov.VIIRS.size) {
    const m = [...cov.MODIS].sort(), v = [...cov.VIIRS].sort();
    const lo = m[0] > v[0] ? m[0] : v[0];
    const hi = m[m.length - 1] < v[v.length - 1] ? m[m.length - 1] : v[v.length - 1];
    if (lo <= hi) {
      const q = db.prepare('SELECT COUNT(*) n FROM fire_cells WHERE sensor = ? AND date BETWEEN ? AND ?');
      const nm = q.get('MODIS', lo, hi).n, nv = q.get('VIIRS', lo, hi).n;
      if (nm > 0 && nv > 0) f = nm / nv;
    }
  }
  factorCache = f;
  return f;
}

// "date|sensor" -> number of burning cells inside a box around a point
function boxCounts(lat, lon, radiusKm) {
  const dlat = radiusKm / 111;
  const dlon = radiusKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const rows = db.prepare(`
    SELECT date, sensor, COUNT(*) AS cells FROM fire_cells
    WHERE cy BETWEEN ? AND ? AND cx BETWEEN ? AND ?
    GROUP BY date, sensor`)
    .all(Math.round((lat - dlat) * 100), Math.round((lat + dlat) * 100),
         Math.round((lon - dlon) * 100), Math.round((lon + dlon) * 100));
  const m = new Map();
  for (const r of rows) m.set(r.date + '|' + r.sensor, r.cells);
  return m;
}

module.exports = {
  COVERAGE, WINDOW, syncRegion, getJob, importCsv,
  coverageSets, calibration, boxCounts, addDays, iso
};