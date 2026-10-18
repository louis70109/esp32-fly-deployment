'use strict';
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const express = require('express');
const Aedes = require('aedes');
const store = require('./db');

const { q, db, now, hashKey, newKey, publicDevice, publicEvent, deviceByKey } = store;

const HTTP_PORT = Number(process.env.PORT || 8080);
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS || 90);

let ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  if (process.env.NODE_ENV === 'production') {
    console.error('ADMIN_KEY is required in production (fly secrets set ADMIN_KEY=...)');
    process.exit(1);
  }
  ADMIN_KEY = 'ak_' + crypto.randomBytes(18).toString('base64url');
  console.log(`[dev] ADMIN_KEY not set, generated: ${ADMIN_KEY}`);
}

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const EVENT_TYPE_RE = /^[a-z0-9_.-]{1,40}$/i;
const DEVICE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const MAX_PAYLOAD_BYTES = 4096;

// ---------------------------------------------------------------- core logic

/** Records one event for a device. Throws Error with .status on bad input. */
function recordEvent(device, type, payload, source, ts) {
  if (typeof type !== 'string' || !EVENT_TYPE_RE.test(type)) {
    throw Object.assign(new Error('type must match [a-z0-9_.-]{1,40}'), { status: 400 });
  }
  const json = payload === undefined || payload === null ? null : JSON.stringify(payload);
  if (json && Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) {
    throw Object.assign(new Error('payload too large'), { status: 413 });
  }
  // Device clocks (no RTC/NTP yet) can be wrong; only trust a ts that is plausible.
  const t = now();
  const eventTs = Number.isFinite(ts) && Math.abs(ts - t) < 24 * 3600 * 1000 ? ts : t;
  q.insertEvent.run(device.id, type, json, eventTs, source);
  q.touch.run(t, device.id);
  if (type === 'power_on') setState(device, { running: true }, t);
  if (type === 'power_off') setState(device, { running: false }, t);
}

/** Updates the "in use / idle" state. `running` is the only required field. */
function setState(device, state, t = now()) {
  if (typeof state.running !== 'boolean') {
    throw Object.assign(new Error('running (boolean) is required'), { status: 400 });
  }
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) {
    throw Object.assign(new Error('state too large'), { status: 413 });
  }
  q.setState.run(state.running ? 1 : 0, json, t, t, device.id);
}

function createDevice(name, wantedId) {
  const id = wantedId || 'esp-' + crypto.randomBytes(3).toString('hex');
  if (!DEVICE_ID_RE.test(id)) {
    throw Object.assign(new Error('id must match [a-z0-9][a-z0-9_-]{1,31}'), { status: 400 });
  }
  if (q.byId.get(id)) throw Object.assign(new Error('id already exists'), { status: 409 });
  const key = newKey();
  q.insert.run(id, String(name || id).slice(0, 60), hashKey(key), now());
  return { device: publicDevice(q.byId.get(id)), api_key: key };
}

// ---------------------------------------------------------------------- MQTT

const aedes = new Aedes({ id: 'esp-hub' });
const mqttClients = new Map(); // deviceId -> client currently owning the session

aedes.authenticate = (client, username, password, cb) => {
  const key = password ? password.toString() : '';
  const device = deviceByKey(key);
  if (!device || !safeEqual(device.id, username)) {
    const err = new Error('bad credentials');
    err.returnCode = 4;
    return cb(err, false);
  }
  client.deviceId = device.id;
  cb(null, true);
};

// A device may publish only its own status/state/event topics and subscribe only to its own cmd topic.
const PUB_TOPICS = ['state', 'event', 'status'];
aedes.authorizePublish = (client, packet, cb) => {
  if (!client) return cb(null); // broker-internal publish
  const parts = packet.topic.split('/');
  if (parts.length === 3 && parts[0] === 'devices' && parts[1] === client.deviceId && PUB_TOPICS.includes(parts[2])) {
    return cb(null);
  }
  cb(new Error('publish not allowed on ' + packet.topic));
};
aedes.authorizeSubscribe = (client, sub, cb) => {
  if (sub.topic === `devices/${client.deviceId}/cmd` || sub.topic === `devices/${client.deviceId}/cmd/#`) {
    return cb(null, sub);
  }
  cb(new Error('subscribe not allowed on ' + sub.topic));
};

function brokerPublish(topic, payload) {
  aedes.publish({ topic, payload, qos: 0, retain: true, cmd: 'publish', dup: false }, () => {});
}

aedes.on('client', (client) => {
  if (!client.deviceId) return;
  const previous = mqttClients.get(client.deviceId);
  mqttClients.set(client.deviceId, client);
  if (previous && previous !== client) previous.close();
  q.setOnline.run(1, now(), client.deviceId);
  brokerPublish(`hub/${client.deviceId}/presence`, 'online');
});

aedes.on('clientDisconnect', (client) => {
  if (!client.deviceId || mqttClients.get(client.deviceId) !== client) return;
  mqttClients.delete(client.deviceId);
  q.setOnline.run(0, now(), client.deviceId);
  brokerPublish(`hub/${client.deviceId}/presence`, 'offline');
});

aedes.on('publish', (packet, client) => {
  if (!client || !client.deviceId) return;
  const device = q.byId.get(client.deviceId);
  if (!device) return;
  const [, , kind] = packet.topic.split('/');
  const text = packet.payload.toString();
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) return;
  try {
    if (kind === 'state') {
      // Accept {"running":true,...} or a bare "on"/"off"/"running"/"idle".
      let state;
      try { state = JSON.parse(text); } catch { state = null; }
      if (typeof state === 'string') state = { running: ['on', 'running', 'true'].includes(state) };
      else if (state === true || state === false) state = { running: state };
      else if (!state) state = { running: ['on', 'running', 'true'].includes(text.trim().toLowerCase()) };
      setState(device, state);
    } else if (kind === 'event') {
      const body = JSON.parse(text);
      recordEvent(device, body.type, body.payload, 'mqtt', body.ts);
    } else if (kind === 'status') {
      q.touch.run(now(), device.id); // heartbeat only; presence comes from the connection itself
    }
  } catch (err) {
    console.warn(`[mqtt] ${device.id} ${kind}: ${err.message}`);
  }
});

function dropMqttClient(deviceId) {
  const c = mqttClients.get(deviceId);
  if (c) c.close();
}

// ---------------------------------------------------------------------- HTTP

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
  next();
});

// Per-IP throttle for failed auth, so keys cannot be brute-forced.
const failures = new Map();
function authFailed(req) {
  const rec = failures.get(req.ip) || { n: 0, reset: now() + 60_000 };
  rec.n += 1;
  failures.set(req.ip, rec);
}
function blocked(req) {
  const rec = failures.get(req.ip);
  if (!rec) return false;
  if (now() > rec.reset) { failures.delete(req.ip); return false; }
  return rec.n > 20;
}

function requireAdmin(req, res, next) {
  if (blocked(req)) return res.status(429).json({ error: 'too many failed attempts' });
  if (!safeEqual(req.get('x-admin-key'), ADMIN_KEY)) {
    authFailed(req);
    return res.status(401).json({ error: 'invalid admin key' });
  }
  next();
}

function requireDevice(req, res, next) {
  if (blocked(req)) return res.status(429).json({ error: 'too many failed attempts' });
  const device = deviceByKey(req.get('x-api-key'));
  if (!device) {
    authFailed(req);
    return res.status(401).json({ error: 'invalid api key' });
  }
  req.device = device;
  next();
}

const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'internal error' });
    if (!err.status) console.error(err);
  }
};

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- device API (X-API-Key) ----
app.post('/api/v1/events', requireDevice, wrap((req, res) => {
  const { type, payload, ts } = req.body || {};
  recordEvent(req.device, type, payload, 'http', ts);
  res.status(201).json({ ok: true });
}));

app.post('/api/v1/state', requireDevice, wrap((req, res) => {
  setState(req.device, req.body || {});
  res.json({ ok: true });
}));

app.post('/api/v1/heartbeat', requireDevice, wrap((req, res) => {
  q.touch.run(now(), req.device.id);
  res.json({ ok: true, server_time: now() });
}));

// ---- admin API (X-Admin-Key) ----
app.get('/api/v1/devices', requireAdmin, wrap((req, res) => {
  res.json({ devices: q.list.all().map(publicDevice), server_time: now() });
}));

app.post('/api/v1/devices', requireAdmin, wrap((req, res) => {
  const { name, id } = req.body || {};
  res.status(201).json(createDevice(name, id));
}));

app.patch('/api/v1/devices/:id', requireAdmin, wrap((req, res) => {
  if (!q.byId.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name required' });
  q.rename.run(name, req.params.id);
  res.json({ device: publicDevice(q.byId.get(req.params.id)) });
}));

app.post('/api/v1/devices/:id/rotate-key', requireAdmin, wrap((req, res) => {
  if (!q.byId.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const key = newKey();
  q.setKey.run(hashKey(key), req.params.id);
  dropMqttClient(req.params.id); // old key must stop working immediately
  res.json({ api_key: key });
}));

app.delete('/api/v1/devices/:id', requireAdmin, wrap((req, res) => {
  if (!q.byId.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  dropMqttClient(req.params.id);
  q.del.run(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/v1/devices/:id/events', requireAdmin, wrap((req, res) => {
  if (!q.byId.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const rows = req.query.type
    ? q.eventsForType.all(req.params.id, String(req.query.type), limit)
    : q.eventsFor.all(req.params.id, limit);
  res.json({ events: rows.map(publicEvent) });
}));

app.get('/api/v1/events', requireAdmin, wrap((req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  res.json({ events: q.eventsAll.all(limit).map(publicEvent) });
}));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// -------------------------------------------------------------------- start

function pruneOldEvents() {
  const cutoff = now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const { changes } = q.prune.run(cutoff);
  if (changes) console.log(`[prune] removed ${changes} events older than ${RETENTION_DAYS}d`);
}

function start() {
  pruneOldEvents();
  setInterval(pruneOldEvents, 6 * 3600 * 1000).unref();

  const mqttServer = net.createServer(aedes.handle);
  mqttServer.listen(MQTT_PORT, () => console.log(`MQTT broker on :${MQTT_PORT}`));
  const httpServer = app.listen(HTTP_PORT, () => console.log(`HTTP on :${HTTP_PORT}`));

  const shutdown = () => {
    httpServer.close();
    mqttServer.close();
    aedes.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return { httpServer, mqttServer };
}

if (require.main === module) start();

module.exports = { app, aedes, start, ADMIN_KEY };
