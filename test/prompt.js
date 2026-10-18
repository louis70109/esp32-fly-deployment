'use strict';
// public/ai-prompt.txt is the single source for the web copies; firmware/AI-PROMPT.md must show the same version A.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const norm = (t) => t.replace(/\r\n/g, '\n').trim();
const txt = norm(fs.readFileSync(path.join(root, 'public', 'ai-prompt.txt'), 'utf8'));
const md = fs.readFileSync(path.join(root, 'firmware', 'AI-PROMPT.md'), 'utf8').replace(/\r\n/g, '\n');
const block = (md.match(/````text\n([\s\S]*?)\n````/) || [])[1];

assert.ok(block, 'version A block missing in firmware/AI-PROMPT.md');
assert.strictEqual(norm(block), txt, 'firmware/AI-PROMPT.md version A differs from public/ai-prompt.txt - keep them identical');
console.log('  ok - AI prompt: markdown copy matches public/ai-prompt.txt');

for (const must of ['/api/v1/enroll', '/api/v1/heartbeat', '/api/v1/rotate', '/api/v1/events', 'X-API-Key', 'NVS', 'devices/<device_id>/status']) {
  assert.ok(txt.includes(must), 'prompt no longer mentions ' + must);
}
assert.ok(!/dk_[A-Za-z0-9_-]{12,}|en_[A-Za-z0-9_-]{16,}/.test(txt), 'prompt must not contain real keys or codes');
console.log('  ok - AI prompt covers the API surface and contains no secrets');
console.log('\n2 checks passed');
