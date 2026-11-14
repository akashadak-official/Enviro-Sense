'use strict';
// Runs before the database is opened.
//  1. Refuses to start without a JWT secret (the key that signs login cookies).
//  2. On a host whose disk starts empty (for example Render free), unpacks the bundled
//     satellite database (seed/enviro-seed.db.gz) so the app starts with its NASA data.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const dbPath = () => process.env.DB_PATH || path.join(root, 'enviro.db');

function prepare() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    console.error('JWT_SECRET is missing or too short (use at least 16 random characters). Set it in .env or in your host settings.');
    process.exit(1);
  }

  const target = dbPath();
  if (fs.existsSync(target)) return;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const seed = path.join(root, 'seed', 'enviro-seed.db.gz');
  if (!fs.existsSync(seed)) {
    console.log('No seed database found: starting with an empty database.');
    return;
  }

  const t0 = Date.now();
  const raw = zlib.gunzipSync(fs.readFileSync(seed));
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, target);
  console.log(`Seed database unpacked: ${(raw.length / 1048576).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

module.exports = { prepare, dbPath };
