const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'enviro.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    phone TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS login_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mode TEXT,
    location TEXT,
    logged_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS otps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Create the admin from .env on first run; keep the phone number in sync
function ensureAdmin() {
  const name = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;
  const phone = process.env.ADMIN_PHONE || null;
  if (!name || !pass) return console.warn('ADMIN_USER / ADMIN_PASS missing in .env');

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (!exists) {
    const hash = bcrypt.hashSync(pass, 10);
    db.prepare(
      'INSERT INTO users (username, phone, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 1)'
    ).run(name, phone, hash, 'admin');
    console.log('Admin account created:', name);
  } else if (phone) {
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, exists.id);
  }
}

module.exports = { db, ensureAdmin };