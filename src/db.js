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
db.pragma('foreign_keys = ON');
// A restart drops every MQTT connection, so nothing can still be online.
db.prepare('UPDATE devices SET online = 0').run();

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const newKey = () => 'dk_' + crypto.randomBytes(24).toString('base64url');
const now = () => Date.now();

const q = {
  byId: db.prepare('SELECT * FROM devices WHERE id = ?'),
  byKeyHash: db.prepare('SELECT * FROM devices WHERE key_hash = ?'),
  list: db.prepare('SELECT * FROM devices ORDER BY created_at'),
  insert: db.prepare('INSERT INTO devices (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)'),
  del: db.prepare('DELETE FROM devices WHERE id = ?'),
  rename: db.prepare('UPDATE devices SET name = ? WHERE id = ?'),
  setKey: db.prepare('UPDATE devices SET key_hash = ? WHERE id = ?'),
  touch: db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?'),
  setOnline: db.prepare('UPDATE devices SET online = ?, last_seen = ? WHERE id = ?'),
  setState: db.prepare('UPDATE devices SET running = ?, state_json = ?, state_at = ?, last_seen = ? WHERE id = ?'),
  insertEvent: db.prepare('INSERT INTO events (device_id, type, payload, ts, source) VALUES (?, ?, ?, ?, ?)'),
  eventsFor: db.prepare('SELECT * FROM events WHERE device_id = ? ORDER BY ts DESC, id DESC LIMIT ?'),
  eventsForType: db.prepare('SELECT * FROM events WHERE device_id = ? AND type = ? ORDER BY ts DESC, id DESC LIMIT ?'),
  eventsAll: db.prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?'),
  lastEvent: db.prepare('SELECT * FROM events WHERE device_id = ? ORDER BY ts DESC, id DESC LIMIT 1'),
  prune: db.prepare('DELETE FROM events WHERE ts < ?'),
};

function publicDevice(d) {
  const last = q.lastEvent.get(d.id);
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
  };
}

function publicEvent(e) {
  let payload = null;
  try { payload = e.payload ? JSON.parse(e.payload) : null; } catch { payload = e.payload; }
  return { id: e.id, device_id: e.device_id, type: e.type, payload, ts: e.ts, source: e.source };
}

module.exports = {
  db, q, hashKey, newKey, now, publicDevice, publicEvent,
  deviceByKey: (key) => (key ? q.byKeyHash.get(hashKey(key)) : undefined),
};
