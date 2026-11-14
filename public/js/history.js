(function () {
  const $ = id => document.getElementById(id);
  const when = ms => (ms ? new Date(ms).toLocaleString('en-IN', { hour12: false }) : '-');

  async function api(url, opts) {
    const r = await fetch(url, opts);
    if (r.status === 401) { location.href = 'login.html'; throw new Error('login'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }

  function table(el, head, rows, empty) {
    el.textContent = '';
    if (!rows.length) { const p = document.createElement('caption'); p.textContent = empty; p.style.cssText = 'text-align:left;padding:8px 10px;opacity:.7'; el.append(p); return; }
    const thead = document.createElement('thead'), tr = document.createElement('tr');
    for (const h of head) { const th = document.createElement('th'); th.textContent = h; tr.append(th); }
    thead.append(tr);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const r = document.createElement('tr');
      for (const cell of row) { const td = document.createElement('td'); td.textContent = cell; r.append(td); }
      tbody.append(r);
    }
    el.append(thead, tbody);
  }

  function tile(label, value) {
    const d = document.createElement('div'); d.className = 'mini';
    const b = document.createElement('b'); b.textContent = value;
    const s = document.createElement('span'); s.textContent = label;
    d.append(b, s); return d;
  }

  async function load() {
    try {
      const d = await api('/api/history/me');
      $('whoText').textContent = d.user.username + (d.user.role === 'admin' ? ' (admin)' : '');

      const places = new Set(d.views.map(v => v.place));
      const tiles = $('tiles'); tiles.textContent = '';
      tiles.append(tile('place lookups', d.totalViews), tile('different places', places.size),
                   tile('logins', d.logins.length), tile('last login', d.logins[0] ? when(d.logins[0].ts) : '-'));

      table($('viewsTbl'), ['When', 'Place', 'Mode', 'Latitude', 'Longitude'],
        d.views.map(v => [when(v.ts), v.place, v.mode, v.lat != null ? Number(v.lat).toFixed(4) : '-', v.lon != null ? Number(v.lon).toFixed(4) : '-']),
        'No places yet. Look up a place on the dashboard and it will show here.');
      $('viewsNote').textContent = d.totalViews > d.views.length ? 'Showing the latest ' + d.views.length + ' of ' + d.totalViews + '.' : '';

      table($('loginsTbl'), ['When', 'Mode', 'Location'], d.logins.map(l => [when(l.ts), l.mode, l.location || '-']), 'No logins recorded.');
    } catch (e) { if (e.message !== 'login') $('viewsNote').textContent = e.message; }
  }

  $('clearBtn').addEventListener('click', async () => {
    if (!confirm('Delete your place history? Your logins stay.')) return;
    try {
      const r = await api('/api/history/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      $('clearMsg').textContent = 'Removed ' + r.removed + ' entries.';
      load();
    } catch (e) { $('clearMsg').textContent = e.message; }
  });

  load();
})();
