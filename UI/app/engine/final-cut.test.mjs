import test from 'node:test';
import assert from 'node:assert/strict';
import { batchedFinalCut } from './selection.js';

const clip = (i) => ({ start: i * 60, end: i * 60 + 30, score: (i * 7) % 10 });
const pool = Array.from({ length: 100 }, (_, i) => clip(i));

test('a small pool is one request', async () => {
  let calls = 0;
  await batchedFinalCut(pool.slice(0, 10), 3, async (part, n) => { calls++; return part.slice(0, n); });
  assert.equal(calls, 1);
});

test('a long pool is split into stretches and still returns count picks', async () => {
  const sizes = [];
  const out = await batchedFinalCut(pool, 30, async (part, n) => { sizes.push(part.length); return part.slice(0, n); });
  assert.deepEqual(sizes, [40, 40, 20]);
  assert.equal(out.length, 30);
});

test('a failed stretch keeps its best; all failed is null', async () => {
  let i = 0;
  const out = await batchedFinalCut(pool, 30, async (part, n) => (i++ === 1 ? null : part.slice(0, n)));
  assert.equal(out.length, 30);
  assert.equal(await batchedFinalCut(pool, 30, async () => { throw new Error('down'); }), null);
});
