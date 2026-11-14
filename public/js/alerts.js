// Step 11: incident banner (sound + pop-up) and the "My alerts" panel.
// Load this file AFTER dashboard.js: it reuses api(), post(), PLACE and radiusSel.
(function () {
  const $ = id => document.getElementById(id);
  const query = () => 'lat=' + PLACE.lat + '&lon=' + PLACE.lon + '&radius=' + radiusSel.value +
                      '&name=' + encodeURIComponent(PLACE.name);
  const bodyForPlace = () => ({ lat: PLACE.lat, lon: PLACE.lon, name: PLACE.name, radius: Number(radiusSel.value) });

  let audio = null, seenId = null, me = null, activeSeq = 0;
  let home = null;                                   // the home location being edited

  // ---------------- sound and pop-up ----------------
  function beep() {
    try {
      if (!audio) return;
      if (audio.state === 'suspended') audio.resume();
      for (let i = 0; i < 3; i++) {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'square'; o.frequency.value = 880;
        g.gain.value = 0.08;
        o.connect(g); g.connect(audio.destination);
        const t = audio.currentTime + i * 0.45;
        o.start(t); o.stop(t + 0.25);
      }
    } catch (e) { /* sound is a bonus */ }
  }

  function popup(title, body) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
    } catch (e) { /* not supported here */ }
  }

  function enableSoundAndPopups() {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); beep(); } catch (e) { /* no audio */ }
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(refreshSoundNote); } catch (e) { /* no pop-ups */ }
    refreshSoundNote();
  }

  function refreshSoundNote() {
    let t = audio ? 'Sound is on for this tab. ' : 'Sound is off: press the button above to turn it on. ';
    try {
      t += !('Notification' in window) ? 'Pop-ups are not supported by this browser.'
        : Notification.permission === 'granted' ? 'Pop-ups are on.'
        : Notification.permission === 'denied' ? 'Pop-ups are blocked in the browser settings.' : 'Pop-ups are off.';
    } catch (e) { /* ignore */ }
    $('maSoundNote').textContent = t;
  }

  // ---------------- incident banner ----------------
  const ago = ts => {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  };

  function renderIncident(inc) {
    const bar = $('incidentBar');
    if (!inc) { bar.className = 'incident hidden'; bar.textContent = ''; return; }

    bar.className = 'incident ' + inc.level;
    bar.textContent = '';
    const head = document.createElement('b');
    head.textContent = inc.headline + ' · ' + ago(inc.ts);
    const text = document.createElement('p');
    text.textContent = inc.ai_text || inc.text;
    const note = document.createElement('small');
    note.textContent = (inc.ai_text ? 'Wording by AI, checked against the facts. ' : '') +
      'Automatic sensor alert, not an official warning. In an emergency call 112.';
    bar.append(head, text, note);

    if (seenId !== inc.id) {                         // a new incident: make noise once
      seenId = inc.id;
      beep(); popup(inc.headline, inc.text);
    }
  }

  async function loadActive() {
    if (typeof PLACE === 'undefined' || !PLACE) return;
    const seq = ++activeSeq;
    try {
      const d = await api('/api/alerts/active?' + query());
      if (seq === activeSeq) renderIncident(d.incident);
    } catch (e) { /* the next poll will try again */ }
  }

  // ---------------- My alerts panel ----------------
  const status = (msg, bad) => { const s = $('maStatus'); s.textContent = msg || ''; s.classList.toggle('bad', !!bad); };

  function paint() {
    if (!me) return;
    $('maEmail').checked = me.email_on;
    $('maSms').checked = me.sms_on;
    $('maCall').checked = me.call_on;
    $('maCircular').checked = me.circular_on;
    $('maEmailHint').textContent = me.emailVerified
      ? 'Email within ' + me.emailKm + ' km of your home.'
      : 'Verify your email address first (you did this at sign-up if you see a verified account).';
    $('maEmail').disabled = !me.emailVerified;
    $('maSms').disabled = !me.phone_verified;
    $('maSmsHint').textContent = me.phone_verified
      ? 'Text message, and a phone call too, within ' + me.smsKm + ' km of your home, to ' + me.phone + '.'
      : 'Add and verify a mobile number below to turn this on.';
    $('maCall').disabled = !me.phone_verified;
    $('maCallHint').textContent = me.phone_verified
      ? 'A voice call to ' + me.phone + ' when a fire may break out within ' + me.callKm + ' km of your home. Already on automatically if text message alerts are on.'
      : 'Add and verify a mobile number below to turn this on.';
    $('maCircularHint').textContent = 'On the 1st and 15th of each month: the month-by-month data for places near your home or that you look at often, what to expect, and what to do. Goes by email and text message, whichever you have switched on above.';
    $('maTestCall').classList.toggle('hidden', !me.isAdmin);
    $('maCircularPreview').classList.toggle('hidden', !me.isAdmin);
    home = home || me.home;
    $('maHome').textContent = home ? (home.name || 'My location') + ' (' + Number(home.lat).toFixed(4) + ', ' + Number(home.lon).toFixed(4) + ')' : 'Not set';
    $('maPhoneNow').textContent = me.phone_verified ? 'Verified: ' + me.phone : 'No verified number';
    $('maRemovePhone').classList.toggle('hidden', !me.phone_verified);
    $('maTest').classList.toggle('hidden', !me.isAdmin);
    const ap = $('adminPanelLink'); if (ap) ap.classList.toggle('hidden', !me.isAdmin);
    $('maHistoryWrap').classList.toggle('hidden', !me.isAdmin);
  }

  async function loadMe() {
    try { me = await api('/api/alerts/me'); home = me.home; paint(); }
    catch (e) { if (e.message !== 'login') status('Could not load your alert settings: ' + e.message, true); }
  }

  async function save() {
    status('Saving...');
    try {
      me = await post('/api/alerts/prefs', { email_on: $('maEmail').checked, sms_on: $('maSms').checked, call_on: $('maCall').checked, circular_on: $('maCircular').checked, home });
      home = me.home; paint(); status('Saved.');
    } catch (e) { if (e.message !== 'login') { status(e.message, true); await loadMe(); } }
  }

  function useViewedPlace() {
    if (typeof PLACE === 'undefined' || !PLACE) return status('Pick a place on the dashboard first.', true);
    home = { lat: PLACE.lat, lon: PLACE.lon, name: PLACE.name };
    paint(); status('Home set to ' + PLACE.name + '. Press Save.');
  }

  function useGps() {
    if (!navigator.geolocation) return status('This browser cannot share your location.', true);
    status('Asking the browser for your location...');
    navigator.geolocation.getCurrentPosition(
      pos => { home = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'My location' }; paint(); status('Home set from your device. Press Save.'); },
      () => status('Could not get your location. Use "the place I am viewing" instead.', true),
      { enableHighAccuracy: true, timeout: 15000 });
  }

  async function sendCode() {
    status('Sending code...');
    try {
      const r = await post('/api/alerts/phone/send', { phone: $('maPhone').value });
      status('Code sent to ' + r.phone + '. Enter it below.');
      $('maCode').focus();
    } catch (e) { if (e.message !== 'login') status(e.message, true); }
  }

  async function verify() {
    try {
      me = await post('/api/alerts/phone/verify', { code: $('maCode').value });
      $('maCode').value = ''; $('maPhone').value = ''; paint(); status('Number verified. Switch on text alerts and press Save.');
    } catch (e) { if (e.message !== 'login') status(e.message, true); }
  }

  async function removePhone() {
    try { me = await post('/api/alerts/phone/remove', {}); paint(); status('Number removed.'); }
    catch (e) { if (e.message !== 'login') status(e.message, true); }
  }

  async function sendTest() {
    status('Sending test alert to the admin...');
    try {
      const r = await post('/api/alerts/test', bodyForPlace());
      status('Test sent: ' + r.emails + ' email, ' + r.sms + ' SMS' + (r.errors.length ? ' (problems: ' + r.errors.join('; ') + ')' : '') +
             '. With no real keys set, look for [DEMO EMAIL] and [DEMO SMS] in the server terminal.');
      loadHistory();
    } catch (e) { if (e.message !== 'login') status(e.message, true); }
  }

  async function sendTestCall() {
    status('Calling your phone...');
    try {
      const r = await post('/api/calls/test', {});
      status(r.ok ? 'Test call placed (' + r.mode + ').' + (r.mode === 'demo' ? ' With no call provider set up, look for [DEMO CALL] in the server terminal.' : '')
                  : 'No call was placed' + (r.reason === 'no-admin-phone' ? ': ADMIN_PHONE is not set in .env.' : (r.errors && r.errors.length ? ': ' + r.errors.join('; ') : '.')), !r.ok);
    } catch (e) { if (e.message !== 'login') status(e.message, true); }
  }

  async function previewCircular() {
    const box = $('maCircularOut');
    status('Preparing the monthly circular (nothing is sent)...');
    try {
      const d = await api('/api/circular/preview');
      const r = d.results[0];
      box.textContent = '';
      const head = document.createElement('b');
      head.textContent = 'Would reach ' + r.audience.emails + ' email and ' + r.audience.phones + ' text message recipients (' + r.audience.live + ' living nearby, ' + r.audience.visit + ' regular visitors, plus the admin). ' +
        (r.ai ? 'Summary written by ' + r.ai.label + '.' : 'Built-in wording (no AI answered).');
      const mail = document.createElement('p'); mail.textContent = r.subject + '\n\n' + r.body;
      const sms = document.createElement('p'); sms.textContent = 'TEXT MESSAGE VERSION:\n' + r.sms;
      box.append(head, mail, sms);
      box.classList.remove('hidden');
      status('Preview ready. Nothing was sent.');
    } catch (e) { if (e.message !== 'login') status(e.message, true); }
  }

  async function loadHistory() {
    if (!me || !me.isAdmin) return;
    try {
      const d = await api('/api/alerts/events');
      const box = $('maHistory'); box.textContent = '';
      if (!d.events.length) { box.textContent = 'No alerts yet.'; return; }
      for (const ev of d.events) {
        const row = document.createElement('div');
        row.className = 'ma-row ' + (ev.level || '');
        row.textContent = new Date(ev.ts).toLocaleString('en-IN', { hour12: false }) + '  ·  ' + ev.kind + '  ·  ' +
          ev.headline + '  ·  ' + ev.emails + ' email, ' + ev.sms + ' SMS' + (ev.details ? '  ·  PROBLEM: ' + ev.details : '');
        box.append(row);
      }
    } catch (e) { /* shown next time */ }
  }

  // ---------------- wiring ----------------
  $('maSave').addEventListener('click', save);
  $('maHomePlace').addEventListener('click', useViewedPlace);
  $('maHomeGps').addEventListener('click', useGps);
  $('maSendCode').addEventListener('click', sendCode);
  $('maVerify').addEventListener('click', verify);
  $('maRemovePhone').addEventListener('click', removePhone);
  $('maTest').addEventListener('click', sendTest);
  $('maTestCall').addEventListener('click', sendTestCall);
  $('maCircularPreview').addEventListener('click', previewCircular);
  $('maSound').addEventListener('click', enableSoundAndPopups);
  $('maHistoryBtn').addEventListener('click', loadHistory);

  refreshSoundNote();
  loadMe().then(loadHistory);
  setInterval(loadActive, 5000);
  setTimeout(loadActive, 1200);
})();
