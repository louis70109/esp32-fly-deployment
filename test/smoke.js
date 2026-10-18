'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'esphub-'));
process.env.ADMIN_USER = 'boss';
process.env.ADMIN_PASSWORD = 'correct horse';
process.env.SESSION_SECRET = 'test-secret';
process.env.PORT = '18080';
process.env.MQTT_PORT = '11883';
process.env.AUTH_FAIL_LIMIT = '60';

const mqtt = require('mqtt');
const { start, sweepExpiredSessions } = require('../src/server');
const { db: rawDb } = require('../src/db');

const httpMod = require('http');
// Node 16 has no global fetch; tiny stand-in returning {status, json(), text()}.
function fetch(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpMod.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const base = 'http://127.0.0.1:18080/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function http(method, p, { key, admin, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(key ? { 'X-API-Key': key } : {}), ...(admin === true ? { Cookie: cookie } : admin ? { Cookie: admin } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})), setCookie: res.headers && res.headers['set-cookie'] };
}
const connect = (id, key) => new Promise((resolve, reject) => {
  const c = mqtt.connect('mqtt://127.0.0.1:11883', { username: id, password: key, clientId: id, reconnectPeriod: 0, will: { topic: `devices/${id}/status`, payload: 'offline' } });
  c.once('connect', () => resolve(c));
  c.once('error', reject);
  c.once('close', () => reject(new Error('closed before connect')));
});

(async () => {
  const { httpServer, mqttServer } = start();
  await sleep(300);
  let ok = 0;
  const check = (name, fn) => { fn(); ok++; console.log('  ok -', name); };

  // admin auth
  assert.strictEqual((await http('GET', '/devices')).status, 401);
  assert.strictEqual((await http('GET', '/devices', { admin: 'hub_session=9999999999999.forged' })).status, 401);
  assert.strictEqual((await http('POST', '/login', { body: { username: 'boss', password: 'wrong' } })).status, 401);
  assert.strictEqual((await http('POST', '/login', { body: { username: 'admin', password: 'correct horse' } })).status, 401);
  check('admin rejects no session, forged cookie, bad password, wrong user', () => {});
  const login = await http('POST', '/login', { body: { username: 'boss', password: 'correct horse' } });
  assert.strictEqual(login.status, 200);
  cookie = login.setCookie[0].split(';')[0];
  check('login sets HttpOnly SameSite=Strict cookie', () => {
    assert.ok(/HttpOnly/.test(login.setCookie[0]) && /SameSite=Strict/.test(login.setCookie[0]));
  });
  assert.strictEqual((await http('GET', '/session', { admin: true })).body.authenticated, true);
  assert.strictEqual((await http('GET', '/session')).body.authenticated, false);

  const a = await http('POST', '/devices', { admin: true, body: { name: '客廳冷氣', id: 'esp-a' } });
  assert.strictEqual(a.status, 201);
  const keyA = a.body.api_key;
  const b = await http('POST', '/devices', { admin: true, body: { name: 'B' , id: 'esp-b'} });
  const keyB = b.body.api_key;
  check('devices created, key returned once', () => assert.ok(keyA.startsWith('dk_')));
  assert.strictEqual((await http('POST', '/devices', { admin: true, body: { id: 'esp-a' } })).status, 409);
  assert.strictEqual((await http('POST', '/devices', { admin: true, body: { id: 'Bad ID!' } })).status, 400);

  // HTTP API
  assert.strictEqual((await http('POST', '/events', { body: { type: 'ir_tx' } })).status, 401);
  assert.strictEqual((await http('POST', '/events', { key: 'dk_nope', body: { type: 'ir_tx' } })).status, 401);
  assert.strictEqual((await http('POST', '/events', { key: keyA, body: { type: 'bad type!' } })).status, 400);
  const ev = await http('POST', '/events', { key: keyA, body: { type: 'ir_tx', payload: { protocol: 'NEC', code: '0x20DF10EF', bits: 32 } } });
  check('HTTP event accepted with api key', () => assert.strictEqual(ev.status, 201));
  await http('POST', '/events', { key: keyA, body: { type: 'power_on' } });
  let list = (await http('GET', '/devices', { admin: true })).body.devices;
  check('power_on event marks device running', () => assert.strictEqual(list.find((d) => d.id === 'esp-a').running, true));
  const evs = (await http('GET', '/devices/esp-a/events', { admin: true })).body.events;
  check('events stored newest first', () => { assert.strictEqual(evs.length, 2); assert.strictEqual(evs[1].payload.code, '0x20DF10EF'); });
  assert.strictEqual((await http('GET', '/devices/esp-b/events', { admin: true })).body.events.length, 0);

  // MQTT
  await assert.rejects(connect('esp-a', 'dk_wrong'));
  await assert.rejects(connect('esp-b', keyA)); // right key, wrong identity
  check('MQTT rejects bad credentials', () => {});
  const ca = await connect('esp-a', keyA);
  await sleep(150);
  list = (await http('GET', '/devices', { admin: true })).body.devices;
  check('MQTT connect -> online', () => assert.strictEqual(list.find((d) => d.id === 'esp-a').online, true));

  ca.publish('devices/esp-a/state', JSON.stringify({ running: false, fw: '1.0' }));
  ca.publish('devices/esp-a/event', JSON.stringify({ type: 'ir_rx', payload: { code: '0xABC' } }));
  ca.publish('devices/esp-b/state', JSON.stringify({ running: true })); // not allowed
  await sleep(300);
  list = (await http('GET', '/devices', { admin: true })).body.devices;
  const da = list.find((d) => d.id === 'esp-a');
  check('MQTT state updates running', () => assert.strictEqual(da.running, false));
  check('MQTT event recorded', () => assert.strictEqual(da.last_event.type, 'ir_rx'));
  check('cannot publish to another device topic', () => assert.strictEqual(list.find((d) => d.id === 'esp-b').running, null));
  assert.strictEqual(da.state.fw, '1.0');

  // takeover: same device reconnects, old session must not flip it offline
  const ca2 = await connect('esp-a', keyA);
  await sleep(300);
  list = (await http('GET', '/devices', { admin: true })).body.devices;
  check('reconnect takeover keeps device online', () => assert.strictEqual(list.find((d) => d.id === 'esp-a').online, true));

  // disconnect -> offline
  await new Promise((r) => ca2.end(true, r));
  await sleep(300);
  list = (await http('GET', '/devices', { admin: true })).body.devices;
  check('MQTT disconnect -> offline', () => assert.strictEqual(list.find((d) => d.id === 'esp-a').online, false));

  // rotate key kicks the session and invalidates the old key
  const cb = await connect('esp-b', keyB);
  const closed = new Promise((r) => cb.once('close', r));
  const rot = await http('POST', '/devices/esp-b/rotate-key', { admin: true });
  await Promise.race([closed, sleep(1500).then(() => { throw new Error('rotate did not drop session'); })]);
  check('rotate-key drops session', () => {});
  assert.strictEqual((await http('POST', '/events', { key: keyB, body: { type: 'x1' } })).status, 401);
  assert.strictEqual((await http('POST', '/events', { key: rot.body.api_key, body: { type: 'x1' } })).status, 201);
  check('old key dead, new key works', () => {});

  // delete cascades events
  assert.strictEqual((await http('DELETE', '/devices/esp-b', { admin: true })).status, 200);
  assert.strictEqual((await http('GET', '/devices/esp-b/events', { admin: true })).status, 404);
  check('delete works', () => {});

  // ------------------------------------------------ enrollment codes
  const DAY = 24 * 3600 * 1000;
  const en = await http('POST', '/devices', { admin: true, body: { name: 'New', id: 'esp-c', enroll: true } });
  assert.strictEqual(en.status, 201);
  const code = en.body.enrollment.code;
  check('enroll-mode device is created without an api key', () => {
    assert.ok(code.startsWith('en_'));
    assert.strictEqual(en.body.api_key, undefined);
    assert.strictEqual(en.body.device.enrolled, false);
    assert.ok(en.body.device.enrollment_expires_at > Date.now());
  });
  assert.strictEqual((await http('POST', '/enroll', { body: { device_id: 'esp-a', code } })).status, 401); // wrong device
  assert.strictEqual((await http('POST', '/enroll', { body: { device_id: 'esp-c', code: 'en_wrong' } })).status, 401);
  assert.strictEqual((await http('POST', '/enroll', { body: { device_id: 'esp-c' } })).status, 401);
  check('enroll rejects wrong device, bad code, missing code', () => {});
  const redeemed = await http('POST', '/enroll', { body: { device_id: 'esp-c', code } });
  assert.strictEqual(redeemed.status, 201);
  let keyC = redeemed.body.api_key;
  check('enroll returns key with ~90 day expiry', () => {
    assert.ok(keyC.startsWith('dk_'));
    assert.ok(Math.abs(redeemed.body.key_expires_at - (Date.now() + 90 * DAY)) < 60000);
  });
  assert.strictEqual((await http('POST', '/events', { key: keyC, body: { type: 'boot' } })).status, 201);
  assert.strictEqual((await http('POST', '/enroll', { body: { device_id: 'esp-c', code } })).status, 401);
  check('enrolled key works; code cannot be reused', () => {});

  // expired code
  const stale = await http('POST', '/devices/esp-c/enrollment', { admin: true, body: {} });
  assert.strictEqual(stale.status, 201);
  rawDb.prepare('UPDATE enrollments SET expires_at = ? WHERE used_at IS NULL').run(Date.now() - 1000);
  assert.strictEqual((await http('POST', '/enroll', { body: { device_id: 'esp-c', code: stale.body.code } })).status, 401);
  check('expired enrollment code is rejected', () => {});

  // re-provisioning: old key keeps working until the new code is redeemed, then dies and MQTT drops
  const again = await http('POST', '/devices/esp-c/enrollment', { admin: true, body: { ttl_hours: 2 } });
  assert.strictEqual((await http('POST', '/events', { key: keyC, body: { type: 'boot' } })).status, 201);
  const mc = await connect('esp-c', keyC);
  const mcClosed = new Promise((r) => mc.once('close', r));
  const re = await http('POST', '/enroll', { body: { device_id: 'esp-c', code: again.body.code } });
  assert.strictEqual(re.status, 201);
  await Promise.race([mcClosed, sleep(1500).then(() => { throw new Error('re-enroll did not drop session'); })]);
  assert.strictEqual((await http('POST', '/events', { key: keyC, body: { type: 'boot' } })).status, 401);
  keyC = re.body.api_key;
  assert.strictEqual((await http('POST', '/events', { key: keyC, body: { type: 'boot' } })).status, 201);
  check('re-enroll replaces old key and drops MQTT session', () => {});

  // new code revokes the previous unused one
  const c1 = await http('POST', '/devices/esp-c/enrollment', { admin: true, body: {} });
  const c2 = await http('POST', '/devices/esp-c/enrollment', { admin: true, body: {} });
  assert.strictEqual((await http('POST', '/enroll', { body: { device_id: 'esp-c', code: c1.body.code } })).status, 401);
  check('issuing a new code revokes the earlier unused one', () => {});
  rawDb.prepare('DELETE FROM enrollments WHERE used_at IS NULL').run();

  // ------------------------------------------------ device-side rotation
  const r1 = await http('POST', '/rotate', { key: keyC });
  assert.strictEqual(r1.status, 200);
  const k2 = r1.body.api_key;
  check('rotate returns a new key with a grace deadline', () => {
    assert.notStrictEqual(k2, keyC);
    assert.ok(r1.body.old_key_valid_until > Date.now());
  });
  assert.strictEqual((await http('POST', '/events', { key: keyC, body: { type: 'boot' } })).status, 201);   // old key, grace
  assert.strictEqual((await http('POST', '/events', { key: k2, body: { type: 'boot' } })).status, 201);     // new key proves itself
  assert.strictEqual((await http('POST', '/events', { key: keyC, body: { type: 'boot' } })).status, 401);   // old key retired
  check('old key works during grace, dies once new key is used', () => {});

  // grace window lapses without the new key ever being used
  const r2 = await http('POST', '/rotate', { key: k2 });
  const k3 = r2.body.api_key;
  rawDb.prepare('UPDATE devices SET prev_key_expires_at = ? WHERE id = ?').run(Date.now() - 1000, 'esp-c');
  assert.strictEqual((await http('POST', '/events', { key: k2, body: { type: 'boot' } })).status, 401);
  assert.strictEqual((await http('POST', '/events', { key: k3, body: { type: 'boot' } })).status, 201);
  check('old key is rejected after grace window ends', () => {});

  // new key never arrived (power cut): board retries /rotate with the old key
  const r3 = await http('POST', '/rotate', { key: k3 });
  const lost = r3.body.api_key;                       // pretend this response was lost
  const r4 = await http('POST', '/rotate', { key: k3 });   // via previous key
  assert.strictEqual(r4.status, 200);
  const k5 = r4.body.api_key;
  assert.strictEqual((await http('POST', '/events', { key: lost, body: { type: 'boot' } })).status, 401);
  assert.strictEqual((await http('POST', '/events', { key: k3, body: { type: 'boot' } })).status, 201);
  assert.strictEqual((await http('POST', '/events', { key: k5, body: { type: 'boot' } })).status, 201);
  check('retrying rotate with the old key recovers from a lost response', () => {});

  // ------------------------------------------------ expiry
  const hb = await http('POST', '/heartbeat', { key: k5 });
  check('heartbeat reports expiry; fresh key should not rotate', () => {
    assert.ok(hb.body.key_expires_at > Date.now());
    assert.strictEqual(hb.body.should_rotate, false);
  });
  rawDb.prepare('UPDATE devices SET key_expires_at = ? WHERE id = ?').run(Date.now() + 10 * DAY, 'esp-c');
  assert.strictEqual((await http('POST', '/heartbeat', { key: k5 })).body.should_rotate, true);
  check('heartbeat asks to rotate in the last third of the key life', () => {});

  const mq = await connect('esp-c', k5);
  rawDb.prepare('UPDATE devices SET key_expires_at = ? WHERE id = ?').run(Date.now() - 1000, 'esp-c');
  const expired = await http('POST', '/events', { key: k5, body: { type: 'boot' } });
  check('expired key is rejected with a clear error', () => {
    assert.strictEqual(expired.status, 401);
    assert.strictEqual(expired.body.error, 'api key expired');
  });
  await assert.rejects(connect('esp-c', k5));
  assert.strictEqual((await http('POST', '/rotate', { key: k5 })).status, 401);
  check('expired key cannot connect to MQTT or rotate itself', () => {});
  const swept = new Promise((r) => mq.once('close', r));
  sweepExpiredSessions();
  await Promise.race([swept, sleep(1500).then(() => { throw new Error('sweep did not drop expired session'); })]);
  check('sweep drops already-connected sessions once the key expires', () => {});

  // admin can always recover: manual key change gives a fresh expiry
  const man = await http('POST', '/devices/esp-c/rotate-key', { admin: true });
  assert.ok(man.body.key_expires_at > Date.now());
  assert.strictEqual((await http('POST', '/events', { key: man.body.api_key, body: { type: 'boot' } })).status, 201);
  check('admin rotate-key issues a fresh key with new expiry', () => {});

  // existing-style device (no expiry column value) never expires
  rawDb.prepare('UPDATE devices SET key_expires_at = NULL WHERE id = ?').run('esp-c');
  assert.strictEqual((await http('POST', '/events', { key: man.body.api_key, body: { type: 'boot' } })).status, 201);
  check('key with no expiry (legacy) never expires', () => {});

  // logout clears the session cookie
  const out = await http('POST', '/logout', { admin: true });
  assert.ok(/Max-Age=0/.test(out.setCookie[0]));
  check('logout clears cookie', () => {});

  // static UI
  const html = await (await fetch('http://127.0.0.1:18080/')).text();
  check('dashboard served', () => assert.ok(html.includes('ESP 裝置管理')));

  // failed-auth throttle (runs last: it locks this IP out for a minute)
  let status = 0;
  for (let i = 0; i < 70 && status !== 429; i++) status = (await http('POST', '/enroll', { body: { device_id: 'esp-c', code: 'en_x' + i } })).status;
  check('repeated bad enrollment attempts get throttled (429)', () => assert.strictEqual(status, 429));
  assert.strictEqual((await http('POST', '/login', { body: { username: 'boss', password: 'correct horse' } })).status, 429);
  check('throttle also covers login', () => {});

  console.log(`\n${ok} checks passed`);
  httpServer.close(); mqttServer.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
