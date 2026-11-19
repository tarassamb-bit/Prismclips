// Offline check that the live graph carries on across a restart: node watcher/graph.test.mjs
import assert from 'node:assert/strict';
const src = (await import('node:fs')).readFileSync(new URL('./watcher.mjs', import.meta.url), 'utf8');
// watcher.mjs starts the server when imported, so the function is taken out of its source and evaluated alone.
const code = src.slice(src.indexOf('export function withSaved'), src.indexOf('const running = new Map();')).replace('export ', '');
const withSaved = new Function(`${code}; return withSaved;`)();
const saved = { start: 0, loud: [0.5, 0.6, 0.7], chat: [1, 2, 3], hype: [0, 0.1, 0.2] };
const current = { start: 10_000, loud: [0.4, 0.4], chat: [5, 5], hype: [0, 0] };
const g = withSaved(current, saved);
assert.equal(g.start, 0);
assert.equal(g.loud.length, 12, 'saved seconds, the gap, then the new ones');
assert.deepEqual(g.loud.slice(0, 3), [0.5, 0.6, 0.7]);
assert.equal(g.loud[5], null, 'the restart is a gap, not invented data');
assert.equal(g.chat[5], null);
assert.deepEqual(g.loud.slice(-2), [0.4, 0.4]);
assert.equal(withSaved(current, null), current);
const old = { start: -900_000, loud: [0.5], chat: [1], hype: [0] };
assert.equal(withSaved(current, old), current, 'a graph saved long before is not used');
console.log('graph: ok');
