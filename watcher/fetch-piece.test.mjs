import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPiece } from './fetch-piece.js';

test('stream downloads retry transient errors and do not accept an error page as media', async () => {
  let calls = 0;
  const delays = [];
  const bytes = await fetchPiece('https://example.test/segment', {
    fetcher: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      calls++;
      if (calls === 1) return { ok: false, status: 503 };
      if (calls === 2) throw new Error('connection reset');
      return { ok: true, arrayBuffer: async () => Buffer.from('media') };
    },
    pause: async (ms) => { delays.push(ms); },
  });
  assert.equal(bytes.toString(), 'media');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test('stream downloads stop after bounded failures, including empty content', async () => {
  let calls = 0;
  await assert.rejects(fetchPiece('https://example.test/init', {
    fetcher: async () => { calls++; return { ok: true, arrayBuffer: async () => Buffer.alloc(0) }; },
    pause: async () => {},
  }), /empty/);
  assert.equal(calls, 3);
});
