// Offline checks for the payment code: run `node selfcheck.js`. No network or real keys needed.
const assert = require('assert');
const crypto = require('crypto');
const { Readable } = require('stream');

Object.assign(process.env, {
  PADDLE_ENV: 'sandbox', PADDLE_API_KEY: 'pdl_test', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test', PADDLE_WEBHOOK_SECRET: 'whsec',
});
const { syncSubscription, paddle } = require('./api/_lib');
const webhook = require('./api/paddle-webhook');

const USER = '4ab15da9-b1b9-464a-b2a6-edf1d7e7dc8c';
let calls;
let subscription;
let insertStatus;
global.fetch = async (url, init = {}) => {
  calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
  if (url.startsWith('https://sandbox-api.paddle.com/subscriptions/')) return new Response(JSON.stringify({ data: subscription }));
  if (url.includes('/rest/v1/subscriptions')) return new Response(null, { status: init.method === 'POST' ? insertStatus : 204 });
  throw new Error(`Unexpected request: ${url}`);
};

function reset(customData) {
  calls = [];
  insertStatus = 201;
  subscription = {
    id: 'sub_1', customer_id: 'ctm_1', status: 'trialing', next_billed_at: null, scheduled_change: null,
    updated_at: '2026-10-22T09:55:51.577Z', custom_data: customData, items: [{ price: { id: 'pri_1' } }],
  };
}

function post(body, signature) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { method: 'POST', headers: { 'paddle-signature': signature } });
  return new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, end: (text) => resolve({ status: res.statusCode, body: JSON.parse(text) }) };
    webhook(req, res);
  });
}

const sign = (body, ts = Math.floor(Date.now() / 1000)) =>
  `ts=${ts};h1=${crypto.createHmac('sha256', 'whsec').update(`${ts}:${body}`).digest('hex')}`;

(async () => {
  reset({ supabase_user_id: USER });
  assert.strictEqual(await syncSubscription('sub_1'), 'synced');
  const [read, insert, update] = calls;
  assert.strictEqual(read.headers.Authorization, 'Bearer pdl_test');
  assert.match(insert.headers.Prefer, /ignore-duplicates/);
  assert.strictEqual(JSON.parse(insert.body).user_id, USER);
  assert.strictEqual(insert.headers.Authorization, undefined, 'sb_secret_ keys must not be sent as a Bearer token');
  assert.strictEqual(update.method, 'PATCH');
  assert.ok(update.url.includes('event_at=lt.2026-10-22T09%3A55%3A51.577Z'), 'only an older copy is overwritten');

  reset(null);
  assert.strictEqual(await syncSubscription('sub_1'), 'no user');
  assert.strictEqual(calls.length, 1, 'nothing is written for a purchase without a user');

  reset({ supabase_user_id: USER });
  insertStatus = 409;
  assert.strictEqual(await syncSubscription('sub_1'), 'unknown user');
  assert.strictEqual(calls.length, 2, 'no update after the account check fails');

  reset({ supabase_user_id: USER });
  const event = JSON.stringify({ event_type: 'subscription.updated', data: { id: 'sub_1' } });
  assert.strictEqual((await post(event, 'ts=1;h1=bad')).status, 401);
  assert.strictEqual((await post(event, sign(event, Math.floor(Date.now() / 1000) - 600))).status, 401, 'old signatures are refused');
  assert.strictEqual((await post(event.replace('updated', 'created'), sign(event))).status, 401, 'tampered bodies are refused');
  const now = Math.floor(Date.now() / 1000);
  assert.strictEqual((await post(event, `ts=${now};h1=${'é'.repeat(64)}`)).status, 401, 'non-ASCII signatures are rejected without throwing');
  assert.strictEqual((await post(event, `ts=${now};h1=${'z'.repeat(64)}`)).status, 401, 'non-hex signatures are rejected');
  assert.strictEqual(webhook.verify(event, `${sign(event, now)};h1=${'0'.repeat(64)}`, 'whsec'), true, 'key rotation accepts any valid signature');
  assert.strictEqual(webhook.verify(event, `ts=NaN;h1=${'0'.repeat(64)}`, 'whsec'), false, 'invalid timestamps are rejected');
  const other = JSON.stringify({ event_type: 'transaction.paid', data: { id: 'txn_1' } });
  assert.deepStrictEqual((await post(other, sign(other))).body, { ignored: true });
  assert.deepStrictEqual(await post(event, sign(event)), { status: 200, body: { result: 'synced' } });
  for (const malformed of ['null', '{"event_type":42}', '{"event_type":"subscription.updated","data":{"id":"../invalid"}}']) {
    assert.strictEqual((await post(malformed, sign(malformed))).status, 400, 'signed malformed events are rejected without a server error');
  }
  const savedFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => { throw new Error('Response stream closed'); } });
    await assert.rejects(() => paddle('/subscriptions/sub_1'), (error) => error.status === 502 && /didn’t respond/.test(error.message));
    for (const body of ['not JSON', '{"data":null}', '{}']) {
      global.fetch = async () => new Response(body);
      await assert.rejects(() => paddle('/subscriptions/sub_1'), (error) => error.status === 502, 'bad upstream envelopes must be reported as service failures');
    }
  } finally { global.fetch = savedFetch; }

  console.log('selfcheck: all payment checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
