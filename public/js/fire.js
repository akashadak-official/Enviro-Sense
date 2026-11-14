const radiusSel = document.getElementById('radiusSel');
const yearSel = document.getElementById('yearSel');
const placeInput = document.getElementById('placeInput');
const suggest = document.getElementById('suggest');

let MODE = null, CONFIG = null, PLACE = null;
let polling = null, tick = 0, searchSeq = 0, searchTimer = null;

// Escape text before putting it into HTML (names come from outside)
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

// ---------------- heatmap ----------------
function renderHeat(data) {
  const heat = document.getElementById('heat');
  const months = document.getElementById('months');
  heat.innerHTML = ''; months.innerHTML = '';
  if (!data.days.length) return;

  const first = new Date(data.days[0].d + 'T00:00:00Z');
  const offset = first.getUTCDay();                           // Sunday = 0
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
  if (!PLACE) {
    renderHeat({ days: [] }); renderStats({});
    empty.textContent = 'Search for a city above, or pick one of the shortcuts.';
    return;
  }
  try {
    let q = `lat=${PLACE.lat}&lon=${PLACE.lon}&radius=${radiusSel.value}`;
    if (yearSel.value) q += `&year=${yearSel.value}`;
    const data = await api('/api/fire/calendar?' + q);

    if (data.outOfCoverage) {
      renderHeat({ days: [] }); renderStats({});
      empty.textContent = 'This location is outside the downloaded satellite region (South Asia).';
      return;
    }
    if (data.empty || !data.days.length) {
      renderHeat({ days: [] }); renderStats({});
      empty.textContent = 'No data yet. Ask an admin to run the NASA download.';
      return;
    }
    empty.textContent = '';
    document.getElementById('dataInfo').textContent =
      `Satellite data available: ${data.dataFrom} to ${data.dataTo}`;

    const wanted = data.years.join(',');
    if (yearSel.dataset.years !== wanted) {
      yearSel.innerHTML = data.years.map(y => `<option>${y}</option>`).join('');
      yearSel.dataset.years = wanted;
    }
    yearSel.value = data.year;

    renderStats(data);
    renderHeat(data);
  } catch (e) {
    if (e.message !== 'login') empty.textContent = 'Could not load the calendar: ' + e.message;
  }
}

// ---------------- sensor card ----------------
async function loadSensor() {
  const box = document.getElementById('sensorCard');
  if (!PLACE) { box.textContent = 'Select a place to see its sensor.'; return; }
  try {
    const d = await api(`/api/geo/sensor?lat=${PLACE.lat}&lon=${PLACE.lon}`);
    if (!d.sensor) {
      box.innerHTML = `<span class="dot"></span><span>No sensor registered for <b>${esc(PLACE.name)}</b>. Showing satellite data only.</span>`;
      return;
    }
    const s = d.sensor, r = s.reading;
    box.innerHTML =
      `<span class="dot ${s.online ? 'on' : 'off'}"></span><b>${esc(s.label || s.device_id)}</b>` +
      `<span class="hint">${esc(s.device_id)} | ${esc(s.ip || 'no IP')} | ${esc(s.distanceKm)} km from the place | ${s.online ? 'online' : 'offline'}</span>` +
      (r
        ? `<div class="sensor-vals"><span>Temp <b>${esc(r.temperature)}°C</b></span>` +
          `<span>Humidity <b>${esc(r.humidity)}%</b></span><span>Smoke <b>${esc(r.smoke)}</b></span>` +
          `<span>Status <b class="st-${esc(r.status)}">${esc(r.status)}</b></span>` +
          `<span class="hint">updated ${esc(s.ageSeconds)} s ago</span></div>`
        : '<span class="hint">No readings received yet</span>');
  } catch (e) {
    if (e.message !== 'login') box.textContent = 'Sensor info unavailable: ' + e.message;
  }
}

// ---------------- choosing a place ----------------
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
  await Promise.all([loadCalendar(), loadSensor()]);
}

// ---------------- search box (Global mode) ----------------
async function runSearch(q) {
  const seq = ++searchSeq;
  try {
    const d = await api('/api/geo/search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return;                  // an older, slower answer
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
      off.innerHTML = '<span class="tag">Offline: showing built-in Indian cities only</span>';
      suggest.appendChild(off);
    }
    suggest.classList.remove('hidden');
  } catch (e) { /* ignore search errors */ }
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

// ---------------- admin: NASA sync ----------------
async function pollSync() {
  const s = await api('/api/fire/sync/status');
  const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
  document.getElementById('barFill').style.width = pct + '%';

  let text = s.message;
  if (s.running) {
    let eta = '';
    if (s.done >= 6) {
      const mins = Math.ceil(s.elapsedMs / s.done * (s.total - s.done) / 60000);
      eta = `, about ${mins} min left`;
    }
    text = `Downloading... ${pct}% (${s.message}${eta}). Cells stored this run: ${s.cells.toLocaleString()}`;
  }
  if (s.error) text += '  |  last error: ' + s.error;
  document.getElementById('syncMsg').textContent = text;
  document.getElementById('syncBtn').disabled = s.running;

  if (s.running) {
    if (!polling) polling = setInterval(pollSync, 2000);
    if (++tick % 15 === 0) loadCalendar();
  } else if (polling) {
    clearInterval(polling); polling = null;
    yearSel.innerHTML = ''; yearSel.dataset.years = '';     // jump to the latest year
    loadCalendar();
  }
}

async function importFile(file, sensor) {
  if (!file) return;
  const msg = document.getElementById('syncMsg');
  msg.textContent = 'Importing ' + file.name + '...';
  try {
    const text = await file.text();
    const r = await api(`/api/fire/import?sensor=${sensor}`,
      { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
    msg.textContent = `Imported ${r.dates} days (${r.from || ''} to ${r.to || ''})`;
    loadCalendar();
  } catch (e) { msg.textContent = 'Import failed: ' + e.message; }
}

// ---------------- admin: sensor registry ----------------
async function loadSensorList() {
  const d = await api('/api/geo/sensors');
  const table = document.getElementById('sList');
  table.innerHTML = '';
  d.sensors.forEach(s => {
    const tr = document.createElement('tr');
    [s.device_id, s.label || '', s.ip || '-', s.lat.toFixed(3) + ', ' + s.lon.toFixed(3),
     s.online ? 'online' : 'offline'].forEach(v => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });
    const td = document.createElement('td');
    const b = document.createElement('button');
    b.className = 'mini'; b.textContent = 'remove';
    b.addEventListener('click', async () => {
      await api('/api/geo/sensors/' + s.id, { method: 'DELETE' });
      loadSensorList(); loadSensor();
    });
    td.appendChild(b); tr.appendChild(td);
    table.appendChild(tr);
  });
}

function setupSensorAdmin() {
  document.getElementById('sensorAdmin').classList.remove('hidden');
  const msg = document.getElementById('sMsg');
  document.getElementById('sAdd').addEventListener('click', async () => {
    if (!PLACE) { msg.textContent = 'Select a place first.'; return; }
    try {
      await post('/api/geo/sensors', {
        device_id: document.getElementById('sDev').value.trim(),
        ip: document.getElementById('sIp').value.trim(),
        label: PLACE.name + ' sensor',
        lat: PLACE.lat, lon: PLACE.lon
      });
      msg.textContent = 'Sensor registered at ' + PLACE.name;
      loadSensorList(); loadSensor();
    } catch (e) { msg.textContent = e.message; }
  });
  loadSensorList();
  setInterval(loadSensorList, 15000);
}

// ---------------- start ----------------
(async () => {
  const { user } = await api('/api/auth/me');
  CONFIG = await api('/api/geo/config');
  if (!CONFIG.mode) { window.location.href = 'index.html'; return; }
  MODE = CONFIG.mode;

  document.getElementById('whoText').textContent = user.username + ' (' + user.role + ')';
  document.getElementById('modeTag').textContent = MODE.toUpperCase();
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await post('/api/geo/logout'); } catch {}
    try { sessionStorage.clear(); } catch {}
    window.location.href = 'index.html';
  });

  radiusSel.addEventListener('change', () => { updatePlaceNow(); loadCalendar(); });
  yearSel.addEventListener('change', loadCalendar);

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
    else await loadCalendar();
  }

  if (user.role === 'admin') {
    document.getElementById('adminBox').classList.remove('hidden');
    document.getElementById('syncBtn').addEventListener('click', async () => {
      try {
        await post('/api/fire/sync', { years: Number(document.getElementById('yearsSel').value) });
        pollSync();
      } catch (e) { document.getElementById('syncMsg').textContent = e.message; }
    });
    document.getElementById('impModis').addEventListener('change', e => importFile(e.target.files[0], 'MODIS'));
    document.getElementById('impViirs').addEventListener('change', e => importFile(e.target.files[0], 'VIIRS'));
    pollSync();
    setupSensorAdmin();
  }

  setInterval(loadSensor, 5000);
})();