// Offline check of the 7-day cleanup plan: node UI/api/_cleanup.test.js
const assert = require('node:assert/strict');
const { plan } = require('./cleanup');
const now = Date.parse('2026-11-20T00:00:00Z');
const day = (n) => new Date(now - n * 86_400_000).toISOString();
const video = (key) => ({ cloud: { uploaded: true, key } });
const rows = [
  { id: 'old', user_id: 'u', updated: day(8), media: [video('a'), video('shared')] },
  { id: 'fresh', user_id: 'u', updated: day(2), media: [video('shared')] },
  { id: 'never-edited', user_id: 'u', created: day(10), media: [video('b')] },
  { id: 'no-date', user_id: 'u', media: [video('c')] },
  { id: 'other-user', user_id: 'v', updated: day(9), media: [video('shared')] },
];
const result = plan(rows, now);
assert.deepEqual(result.projects.sort(), ['never-edited', 'old', 'other-user']);
// A video another project of the same account still uses stays; the same key under another account goes.
assert.deepEqual(result.videos.sort(), ['u/a', 'u/b', 'v/shared']);
console.log('cleanup checks passed');
