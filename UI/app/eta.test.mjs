import test from 'node:test';
import assert from 'node:assert/strict';
import { addSample, estimateLeft } from './eta.js';

test('a slow stage after a fast one: the recent speed decides', () => {
  const s = [];
  addSample(s, 0, 0.0);
  addSample(s, 60_000, 0.5);          // fast: half done in a minute
  for (let t = 70_000; t <= 300_000; t += 10_000) addSample(s, t, 0.5 + (t - 60_000) / 2_400_000); // then 1% per 24 s
  const left = estimateLeft(s, 300_000, 0);
  // At 60% with 1% per 24 s, about 16 min are left; the average since the start would say about 3.
  assert.ok(left > 800 && left < 1100, String(left));
});

test('nothing until 20 s and 3% in', () => {
  assert.equal(estimateLeft([{ at: 5_000, progress: 0.1 }], 10_000, 0), null);
  assert.equal(estimateLeft([{ at: 30_000, progress: 0.01 }], 30_000, 0), null);
});

test('smoothing: one odd reading moves the figure only part of the way', () => {
  const s = [{ at: 0, progress: 0.1 }, { at: 60_000, progress: 0.2 }];
  const fresh = estimateLeft(s, 60_000, 0);
  const smoothed = estimateLeft(s, 60_000, 0, { seconds: fresh * 3, at: 60_000 });
  assert.ok(smoothed > fresh && smoothed < fresh * 3);
});
