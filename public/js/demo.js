// Online demo controls: start a simulated event on the virtual sensor.
// Load after dashboard.js (uses its post() helper).
(function () {
  const $ = id => document.getElementById(id);

  fetch('/api/demo/config').then(r => r.json()).then(cfg => {
    if (cfg.virtualSensor) $('demoPanel').classList.remove('hidden');
  }).catch(() => { /* not a demo server */ });

  async function start(kind) {
    const msg = $('demoMsg');
    msg.textContent = 'Starting...';
    try {
      const r = await post('/api/demo/trigger', { kind });
      msg.textContent = r.message;
    } catch (e) { if (e.message !== 'login') msg.textContent = e.message; }
  }

  $('demoSmolder').addEventListener('click', () => start('smolder'));
  $('demoFire').addEventListener('click', () => start('fire'));
})();
