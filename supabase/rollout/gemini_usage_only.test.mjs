// Run with Node 24: node supabase/functions/gemini/security.test.mjs
import assert from 'node:assert/strict';

const env = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key', OPENROUTER_API_KEY: 'provider-test-key' };
let handler;
globalThis.Deno = { env: { get: (key) => env[key] }, serve: (fn) => { handler = fn; } };
const calls = [];
let identityStatus = 200, reservationStatus = 200, allowed = true, spendStatus = 200, runAllowed = true;
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, ...options });
  if (url.endsWith('/auth/v1/user')) return Response.json({ id: '12345678-1234-1234-1234-123456789abc' }, { status: identityStatus });
  if (url.endsWith('/rpc/prism_reserve_beta_usage')) return Response.json(allowed, { status: reservationStatus });
  if (url.endsWith('/rpc/prism_record_beta_spend')) return new Response(null, { status: spendStatus });
  if (url.endsWith('/rpc/prism_begin_analysis_run')) return Response.json(runAllowed);
  if (url === 'https://openrouter.ai/api/v1/chat/completions') return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0 } });
  throw new Error(`Unexpected URL: ${url}`);
};
await import('./gemini_usage_only.ts');
function request({ token = 'valid-user-token', minutes = '12', video = 'a'.repeat(64), run = null } = {}) {
  return new Request('https://example.invalid/functions/v1/gemini', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: 'public-test-key', 'x-prism-video': video, 'x-prism-minutes': minutes, ...(run ? { 'x-prism-run': run } : {}) },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'test' }] }] }),
  });
}
calls.length = 0;
assert.equal((await handler(new Request('https://example.invalid/functions/v1/gemini', {
  method: 'POST', headers: { Authorization: 'Bearer valid-user-token', apikey: 'public-test-key', 'x-prism-video': 'a'.repeat(64), 'x-prism-minutes': '12' }, body: '{',
}))).status, 400);
assert.equal(calls.length, 0, 'malformed requests must not count a video against the allowance');
for (const minutes of ['', '0', '-1', 'NaN', 'Infinity', '601']) {
  calls.length = 0;
  assert.equal((await handler(request({ minutes }))).status, 400);
  assert.equal(calls.length, 0, 'invalid duration must not reach either backend');
}
calls.length = 0;
identityStatus = 401;
assert.equal((await handler(request())).status, 401);
assert.equal(calls.length, 1, 'an invalid session must not reserve usage or call the provider');
identityStatus = 200;
calls.length = 0;
allowed = false;
assert.equal((await handler(request())).status, 429);
assert.equal(calls.length, 2, 'a refused allowance must not call the provider');
allowed = true;
calls.length = 0;
assert.equal((await handler(request())).status, 200);
assert.equal(calls.length, 4);
assert.equal(calls[1].headers.Authorization, 'Bearer server-only-test-key');
assert.equal(JSON.parse(calls[1].body).p_user, '12345678-1234-1234-1234-123456789abc');
assert.equal(calls[3].headers.Authorization, 'Bearer server-only-test-key');
assert.equal(JSON.parse(calls[3].body).p_user, '12345678-1234-1234-1234-123456789abc');
calls.length = 0;
reservationStatus = 503;
assert.equal((await handler(request())).status, 503);
assert.equal(calls.length, 2, 'accounting failures must fail closed');
reservationStatus = 200;
spendStatus = 503;
assert.equal((await handler(request())).status, 503, 'a spend recording error cannot be reported as a successful call');
console.log('PASS invalid video lengths, session verification, service-only usage calls and accounting failures');
