const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
process.env.MOTION_INDEX_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'motion-index-')), 'cache.json');
const handler = require('./motion-index');
async function request(body, reply) {
  const oldFetch = global.fetch, oldKey = process.env.MOTION_OPENROUTER_API_KEY; const upstreams = [];
  process.env.MOTION_OPENROUTER_API_KEY = 'test';
  global.fetch = async (_url, init) => { upstreams.push(JSON.parse(init.body)); return {ok: true, text: async () => JSON.stringify({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(reply)}}]})}; };
  const req = {method: 'POST', headers: {host: 'localhost:4173'}, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); }};
  const res = {setHeader() {}, end(value) { this.body = value; }};
  try { await handler(req, res); } finally { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.MOTION_OPENROUTER_API_KEY; else process.env.MOTION_OPENROUTER_API_KEY = oldKey; }
  return {res, upstreams};
}
const hash = 'a'.repeat(64), frame = 'data:image/jpeg;base64,YWJj';
test('describes a video from its frames once, then answers from the cache', async () => {
  const first = await request({hash, kind: 'video', frames: [frame, frame, frame]}, {description: 'A grey console on a desk.', tags: ['console']});
  assert.equal(first.res.statusCode, 200);
  assert.equal(JSON.parse(first.res.body).description, 'A grey console on a desk.');
  assert.equal(first.upstreams[0].messages[0].content.filter((p) => p.type === 'image_url').length, 3);
  assert.equal(first.upstreams[0].provider.zdr, true);
  assert.equal(first.upstreams[0].model, 'xiaomi/mimo-v2.6-flash');
  const again = await request({hash, kind: 'video', frames: [frame]}, {description: 'other'});
  assert.equal(again.upstreams.length, 0);
  assert.equal(JSON.parse(again.res.body).cached, true);
});
test('rejects bad hashes, kinds, frame counts and external URLs before any provider call', async () => {
  for (const body of [{hash: 'x', kind: 'image', frames: [frame]}, {hash, kind: 'audio', frames: [frame]}, {hash: 'b'.repeat(64), kind: 'image', frames: [frame, frame]}, {hash: 'c'.repeat(64), kind: 'image', frames: ['https://example.com/a.jpg']}]) {
    const {res, upstreams} = await request(body, {description: 'x'});
    assert.equal(res.statusCode, 400); assert.equal(upstreams.length, 0);
  }
});
test('refuses a non-local host', async () => {
  const req = {method: 'POST', headers: {host: 'relioclips.com'}, async *[Symbol.asyncIterator]() { yield '{}'; }};
  const res = {setHeader() {}, end(value) { this.body = value; }};
  await handler(req, res);
  assert.notEqual(res.statusCode, 200);
});
