(function () {
  const $ = id => document.getElementById(id);
  const when = ms => (ms ? new Date(ms).toLocaleString('en-IN', { hour12: false }) : '-');

  async function api(url, opts) {
    const r = await fetch(url, opts);
    if (r.status === 401) { location.href = 'login.html'; throw new Error('login'); }
    if (r.status === 403) { location.href = 'dashboard.html'; throw new Error('login'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }
  const postJson = (url, body) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }

  // cells can be plain text or a ready-made element
  function table(t, head, rows, empty) {
    t.textContent = '';
    if (!rows.length) { const c = el('caption', empty); c.style.cssText = 'text-align:left;padding:8px 10px;opacity:.7'; t.append(c); return; }
    const tr = el('tr'); for (const h of head) tr.append(el('th', h));
    const thead = el('thead'); thead.append(tr);
    const tbody = el('tbody');
    for (const row of rows) {
      const r = el('tr');
      for (const cell of row) { const td = el('td'); if (cell instanceof Node) td.append(cell); else td.textContent = cell; r.append(td); }
      tbody.append(r);
    }
    t.append(thead, tbody);
  }

  const tag = (text, kind) => el('span', text, 'tag' + (kind ? ' ' + kind : ''));
  const tile = (label, value) => { const d = el('div', undefined, 'mini'); d.append(el('b', value), el('span', label)); return d; };

  async function overview() {
    const d = await api('/api/admin/overview');
    const tiles = $('tiles'); tiles.textContent = '';
    tiles.append(
      tile('users', d.users), tile('email verified', d.verified), tile('logins, last 24 h', d.logins24h),
      tile('place lookups', d.views), tile('fire alerts sent', d.alerts),
      tile('satellite rows', d.satellite.rows === null ? '-' : d.satellite.rows.toLocaleString('en-IN')),
      tile('satellite data until', d.satellite.lastDate || '-'));
    $('aiLine').textContent = d.ai;

    const box = $('sensorsBox'); box.textContent = '';
    if (!d.sensors.length) box.append(el('p', 'No sensors registered. Add one in NASA data and sensors.', 'hint'));
    for (const s of d.sensors) {
      const line = el('div', undefined, 'sensor-line');
      const dot = el('span', undefined, 'dot' + (s.incident ? ' alarm' : s.online ? ' on' : ''));
      const name = el('b'); name.append(dot, document.createTextNode(s.label || s.device_id));
      line.append(name,
        el('span', s.online ? 'Online' : s.last ? 'Offline, last seen ' + when(s.last.ts) : 'No readings yet'),
        el('span', s.last ? s.last.temperature + ' °C, ' + s.last.humidity + '% humidity, smoke ' + s.last.smoke : ''),
        el('span', 'IP ' + (s.ip || '-') + ' · ' + Number(s.lat).toFixed(3) + ', ' + Number(s.lon).toFixed(3), 'hint'));
      if (s.incident) line.append(tag('open incident', 'bad'));
      box.append(line);
    }
  }

  async function users() {
    const d = await api('/api/admin/users');
    table($('usersTbl'), ['ID', 'Username', 'Email', 'Role', 'Email verified', 'Joined', 'Last login', 'Logins', 'Lookups', 'Alerts on', ''],
      d.users.map(u => {
        const act = el('span');
        if (u.role !== 'admin') {
          const b = el('button', 'Delete', 'btn-small ghost');
          b.type = 'button';
          b.addEventListener('click', async () => {
            if (!confirm('Delete user "' + u.username + '" and their history? This cannot be undone.')) return;
            try { await postJson('/api/admin/users/delete', { id: u.id }); $('usersMsg').textContent = 'Deleted ' + u.username + '.'; refresh(); }
            catch (e) { $('usersMsg').textContent = e.message; }
          });
          act.append(b);
        }
        return [u.id, u.username, u.email || '-', u.role === 'admin' ? tag('admin', 'admin') : u.role,
          u.emailVerified ? tag('yes', 'ok') : tag('no', 'bad'), when(u.created), when(u.lastLogin), u.logins, u.views,
          [u.alerts.email ? 'email' : '', u.alerts.sms ? 'SMS' : ''].filter(Boolean).join(' + ') || '-', act];
      }), 'No users.');
  }

  async function alerts() {
    try {
      const d = await api('/api/alerts/events');
      table($('alertsTbl'), ['When', 'Type', 'Level', 'Message', 'Emails', 'SMS', 'Problem'],
        d.events.map(e => [when(e.ts), e.kind, e.level || '-', e.headline, e.emails, e.sms, e.details || '']), 'No alerts yet.');
    } catch (e) { if (e.message !== 'login') $('alertsTbl').textContent = e.message; }
  }

  async function logins() {
    const d = await api('/api/admin/logins?limit=50');
    table($('loginsTbl'), ['When', 'User', 'Mode', 'Location'], d.logins.map(l => [when(l.ts), l.user, l.mode, l.location || '-']), 'No logins yet.');
  }

  async function views() {
    const d = await api('/api/admin/views?limit=50');
    table($('viewsTbl'), ['When', 'User', 'Place', 'Mode'], d.views.map(v => [when(v.ts), v.user, v.place, v.mode]), 'No lookups yet.');
  }

  async function refresh() {
    for (const f of [overview, users, alerts, logins, views]) {
      try { await f(); } catch (e) { if (e.message === 'login') return; console.error(e); }
    }
  }

  $('refreshBtn').addEventListener('click', refresh);
  refresh();
  setInterval(() => { overview().catch(() => {}); }, 10000);        // sensor status stays fresh
})();
