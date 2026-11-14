const radiusSel = document.getElementById('radiusSel');
const yearSel = document.getElementById('yearSel');
const placeInput = document.getElementById('placeInput');
const suggest = document.getElementById('suggest');

let MODE = null, CONFIG = null, PLACE = null, SENSOR_ID = null;
let searchSeq = 0, searchTimer = null, resizeTimer = null, lastSeries = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, opts) {
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) { window.location.href = 'login.html'; throw new Error('login'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const post = (url, body) => api(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});

// ================= satellite calendar =================
function renderHeat(data) {
  const heat = document.getElementById('heat');
  const months = document.getElementById('months');
  heat.innerHTML = ''; months.innerHTML = '';
  if (!data.days.length) return;

  const first = new Date(data.days[0].d + 'T00:00:00Z');
  const offset = first.getUTCDay();
  for (let i = 0; i < offset; i++) heat.appendChild(document.createElement('div'));

  const vals = data.days.map(x => x.v).filter(v => v !== null && v > 0).sort((a, b) => a - b);
  const q = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 1;
  const th = [q(0.25), q(0.5), q(0.75), q(0.92)];
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  data.days.forEach((x, i) => {
    const c = document.createElement('div');
    c.className = 'cell';
    if (x.v === null) c.classList.add('nodata');
    else c.classList.add('lv' + (x.v === 0 ? 0 : 1 + th.filter(t => x.v > t).length));
    if (x.flag === 'high') c.classList.add('anom');
    if (x.flag === 'extreme') c.classList.add('extreme');

    c.title = x.d + ': ' + (x.v === null ? 'no data' : x.v + ' burning cells');
    c.addEventListener('click', () => {
      document.getElementById('detail').textContent = x.v === null
        ? `${x.d}: no satellite data`
        : `${x.d} (${data.place.name}, ${data.radius} km): ${x.v} harmonized burning cells ` +
          `(MODIS ${x.m ?? '-'}, VIIRS ${x.vi ?? '-'})` +
          (x.normal !== null ? `. Typical for this time of year: ${x.normal}` : '') +
          (x.flag ? `. ${x.flag === 'extreme' ? 'EXTREME' : 'Unusual'} (z = ${x.z})` : '');
    });
    heat.appendChild(c);

    if (x.d.endsWith('-01') || i === 0) {
      const col = Math.floor((offset + i) / 7);
      const s = document.createElement('span');
      s.style.left = col * 18 + 'px';
      s.textContent = names[Number(x.d.slice(5, 7)) - 1];
      months.appendChild(s);
    }
  });
}

function renderStats(data) {
  const box = document.getElementById('stats');
  if (!data.stats) { box.innerHTML = ''; return; }
  const s = data.stats;
  box.innerHTML = [
    [s.total, 'burning cell-days in ' + data.year],
    [s.activeDays, 'days with fire activity'],
    [s.peak ? s.peak.d : '-', 'peak day' + (s.peak ? ' (' + s.peak.v + ' cells)' : '')],
    [s.unusual, 'unusual or extreme days'],
    ['x' + data.factor, 'VIIRS to MODIS calibration']
  ].map(([b, t]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(t)}</span></div>`).join('');
}

async function loadCalendar() {
  const empty = document.getElementById('empty');
  const info = document.getElementById('dataInfo');
  const clear = msg => { renderHeat({ days: [] }); renderStats({}); info.textContent = ''; empty.textContent = msg; };

  if (!PLACE) return clear('Search for a city above, or pick one of the shortcuts.');
  try {
    let q = `lat=${PLACE.lat}&lon=${PLACE.lon}&radius=${radiusSel.value}`;
    if (yearSel.value) q += `&year=${yearSel.value}`;
    const data = await api('/api/fire/calendar?' + q);

    if (data.outOfCoverage) return clear('This location is outside the downloaded satellite region (South Asia).');
    if (data.empty || !data.days.length) return clear('No satellite data yet. Ask an admin to run the NASA download.');

    empty.textContent = '';
    info.textContent = `Satellite data available: ${data.dataFrom} to ${data.dataTo}`;

    const wanted = data.years.join(',');
    if (yearSel.dataset.years !== wanted) {
      yearSel.innerHTML = data.years.map(y => `<option>${y}</option>`).join('');
      yearSel.dataset.years = wanted;
    }
    yearSel.value = data.year;

    renderStats(data);
    renderHeat(data);
  } catch (e) {
    if (e.message !== 'login') clear('Could not load the calendar: ' + e.message);
  }
}

// ================= live sensor =================
// These thresholds mirror classify() in sensor.js on the server
const METRICS = [
  { id: 'tTemp',  key: 'temperature', unit: '°C', max: 70,   level: v => v >= 55 ? 'bad' : v >= 42 ? 'warn' : 'ok' },
  { id: 'tHum',   key: 'humidity',    unit: '%',  max: 100,  level: v => v <= 25 ? 'warn' : 'ok' },
  { id: 'tSmoke', key: 'smoke',       unit: '',   max: 1000, level: v => v >= 600 ? 'bad' : v >= 300 ? 'warn' : 'ok' },
  { id: 'tCpu',   key: 'cpu_temp',    unit: '°C', max: 100,  level: v => v >= 80 ? 'bad' : v >= 70 ? 'warn' : 'ok' }
];

function setTiles(r) {
  METRICS.forEach(m => {
    const tile = document.getElementById(m.id);
    const value = tile.querySelector('b');
    const fill = tile.querySelector('.gfill');
    tile.classList.remove('ok', 'warn', 'bad');
    if (!r) { value.textContent = '--'; fill.style.width = '0%'; return; }
    const v = r[m.key];
    value.textContent = v + m.unit;
    fill.style.width = Math.max(0, Math.min(100, v / m.max * 100)) + '%';
    tile.classList.add(m.level(v));
  });
}

function setAlert(s) {
  const bar = document.getElementById('alertBar');
  const r = s && s.online ? s.reading : null;
  if (r && r.status === 'FIRE') {
    bar.className = 'alert fire';
    bar.textContent = `🔥 FIRE detected at ${PLACE.name}: ${r.temperature}°C, smoke level ${r.smoke}`;
  } else if (r && r.status === 'WARNING') {
    bar.className = 'alert warn';
    bar.textContent = `⚠ Warning conditions at ${PLACE.name}: ${r.temperature}°C, humidity ${r.humidity}%, smoke level ${r.smoke}`;
  } else {
    bar.className = 'alert hidden';
    bar.textContent = '';
  }
}

async function loadLive() {
  const name = document.getElementById('liveName');
  const meta = document.getElementById('liveMeta');
  const pill = document.getElementById('statusPill');
  const body = document.getElementById('liveBody');
  const empty = document.getElementById('liveEmpty');

  const none = msg => {
    SENSOR_ID = null; lastSeries = null;
    name.textContent = 'Live sensor'; meta.textContent = '';
    pill.textContent = 'NO SENSOR'; pill.className = 'pill';
    body.classList.add('hidden');
    empty.textContent = msg; empty.classList.remove('hidden');
    setAlert(null);
  };

  if (!PLACE) return none('Search for a city to see its sensor.');
  try {
    const d = await api(`/api/geo/sensor?lat=${PLACE.lat}&lon=${PLACE.lon}`);
    if (!d.sensor) return none(`No sensor registered for ${PLACE.name}. Showing satellite data only.`);

    const s = d.sensor, r = s.reading;
    empty.classList.add('hidden'); body.classList.remove('hidden');
    name.textContent = s.label || s.device_id;
    meta.textContent = `${s.device_id} | ${s.ip || 'no IP'} | ${s.distanceKm} km from the place | ` +
      (r ? `updated ${s.ageSeconds} s ago` : 'no readings yet');
    body.classList.toggle('dim', !s.online);

    if (!s.online || !r) { pill.textContent = 'OFFLINE'; pill.className = 'pill'; }
    else { pill.textContent = r.status; pill.className = 'pill ' + r.status; }

    setTiles(r);
    setAlert(s);
    if (SENSOR_ID !== s.device_id) { SENSOR_ID = s.device_id; loadHistory(); }
  } catch (e) {
    if (e.message !== 'login') meta.textContent = 'Sensor info unavailable: ' + e.message;
  }
}

function drawSpark(canvas, vals, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (vals.length < 2) return;

  const min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(max - min, 1), pad = 6;
  const x = i => pad + i * (w - 2 * pad) / (vals.length - 1);
  const y = v => h - pad - (v - min) / span * (h - 2 * pad);

  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.lineTo(x(vals.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00');
  ctx.fillStyle = g; ctx.fill();

  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
}

function redraw() {
  if (!lastSeries) return;
  const range = a => a.length ? `min ${Math.min(...a).toFixed(1)}  |  max ${Math.max(...a).toFixed(1)}` : '';
  drawSpark(document.getElementById('spTemp'), lastSeries.temp, '#ff8a3d');
  drawSpark(document.getElementById('spSmoke'), lastSeries.smoke, '#3ddc97');
  document.getElementById('spTempMeta').textContent = range(lastSeries.temp);
  document.getElementById('spSmokeMeta').textContent = range(lastSeries.smoke);
}

async function loadHistory() {
  if (!SENSOR_ID) return;
  try {
    const d = await api('/api/sensor/history?hours=1&device=' + encodeURIComponent(SENSOR_ID));
    const rows = d.readings;
    const step = Math.max(1, Math.ceil(rows.length / 150));
    const pts = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
    lastSeries = { temp: pts.map(r => r.temperature), smoke: pts.map(r => r.smoke) };
    redraw();
  } catch { /* the next poll will try again */ }
}

// ================= place + search =================
function updatePlaceNow() {
  document.getElementById('placeNow').textContent = PLACE
    ? `Showing ${PLACE.name}: ${radiusSel.value} km around ${PLACE.lat.toFixed(3)}, ${PLACE.lon.toFixed(3)}`
    : '';
}

async function choosePlace(p, log = true) {
  PLACE = p;
  if (p.radius) radiusSel.value = String(p.radius);
  updatePlaceNow();
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.name === p.name));
  if (MODE === 'global') {
    try { sessionStorage.setItem('es_place', JSON.stringify(p)); } catch {}
  }
  if (log) post('/api/geo/select', MODE === 'global' ? { name: p.name, lat: p.lat, lon: p.lon } : {})
    .catch(() => {});
  await Promise.all([loadCalendar(), loadLive()]);
}

async function runSearch(q) {
  const seq = ++searchSeq;
  try {
    const d = await api('/api/geo/search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return;
    suggest.innerHTML = '';

    if (!d.results.length) {
      const none = document.createElement('div');
      none.textContent = 'No match found';
      suggest.appendChild(none);
    }
    d.results.forEach(r => {
      const label = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
      const row = document.createElement('div');
      const t = document.createElement('span');
      t.textContent = label;
      row.appendChild(t);
      if (!r.covered) {
        const tag = document.createElement('span');
        tag.className = 'tag'; tag.textContent = 'no satellite data';
        row.appendChild(tag);
      }
      row.addEventListener('mousedown', e => {
        e.preventDefault();
        suggest.classList.add('hidden');
        placeInput.value = label;
        choosePlace({ name: r.name + (r.admin1 ? ', ' + r.admin1 : ''), lat: r.lat, lon: r.lon });
      });
      suggest.appendChild(row);
    });
    if (d.offline) {
      const off = document.createElement('div');
      const tag = document.createElement('span');
      tag.className = 'tag'; tag.textContent = 'Offline: showing built-in Indian cities only';
      off.appendChild(tag);
      suggest.appendChild(off);
    }
    suggest.classList.remove('hidden');
  } catch { /* ignore search errors */ }
}

function setupSearch() {
  placeInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = placeInput.value.trim();
    if (q.length < 2) { suggest.classList.add('hidden'); return; }
    searchTimer = setTimeout(() => runSearch(q), 300);
  });
  placeInput.addEventListener('blur', () => setTimeout(() => suggest.classList.add('hidden'), 150));

  const chips = document.getElementById('chips');
  CONFIG.presets.slice(0, 8).forEach(p => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.dataset.name = p.name; b.textContent = p.name;
    b.addEventListener('click', () => {
      placeInput.value = '';
      choosePlace({ name: p.name, lat: p.lat, lon: p.lon, radius: p.radius });
    });
    chips.appendChild(b);
  });
}

// ================= start =================
(async () => {
  const { user } = await api('/api/auth/me');
  CONFIG = await api('/api/geo/config');
  if (!CONFIG.mode) { window.location.href = 'index.html'; return; }
  MODE = CONFIG.mode;

  document.getElementById('whoText').textContent = user.username + ' (' + user.role + ')';
  document.getElementById('modeTag').textContent = MODE.toUpperCase();
  if (user.role === 'admin') document.getElementById('adminLink').classList.remove('hidden');

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await post('/api/geo/logout'); } catch {}
    try { sessionStorage.clear(); } catch {}
    window.location.href = 'index.html';
  });

  radiusSel.addEventListener('change', () => { updatePlaceNow(); loadCalendar(); });
  yearSel.addEventListener('change', loadCalendar);
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redraw, 150); });

  if (MODE === 'local') {
    document.getElementById('lockedBox').classList.remove('hidden');
    document.getElementById('lockedName').textContent = CONFIG.local.name;
    await choosePlace({ name: CONFIG.local.name, lat: CONFIG.local.lat, lon: CONFIG.local.lon });
  } else {
    document.getElementById('searchBox').classList.remove('hidden');
    setupSearch();
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('es_place')); } catch {}
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) await choosePlace(saved, false);
    else { await loadCalendar(); await loadLive(); }
  }

  setInterval(loadLive, 5000);
  setInterval(loadHistory, 10000);
})();