// Step 10: fire-risk outlook, sensor early warning and briefing for the dashboard.
// Load this file AFTER dashboard.js: it reuses dashboard.js's globals api(), post(), esc(), PLACE and radiusSel.
(function () {
  const $ = id => document.getElementById(id);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = d => MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + Number(d.slice(8, 10));
  const num = x => String(Math.round(x * 10) / 10);

  let lastKey = '', outlookSeq = 0, briefSeq = 0, earlySeq = 0;
  let ewLevel = null, useAi = false, aiAvailable = false, aiLabel = 'AI';

  const bodyForPlace = () => ({ lat: PLACE.lat, lon: PLACE.lon, name: PLACE.name, radius: Number(radiusSel.value) });
  const query = () => 'lat=' + PLACE.lat + '&lon=' + PLACE.lon + '&radius=' + radiusSel.value +
                      '&name=' + encodeURIComponent(PLACE.name);

  // ---------------- outlook ----------------
  function setPill(level) {
    const pill = $('fcLevel');
    pill.textContent = level || '--';
    pill.className = 'pill' + (level ? ' ' + level : '');
  }

  function showMessage(text) {
    $('fcSummary').textContent = text;
    $('fcChart').innerHTML = '';
    $('fcLegend').classList.add('hidden');
    $('fcNotes').textContent = '';
    $('fcBacktest').textContent = '';
    setPill(null);
  }

  function drawChart(o) {
    const box = $('fcChart');
    box.innerHTML = '';
    const top = Math.max(1, ...o.days.map(x => (x.high !== null ? x.high : 0))) * 1.1;
    const pct = v => Math.max(0, Math.min(100, v / top * 100));
    const bars = [];

    o.days.forEach((x, i) => {
      const col = document.createElement('div');
      col.className = 'fc-col ' + (x.level || 'none');
      const plot = document.createElement('div');
      plot.className = 'fc-plot';

      let tip;
      if (x.mean === null) {
        tip = fmt(x.d) + ': no estimate (no earlier seasons to compare with)';
      } else {
        const range = document.createElement('div');
        range.className = 'fc-range';
        range.style.bottom = pct(x.low) + '%';
        range.style.height = Math.max(2, pct(x.high) - pct(x.low)) + '%';
        const bar = document.createElement('div');
        bar.className = 'fc-bar';
        bar.style.height = '0%';
        bars.push([bar, pct(x.mean)]);
        const norm = document.createElement('div');
        norm.className = 'fc-norm';
        norm.style.bottom = pct(x.normal) + '%';
        plot.append(range, bar, norm);
        tip = fmt(x.d) + ': ' + x.level.toLowerCase() + ' risk, about ' + num(x.mean) + ' burning cells (likely ' +
              num(x.low) + ' to ' + num(x.high) + '), typical for the season ' + num(x.normal);
      }
      col.title = tip;
      col.setAttribute('role', 'img');
      col.setAttribute('aria-label', tip);

      const lab = document.createElement('div');
      lab.className = 'fc-lab';
      lab.textContent = (i === 0 || x.d.endsWith('-01')) ? fmt(x.d) : String(Number(x.d.slice(8, 10)));
      col.append(plot, lab);
      box.appendChild(col);
    });
    // grow the bars after they are in the page, so the CSS transition plays
    requestAnimationFrame(() => requestAnimationFrame(() => bars.forEach(([b, h]) => { b.style.height = h + '%'; })));
    $('fcLegend').classList.remove('hidden');
  }

  function renderOutlook(o) {
    aiAvailable = !!o.aiAvailable;
    aiLabel = o.aiLabel || 'AI';
    $('briefAi').textContent = useAi ? 'Refresh with ' + aiLabel : 'Ask ' + aiLabel + ' to write it';
    $('briefAi').classList.toggle('hidden', !aiAvailable);

    if (o.outOfCoverage) return showMessage('This location is outside the downloaded satellite region (South Asia), so there is no satellite outlook for it.');
    if (o.empty) return showMessage('No satellite data yet. Ask an admin to run the NASA download.');
    if (o.tooLittle) return showMessage('There is not enough satellite history for this place yet.');
    if (o.noBaseline) return showMessage('No earlier seasons are available to compare these dates with.');

    const p = o.peak, c = o.counts;
    let s = 'Next ' + o.horizon + ' days: ' + c.HIGH + ' high, ' + c.MODERATE + ' moderate, ' + c.LOW + ' low. ';
    s += p.level === 'LOW'
      ? 'No elevated burning is expected.'
      : 'Peak around ' + fmt(p.d) + ' (about ' + num(p.mean) + ' burning cells a day, likely ' + num(p.low) + ' to ' + num(p.high) + ').';
    if (o.trend.direction !== 'near')
      s += ' The last two weeks ran ' + o.trend.direction + ' normal (about ' + o.trend.ratio + ' times the usual).';
    $('fcSummary').textContent = s;
    setPill(p.level);
    drawChart(o);

    const notes = o.notes.slice();
    notes.push('Levels are relative to this place’s own history: MODERATE from ' + o.thresholds.moderate +
               ' cells a day, HIGH from ' + o.thresholds.high + '. Confidence: ' + o.confidence +
               ' (' + o.seasonsUsed + ' earlier season' + (o.seasonsUsed === 1 ? '' : 's') + ').');
    $('fcNotes').textContent = notes.join(' ');

    const b = o.backtest;
    if (!b) { $('fcBacktest').textContent = ''; return; }
    const verdict = { better: 'better than both simple baselines', similar: 'about the same as the best simple baseline',
                      worse: 'worse than a simple baseline', 'n/a': 'too little activity here to judge' }[b.verdict];
    $('fcBacktest').textContent = 'Backtest, last ' + b.spanDays + ' days (' + b.forecasts + ' forecasts): average error ' +
      b.maeModel + ' cells a day, against ' + b.maeSeasonal + ' for seasonal-only and ' + b.maePersistence +
      ' for “same as last week”, which is ' + verdict + '. The likely range held the real value ' +
      Math.round(b.rangeCoverage * 100) + '% of the time.';
  }

  async function loadOutlook() {
    const seq = ++outlookSeq;
    $('fcSummary').textContent = 'Calculating outlook...';
    try {
      const o = await api('/api/forecast/outlook?' + query());
      if (seq === outlookSeq) renderOutlook(o);
    } catch (e) {
      if (seq === outlookSeq && e.message !== 'login') showMessage('Could not load the outlook: ' + e.message);
    }
  }

  // ---------------- sensor early warning ----------------
  const EW_TITLE = { NORMAL: 'Early warning: stable', WATCH: 'Early warning: WATCH', ALERT: 'EARLY WARNING',
                     WARNING: 'Sensor warning limits exceeded', FIRE: 'Sensor fire limits exceeded' };

  function renderEarly(w) {
    const box = $('ewBox');
    if (!w || !EW_TITLE[w.level]) { box.className = 'ew hidden'; box.textContent = ''; return; }

    box.className = 'ew ' + w.level;
    box.textContent = '';
    const head = document.createElement('b');
    head.textContent = EW_TITLE[w.level];
    const text = document.createElement('span');

    if (w.level === 'NORMAL') {
      const sg = n => (n >= 0 ? '+' : '') + n;
      text.textContent = 'Temperature ' + sg(w.slopes.temperature) + ' °C/min, smoke ' + sg(w.slopes.smoke) + ' per min.';
    } else if (w.level === 'WARNING' || w.level === 'FIRE') {
      text.textContent = 'Temperature ' + w.temperature + '°C, humidity ' + w.humidity + '%, smoke level ' + w.smoke + '.';
    } else {
      let t = w.signals.length ? w.signals.join(' · ') : 'Hot and dry conditions (' + w.temperature + '°C, ' + w.humidity + '% humidity)';
      if (w.etaMin) t += '. At this speed the ' + w.etaWhat + ' warning limit could be reached in about ' +
                         (w.etaMin < 1 ? 'under a minute' : num(w.etaMin) + ' min');
      text.textContent = t + '.';
    }
    box.append(head, text);
  }

  async function loadEarly() {
    if (typeof PLACE === 'undefined' || !PLACE) return;
    const seq = ++earlySeq;
    try {
      const d = await api('/api/forecast/sensor?' + query());
      if (seq !== earlySeq) return;
      renderEarly(d.warning);

      const level = d.warning ? d.warning.level : null;
      if (ewLevel !== null && level !== ewLevel) {        // the sensor state changed
        if (useAi) $('briefNote').textContent = 'The sensor status changed. Press the AI button again for an updated briefing.';
        else loadBrief(false);
      }
      ewLevel = level;
    } catch (e) { /* the next poll will try again */ }
  }

  // ---------------- briefing ----------------
  async function loadBrief(ai) {
    const seq = ++briefSeq;
    const text = $('briefText'), btn = $('briefAi');
    text.classList.add('busy');
    btn.disabled = true;
    if (ai) $('briefNote').textContent = 'Asking ' + aiLabel + '... (the first answer from a local model can take a minute)';
    try {
      const r = await post('/api/forecast/brief', Object.assign(bodyForPlace(), { ai: !!ai }));
      if (seq !== briefSeq) return;
      text.textContent = r.text;
      useAi = r.source === 'ai';
      if (r.label) aiLabel = r.label;
      $('briefSource').textContent = useAi
        ? 'Written by ' + aiLabel + ' (' + r.model + ')' + (r.cached ? ', cached' : '')
        : 'Offline briefing (built in, no internet needed)';
      $('briefNote').textContent = r.note || '';
      btn.textContent = useAi ? 'Refresh with ' + aiLabel : 'Ask ' + aiLabel + ' to write it';
    } catch (e) {
      if (seq === briefSeq && e.message !== 'login') $('briefNote').textContent = e.message;
    }
    if (seq === briefSeq) { text.classList.remove('busy'); btn.disabled = false; }
  }

  // ---------------- wiring ----------------
  async function onPlaceChange() {
    useAi = false; ewLevel = null;
    $('briefNote').textContent = '';
    $('briefAi').textContent = 'Ask ' + aiLabel + ' to write it';
    await loadOutlook();
    loadEarly();
    loadBrief(false);
  }

  $('briefAi').addEventListener('click', () => loadBrief(true));

  // dashboard.js changes PLACE when the person picks a city or a radius: notice it here
  setInterval(() => {
    try {
      if (typeof PLACE === 'undefined' || !PLACE) return;
      const key = PLACE.lat + '|' + PLACE.lon + '|' + radiusSel.value;
      if (key !== lastKey) { lastKey = key; onPlaceChange(); }
    } catch (e) { /* ignore */ }
  }, 500);
  setInterval(loadEarly, 5000);
})();
