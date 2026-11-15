// Run with Node 24: node supabase/functions/signup-guard/guard.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

globalThis.Deno = { env: { get: () => undefined }, serve: () => {} };
const verdicts = [];
let cloudflare = { success: true };
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  verdicts.push(Object.fromEntries(options.body));
  if (cloudflare === 'down') throw new Error('offline');
  return Response.json(cloudflare);
};
const { handle, signedBySupabase } = await import('./index.ts');

const rawSecret = Buffer.from('a test signing secret of 32 bytes!').toString('base64');
const hookSecret = `v1,whsec_${rawSecret}`;
const env = (name) => ({ SIGNUP_HOOK_SECRET: hookSecret, TURNSTILE_SECRET: 'cf-secret' })[name];
const signed = (payload, { secret = rawSecret, at = Math.floor(Date.now() / 1000) } = {}) => {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', Buffer.from(secret, 'base64')).update(`msg_1.${at}.${body}`).digest('base64');
  return new Request('https://example.invalid/functions/v1/signup-guard', {
    method: 'POST', body, headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': String(at), 'webhook-signature': `v1,${signature}` },
  });
};
const signup = (metadata) => ({ metadata: { name: 'before-user-created', ip_address: '203.0.113.7' }, user: { email: 'a@b.co', user_metadata: metadata } });

// Only Supabase Auth can call it: unsigned, wrongly signed and replayed requests are refused before Cloudflare is asked.
assert.equal((await handle(new Request('https://x/', { method: 'POST', body: '{}' }), env)).status, 401);
assert.equal((await handle(signed(signup({ turnstile: 't' }), { secret: Buffer.from('another secret').toString('base64') }), env)).status, 401);
assert.equal((await handle(signed(signup({ turnstile: 't' }), { at: Math.floor(Date.now() / 1000) - 3600 }), env)).status, 401);
assert.equal(verdicts.length, 0);
assert.equal(await signedBySupabase('x', new Headers(), hookSecret), false);
console.log('PASS only signed, recent hook calls are answered');

// A sign-up passes only with a token Cloudflare accepts; the answer is the hook's error format.
let response = await handle(signed(signup({ turnstile: 'good-token' })), env);
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), {});
assert.deepEqual(verdicts.at(-1), { secret: 'cf-secret', response: 'good-token', remoteip: '203.0.113.7' });
// Refusals are HTTP 200 with an error object, the only form whose message Supabase Auth passes on.
const refusal = async (request) => { const r = await handle(request, env); assert.equal(r.status, 200); return (await r.json()).error?.http_code; };
assert.equal(await refusal(signed(signup({}))), 400, 'no token: refused');
cloudflare = { success: false, 'error-codes': ['timeout-or-duplicate'] };
assert.equal(await refusal(signed(signup({ turnstile: 'used-token' }))), 400, 'a token Cloudflare refuses');
cloudflare = { success: false, 'error-codes': ['invalid-input-secret'] };
assert.equal(await refusal(signed(signup({ turnstile: 'good-token' }))), 503, 'a wrong Turnstile secret is a setup problem, not the person');
cloudflare = 'down';
assert.equal(await refusal(signed(signup({ turnstile: 'good-token' }))), 503, 'Cloudflare unreachable: refused, not let through');
cloudflare = { success: true };
const noSecret = await handle(signed(signup({ turnstile: 'good-token' })), (n) => n === 'SIGNUP_HOOK_SECRET' ? hookSecret : undefined);
assert.equal((await noSecret.json()).error.http_code, 503, 'no Turnstile secret: fails closed');
const googleSignup = { ...signup({}), user: { email: 'g@b.co', user_metadata: {}, app_metadata: { provider: 'google' } } };
const asked = verdicts.length;
assert.deepEqual(await (await handle(signed(googleSignup), env)).json(), {}, 'Google sign-ups pass without a token');
assert.equal(verdicts.length, asked, 'Cloudflare is not asked for them');
assert.equal(await refusal(signed({ ...signup({}), user: { email: 'a@b.co', user_metadata: {}, app_metadata: { provider: 'email' } } })), 400, 'email sign-ups still need it');
console.log('PASS sign-ups need a Turnstile token Cloudflare accepts; failures refuse');
