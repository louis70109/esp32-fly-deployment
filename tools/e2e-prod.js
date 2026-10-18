'use strict';
// End-to-end check of a DEPLOYED esp-hub: enrollment code -> key -> events -> MQTT over TLS -> rotate -> re-provision.
// Creates one test device and always deletes it again.
//
//   E2E_ADMIN_PASSWORD='...' node tools/e2e-prod.js
//
// Env: E2E_ADMIN_PASSWORD (required), E2E_ADMIN_USER (default admin), E2E_HOST (default esp-hub-louis.fly.dev).
// Needs the dev dependency `mqtt` (npm install). The password is never printed or stored.
const https = require('https');
const assert = require('assert');
const mqtt = require('mqtt');

const HOST = process.env.E2E_HOST || 'esp-hub-louis.fly.dev';
const USER = process.env.E2E_ADMIN_USER || 'admin';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const ID = 'e2e-enroll';
if (!PASSWORD) { console.error('Set E2E_ADMIN_PASSWORD'); process.exit(2); }

let cookie = '';
const request = (method, path, headers, body) => new Promise((resolve, reject) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = https.request({ host: HOST, path, method,
    headers: { 'Content-Type': 'application/json', ...headers, ...(data ? { 'Content-Length': data.length } : {}) } },
  (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => {
      if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
      let json = {};
      try { json = JSON.parse(text || '{}'); } catch { /* html etc. */ }
      resolve({ status: res.statusCode, body: json, text });
    });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});
const api = (m, p, h, b) => request(m, '/api/v1' + p, h, b);
const admin = (m, p, b) => api(m, p, { Cookie: cookie }, b);
const device = (m, p, key, b) => api(m, p, { 'X-API-Key': key }, b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => console.log('  ok -', name);

(async () => {
  const page = await request('GET', '/', {});
  assert.ok(page.text.includes('const fill = '), 'dashboard is not the latest build (null-text fix missing)');
  step('dashboard serves the latest build');

  assert.strictEqual((await api('POST', '/login', {}, { username: USER, password: PASSWORD })).status, 200, 'login failed');
  await admin('DELETE', '/devices/' + ID); // leftover from an aborted run
  try {
    const created = await admin('POST', '/devices', { name: 'e2e enrollment test', id: ID, enroll: true });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.api_key, undefined);
    assert.ok(created.body.device.enrollment_expires_at > Date.now(), 'enrollment expiry missing');
    const code = created.body.enrollment.code;
    step('device created in enroll mode (no key issued, enrollment expiry reported)');

    assert.strictEqual((await device('POST', '/events', 'dk_not_enrolled', { type: 'boot' })).status, 401);
    assert.strictEqual((await api('POST', '/enroll', {}, { device_id: ID, code: 'en_wrong' })).status, 401);
    const enrolled = await api('POST', '/enroll', {}, { device_id: ID, code });
    assert.strictEqual(enrolled.status, 201);
    const k1 = enrolled.body.api_key;
    const days = (enrolled.body.key_expires_at - Date.now()) / 86400000;
    assert.ok(days > 89 && days < 91, 'expiry should be ~90 days, got ' + days);
    step(`enroll with code -> key, expires in ${days.toFixed(1)} days`);

    assert.strictEqual((await api('POST', '/enroll', {}, { device_id: ID, code })).status, 401);
    step('code cannot be reused');

    assert.strictEqual((await device('POST', '/events', k1, { type: 'ir_tx', payload: { code: '0x1' } })).status, 201);
    const hb = await device('POST', '/heartbeat', k1, {});
    assert.strictEqual(hb.body.should_rotate, false);
    step('event accepted; heartbeat says no rotation needed');

    const client = mqtt.connect(`mqtts://${HOST}:8883`, { username: ID, password: k1, clientId: ID, reconnectPeriod: 0 });
    await new Promise((res, rej) => { client.once('connect', res); client.once('error', rej); });
    client.publish(`devices/${ID}/state`, JSON.stringify({ running: true }));
    await sleep(1500);
    const d = (await admin('GET', '/devices')).body.devices.find((x) => x.id === ID);
    assert.ok(d.online && d.running === true && d.enrolled === true);
    step('MQTT over TLS with the enrolled key: online + running');

    const rot = await device('POST', '/rotate', k1, {});
    assert.strictEqual(rot.status, 200);
    const k2 = rot.body.api_key;
    assert.strictEqual((await device('POST', '/events', k1, { type: 'boot' })).status, 201);   // grace window
    assert.strictEqual((await device('POST', '/events', k2, { type: 'boot' })).status, 201);   // new key proves itself
    assert.strictEqual((await device('POST', '/events', k1, { type: 'boot' })).status, 401);   // old key retired
    step('rotate: old key works in grace, retired once new key is used');

    await new Promise((r) => client.end(true, r));
    const again = await admin('POST', `/devices/${ID}/enrollment`, { ttl_hours: 1 });
    assert.strictEqual(again.status, 201);
    const re = await api('POST', '/enroll', {}, { device_id: ID, code: again.body.code });
    assert.strictEqual(re.status, 201);
    assert.strictEqual((await device('POST', '/events', k2, { type: 'boot' })).status, 401);
    assert.strictEqual((await device('POST', '/events', re.body.api_key, { type: 'boot' })).status, 201);
    step('re-provisioning via a new code replaces the old key');
  } finally {
    const del = await admin('DELETE', '/devices/' + ID);
    const left = (await admin('GET', '/devices')).body.devices.some((x) => x.id === ID);
    console.log('cleanup: delete ->', del.status, '| test device still present:', left);
    await api('POST', '/logout', { Cookie: cookie }, {});
  }
  console.log('\nproduction enrollment flow OK');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
