// Offline check of the model order: node UI/api/_gemini.test.js
// Stubs fetch (Supabase answers yes, every OpenRouter try fails) and records which model each try asked for.
const assert = require('node:assert/strict');
const handler = require('./gemini');

const USER = '11111111-2222-3333-4444-555555555555';
let calls = [];
global.fetch = async (url, init = {}) => {
  const ok = (body) => new Response(body === undefined ? '' : JSON.stringify(body), { status: 200 });
  if (url.includes('/auth/v1/user')) return ok({ id: USER });
  if (url.includes('/rest/v1/rpc/')) return ok(true);
  if (url.includes('/rest/v1/')) return ok();
  const body = JSON.parse(init.body);
  calls.push({ model: body.model, provider: body.provider });
  return new Response(JSON.stringify({ error: { message: 'stub failure' } }), { status: 500 });
};
console.error = () => {};
console.log = () => {};

const part = { audio: { inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }, image: { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }, text: { text: 'hi' } };
async function run(kind, extra = {}) {
  calls = [];
  const parts = kind === 'text' ? [part.text] : [part.text, part[kind]];
  const req = { method: 'POST', body: { contents: [{ parts }], ...extra }, headers: { 'x-prism-video': 'a'.repeat(64), 'x-prism-minutes': '5', authorization: 'Bearer t', apikey: 'k' } };
  const res = { statusCode: 0, setHeader() {}, end() {} };
  await handler(req, res);
  return calls.map((c) => c.model);
}

(async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  const mimo = 'xiaomi/mimo-v2.6-flash', ember = 'meta/muse-ember';

  assert.deepEqual(await run('audio'), [mimo, mimo, mimo]);
  assert.equal(calls[0].provider.order[0], 'makora');
  assert.deepEqual(calls[1].provider.ignore, ['makora']);
  assert.deepEqual(await run('image'), [mimo, ember, mimo]);
  assert.deepEqual(await run('text'), [mimo, ember, mimo]);
  // Judging requests start on Ember; audio never does, whatever the request says.
  assert.deepEqual(await run('text', { judge: true }), [ember, mimo, ember]);
  assert.deepEqual(await run('image', { judge: true }), [ember, mimo, ember]);
  assert.deepEqual(await run('audio', { judge: true }), [mimo, mimo, mimo]);
  // Every try keeps zero data retention.
  for (const kind of ['audio', 'image', 'text']) { await run(kind); for (const c of calls) assert.equal(c.provider.zdr, true); }

  // Even with a fallback set in the environment, audio never leaves MiMo.
  process.env.OPENROUTER_FALLBACK_MODEL = ember;
  assert.ok(!(await run('audio')).includes(ember));
  delete process.env.OPENROUTER_FALLBACK_MODEL;

  process.stdout.write('gemini model order: ok\n');
})().catch((error) => { process.stdout.write(`FAIL ${error.message}\n`); process.exit(1); });
