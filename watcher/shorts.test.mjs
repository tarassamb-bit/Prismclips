// Offline check of the Short's span and captions: node watcher/shorts.test.mjs
import assert from 'node:assert/strict';
import { bounds, captionsFile } from './shorts.mjs';

assert.deepEqual(bounds({ start: 20, end: 70 }, 90, 60), { start: 20, end: 70 });
assert.deepEqual(bounds({ start: 10, end: 89 }, 90, 60), { start: 10, end: 70 }, 'at most 60 s');
assert.deepEqual(bounds({ start: 50, end: 52 }, 90, 60), { start: 40, end: 80 }, 'too short: around the moment');
assert.deepEqual(bounds(null, 90, 85), { start: 65, end: 90 }, 'no answer, moment near the end');
assert.deepEqual(bounds({ start: -5, end: 30 }, 90, 60), { start: 0, end: 30 });

const ass = captionsFile([{ text: 'no way', start: 21, end: 22.5 }, { text: '{bad}', start: 80, end: 81 }, { text: 'gone', start: 5, end: 6 }], 20, 70);
assert.match(ass, /Dialogue: 0,0:00:01.00,0:00:02.50,Main,,0,0,0,,NO WAY/);
assert.ok(!ass.includes('BAD') && !ass.includes('GONE'), 'captions outside the Short are dropped');
console.log('shorts: ok');
