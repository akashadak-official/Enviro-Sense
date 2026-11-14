'use strict';
// Demo-mode helpers for the free online version (DEMO_MODE=1).
const { db } = require('../db');

const enabled = () => process.env.DEMO_MODE === '1';
const virtualSensor = () => process.env.VIRTUAL_SENSOR === '1';

// Guest accounts are named guest-xxxxxx and removed after a day, with the data tied to them.
function purgeOldGuests() {
  try {
    const old = db.prepare("SELECT id FROM users WHERE username LIKE 'guest-%' AND role = 'user' AND created_at < datetime('now', '-1 day')").all();
    for (const { id } of old) {
      for (const t of ['login_history', 'view_history', 'alert_prefs', 'phone_codes', 'otps']) {
        try { db.prepare('DELETE FROM ' + t + ' WHERE user_id = ?').run(id); } catch (e) { /* table not present */ }
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    return old.length;
  } catch (e) {
    console.error('Guest cleanup failed:', e.message);
    return 0;
  }
}

let timer = null;
function start() {
  if (!enabled() || timer) return;
  purgeOldGuests();
  timer = setInterval(purgeOldGuests, 3600 * 1000);
  console.log('Demo mode: ON (guest login, no email verification, password reset off)');
}

module.exports = { enabled, virtualSensor, purgeOldGuests, start };
