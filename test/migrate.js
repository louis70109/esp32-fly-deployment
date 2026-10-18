'use strict';
// A database created by the first release (no expiry/enrollment columns) must upgrade in place.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esphub-mig-'));
process.env.DATA_DIR = dir;

const old = new Database(path.join(dir, 'hub.db'));
old.exec(`
CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  last_seen INTEGER, online INTEGER NOT NULL DEFAULT 0, running INTEGER, state_json TEXT, state_at INTEGER);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type TEXT NOT NULL, payload TEXT, ts INTEGER NOT NULL, source TEXT NOT NULL);
`);
const legacyKey = 'dk_legacykey';
old.prepare('INSERT INTO devices (id, name, key_hash, created_at) VALUES (?,?,?,?)')
  .run('esp-old', 'Legacy', crypto.createHash('sha256').update(legacyKey).digest('hex'), Date.now());
old.prepare('INSERT INTO events (device_id, type, ts, source) VALUES (?,?,?,?)').run('esp-old', 'ir_tx', Date.now(), 'http');
old.close();

const store = require('../src/db');
const cols = store.db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
for (const c of ['key_expires_at', 'prev_key_hash', 'prev_key_expires_at', 'enrolled']) assert.ok(cols.includes(c), 'missing ' + c);
console.log('  ok - new columns added');

const auth = store.authenticateKey(legacyKey);
assert.ok(auth.device && auth.device.id === 'esp-old', 'legacy key must still authenticate');
assert.strictEqual(auth.device.key_expires_at, null);
assert.strictEqual(auth.device.enrolled, 1);
console.log('  ok - legacy key still works and never expires');

const pub = store.publicDevice(store.q.byId.get('esp-old'));
assert.strictEqual(pub.enrolled, true);
assert.strictEqual(pub.key_expires_at, null);
assert.strictEqual(pub.last_event.type, 'ir_tx');
console.log('  ok - existing events preserved');

assert.strictEqual(store.authenticateKey('dk_nope').error, 'invalid');
console.log('  ok - unknown key rejected');
console.log('\n4 checks passed');
