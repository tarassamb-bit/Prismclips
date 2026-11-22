// The plan switch: only Relio's plan prices, never the current one, and a prorated PATCH of the active subscription.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const calls = [];
const lib = require('./_lib');
require.cache[path.join(__dirname, '_lib.js')].exports = {
  ...lib,
  requireEnv: () => {},
  getUser: async () => ({ id: 'user-1' }),
  supabase: async () => ({ response: { ok: true }, body: [{ id: 'sub_1', customer_id: 'ctm_1' }] }),
  paddle: async (url, init) => { calls.push({ url, init }); return { items: [{ price: { id: 'pri_01m7wxv785xs9pzn319erq7wtn' } }] }; },
  syncSubscription: async () => 'synced',
};
const handler = require('./billing');

function run(price) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body || '{}') }); } };
    handler({ method: 'POST', url: `/api/billing?action=change&price_id=${price}`, headers: {} }, res);
  });
}

test('switching to Creator patches the subscription with proration', async () => {
  calls.length = 0;
  const { status } = await run('pri_01m7wxv7jvh2e830hj69y0merw');
  assert.equal(status, 200);
  const patch = calls.find((c) => c.init?.method === 'PATCH');
  assert.equal(patch.url, '/subscriptions/sub_1');
  assert.deepEqual(JSON.parse(patch.init.body), { items: [{ price_id: 'pri_01m7wxv7jvh2e830hj69y0merw', quantity: 1 }], proration_billing_mode: 'prorated_immediately' });
});

test('the current plan and unknown prices are refused', async () => {
  calls.length = 0;
  assert.equal((await run('pri_01m7wxv785xs9pzn319erq7wtn')).status, 409);
  assert.equal((await run('pri_01m7wykejd7qj2jm895kpb8cyy')).status, 400, 'a pack is not a plan');
  assert.ok(!calls.some((c) => c.init?.method === 'PATCH'));
});
