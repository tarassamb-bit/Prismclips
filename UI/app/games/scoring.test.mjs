import test from 'node:test';
import assert from 'node:assert/strict';
import { cutBlock, maxStack, reactionScore, reactionDelay, shapeScore, LIMITS } from './scoring.js';
import { LOGOS } from './logos.js';

test('stack: overhang is cut off on either side and a full miss ends the game', () => {
  assert.deepEqual(cutBlock({ x: 0, w: 100 }, { x: 0, w: 100 }), { x: 0, w: 100 });
  assert.deepEqual(cutBlock({ x: 0, w: 100 }, { x: 30, w: 100 }), { x: 30, w: 70 });
  assert.deepEqual(cutBlock({ x: 50, w: 100 }, { x: 10, w: 100 }), { x: 50, w: 60 });
  assert.equal(cutBlock({ x: 0, w: 100 }, { x: 100, w: 100 }), null);
  assert.equal(cutBlock({ x: 0, w: 100 }, { x: -150, w: 100 }), null);
});

test('stack: height is bounded by time played', () => {
  assert.equal(maxStack(0), 1);
  assert.equal(maxStack(LIMITS.stackDropMs * 10), 11);
});

test('reaction: best of the valid rounds, early taps and impossible times are fails', () => {
  assert.equal(reactionScore([320, null, 251.6, 400, 290]), 252);
  assert.equal(reactionScore([null, null, null, null, null]), null);
  assert.equal(reactionScore([60, 280]), 280);
  for (const r of [0, 0.5, 0.999]) { const d = reactionDelay(() => r); assert.ok(d >= 1000 && d <= 4000); }
});

test('draw: an exact copy scores 100, at any size or position', () => {
  for (const logo of LOGOS) assert.equal(shapeScore(logo.strokes, logo.strokes), 100, logo.id);
  const relio = LOGOS[0].strokes;
  const moved = relio.map((s) => s.map(([x, y]) => [x * 3 + 40, y * 3 + 7]));
  assert.equal(shapeScore(moved, relio), 100);
});

test('draw: a rough copy scores well, a different shape scores lower, nothing scores 0', () => {
  const relio = LOGOS.find((l) => l.id === 'relio').strokes;
  const wobbly = relio.map((s) => s.map(([x, y], i) => [x + (i % 2 ? 0.03 : -0.02), y + (i % 2 ? -0.02 : 0.03)]));
  const rough = shapeScore(wobbly, relio);
  const wrong = shapeScore(LOGOS.find((l) => l.id === 'circle-square').strokes, relio);
  assert.ok(rough >= 70, `rough copy ${rough}`);
  assert.ok(wrong < rough, `different shape ${wrong} vs ${rough}`);
  assert.equal(shapeScore([], relio), 0);
  assert.equal(shapeScore([[[0.5, 0.5]]], relio), 0);
});
