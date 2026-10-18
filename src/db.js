'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hub.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  online      INTEGER NOT NULL DEFAULT 0,
  running     INTEGER,
  state_json  TEXT,
  state_at    INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  payload   TEXT,
  ts        INTEGER NOT NULL,
  source    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_device_ts ON events(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
`);

// --- migrations (idempotent; safe on databases created by older versions) ---
const deviceCols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
const addCol = (name, def) => { if (!deviceCols.includes(name)) db.exec(`ALTER TABLE devices ADD COLUMN ${name} ${def}`); };
addCol('key_expires_at', 'INTEGER');            // NULL = never expires (all pre-existing keys)
addCol('prev_key_hash', 'TEXT');                // previous key, still valid during the rotation grace window
addCol('prev_key_expires_at', 'INTEGER');
addCol('enrolled', 'INTEGER NOT NULL DEFAULT 1'); // 0 = created with an enrollment code, no usable key yet

db.exec(`
CREATE INDEX IF NOT EXISTS idx_devices_prev_key ON devices(prev_key_hash);
CREATE TABLE IF NOT EXISTS enrollments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
`);
db.pragma('foreign_keys = ON');
// A restart drops every MQTT connection, so nothing can still be online.
db.prepare('UPDATE devices SET online = 0').run();

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const newKey = () => 'dk_' + crypto.randomBytes(24).toString('base64url');
const newEnrollCode = () => 'en_' + crypto.randomBytes(16).toString('base64url');
const now = () => Date.now();

const q = {
  byId: db.prepare('SELECT * FROM devices WHERE id = ?'),
  byKeyHash: db.prepare('SELECT * FROM devices WHERE key_hash = ?'),
  byPrevKeyHash: db.prepare('SELECT * FROM devices WHERE prev_key_hash = ? AND prev_key_expires_at > ?'),
  list: db.prepare('SELECT * FROM devices ORDER BY created_at'),
  insert: db.prepare('INSERT INTO devices (id, name, key_hash, created_at, enrolled, key_expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
  del: db.prepare('DELETE FROM devices WHERE id = ?'),
  rename: db.prepare('UPDATE devices SET name = ? WHERE id = ?'),
  // Replace the key outright: any old key stops working immediately.
  setKey: db.prepare(`UPDATE devices SET key_hash = ?, key_expires_at = ?, prev_key_hash = NULL,
                      prev_key_expires_at = NULL, enrolled = 1 WHERE id = ?`),
  // Device-initiated rotation: the key it just used stays valid for a grace window.
  rotateKey: db.prepare(`UPDATE devices SET prev_key_hash = key_hash, prev_key_expires_at = ?,
                         key_hash = ?, key_expires_at = ? WHERE id = ?`),
  // Rotation requested with the *previous* key (new key never arrived): keep that key alive, replace the unseen one.
  reissueKey: db.prepare('UPDATE devices SET key_hash = ?, key_expires_at = ?, prev_key_expires_at = ? WHERE id = ?'),
  clearPrev: db.prepare('UPDATE devices SET prev_key_hash = NULL, prev_key_expires_at = NULL WHERE id = ?'),
  touch: db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?'),
  setOnline: db.prepare('UPDATE devices SET online = ?, last_seen = ? WHERE id = ?'),
  setState: db.prepare('UPDATE devices SET running = ?, state_json = ?, state_at = ?, last_seen = ? WHERE id = ?'),
  insertEvent: db.prepare('INSERT INTO events (device_id, type, payload, ts, source) VALUES (?, ?, ?, ?, ?)'),
  eventsFor: db.prepare('SELECT * FROM events WHERE device_id = ? ORDER BY ts DESC, id DESC LIMIT ?'),
  eventsForType: db.prepare('SELECT * FROM events WHERE device_id = ? AND type = ? ORDER BY ts DESC, id DESC LIMIT ?'),
  eventsAll: db.prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?'),
  lastEvent: db.prepare('SELECT * FROM events WHERE device_id = ? ORDER BY ts DESC, id DESC LIMIT 1'),
  prune: db.prepare('DELETE FROM events WHERE ts < ?'),
  insertEnroll: db.prepare('INSERT INTO enrollments (device_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  enrollByHash: db.prepare('SELECT * FROM enrollments WHERE code_hash = ?'),
  pendingEnroll: db.prepare('SELECT expires_at FROM enrollments WHERE device_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1'),
  useEnroll: db.prepare('UPDATE enrollments SET used_at = ? WHERE id = ?'),
  dropUnusedEnroll: db.prepare('DELETE FROM enrollments WHERE device_id = ? AND used_at IS NULL'),
  pruneEnroll: db.prepare('DELETE FROM enrollments WHERE expires_at < ?'),
};

/**
 * Resolves an API key to a device.
 *  - current key  -> { device, via: 'current' }; using the new key after a rotation retires the previous one
 *  - previous key -> { device, via: 'previous' } while its grace window is open
 *  - otherwise    -> { error: 'invalid' | 'expired' }
 */
function authenticateKey(key) {
  if (!key) return { error: 'invalid' };
  const h = hashKey(key);
  const t = now();
  const d = q.byKeyHash.get(h);
  if (d) {
    if (!d.enrolled) return { error: 'invalid' };
    if (d.key_expires_at && d.key_expires_at <= t) return { error: 'expired' };
    if (d.prev_key_hash) {
      q.clearPrev.run(d.id);
      d.prev_key_hash = null;
      d.prev_key_expires_at = null;
    }
    return { device: d, via: 'current' };
  }
  const p = q.byPrevKeyHash.get(h, t);
  if (p) return { device: p, via: 'previous' };
  return { error: 'invalid' };
}

function publicDevice(d) {
  const last = q.lastEvent.get(d.id);
  const t = now();
  const pending = q.pendingEnroll.get(d.id, t);
  return {
    id: d.id,
    name: d.name,
    created_at: d.created_at,
    last_seen: d.last_seen,
    online: !!d.online,
    running: d.running === null ? null : !!d.running,
    state: d.state_json ? JSON.parse(d.state_json) : null,
    state_at: d.state_at,
    last_event: last ? publicEvent(last) : null,
    enrolled: !!d.enrolled,
    key_expires_at: d.key_expires_at || null,
    key_expired: !!(d.key_expires_at && d.key_expires_at <= t),
    key_grace_until: d.prev_key_hash && d.prev_key_expires_at > t ? d.prev_key_expires_at : null,
    enrollment_expires_at: pending ? pending.expires_at : null,
  };
}

function publicEvent(e) {
  let payload = null;
  try { payload = e.payload ? JSON.parse(e.payload) : null; } catch { payload = e.payload; }
  return { id: e.id, device_id: e.device_id, type: e.type, payload, ts: e.ts, source: e.source };
}

module.exports = {
  db, q, hashKey, newKey, newEnrollCode, now, publicDevice, publicEvent, authenticateKey,
};
