const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addressCache } = require('./paddle-webhook');

test('Paddle address lookup times out and uses the last verified list during an outage', async () => {
  process.env.PADDLE_ENV = 'sandbox';
  let time = 0, calls = 0, offline = false;
  const lookup = addressCache({ now: () => time, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://sandbox-api.paddle.com/ips');
    assert.ok(options.signal instanceof AbortSignal);
    if (offline) throw new Error('network outage');
    return { ok: true, json: async () => ({ data: { ipv4_cidrs: ['34.1.2.3/32'] } }) };
  } });
  assert.deepEqual([...await lookup()], ['34.1.2.3']);
  time = 3600_001;
  offline = true;
  assert.deepEqual([...await lookup()], ['34.1.2.3'], 'an outage keeps the prior restrictive list');
  assert.equal(calls, 2);
});

test('missing or malformed address data fails closed when no trusted list exists', async () => {
  process.env.PADDLE_ENV = 'sandbox';
  for (const fetcher of [
    async () => { throw new Error('network outage'); },
    async () => ({ ok: true, json: async () => ({ data: { ipv4_cidrs: [] } }) }),
    async () => ({ ok: true, json: async () => ({ data: { ipv4_cidrs: [null] } }) }),
  ]) {
    await assert.rejects(addressCache({ fetcher }), (error) => error.status === 503);
  }
});
