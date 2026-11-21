// Offline check of the 7-day cleanup plan: node UI/api/_cleanup.test.js
const assert = require('node:assert/strict');
const { plan, readProjects, cleanupExpired } = require('./cleanup');
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
assert.deepEqual(result.projects.map(({ user_id, id }) => `${user_id}/${id}`).sort(), ['u/never-edited', 'u/old', 'v/other-user']);
// A video another project of the same account still uses stays; the same key under another account goes.
assert.deepEqual(result.videos.sort(), ['u/a', 'u/b', 'v/shared']);
console.log('cleanup checks passed');

(async () => {
  const first = Array.from({ length: 500 }, (_, i) => ({ id: String(i).padStart(4, '0'), user_id: 'u', updated: day(8), media: i === 0 ? [video('shared')] : [] }));
  const fresh = { id: '0500', user_id: 'u', updated: day(1), media: [video('shared')] };
  const queries = [];
  const inventory = await readProjects(async (query) => {
    queries.push(query);
    return { response: { ok: true }, body: queries.length === 1 ? first : [fresh] };
  });
  assert.equal(inventory.length, 501);
  assert.match(queries[1], /user_id\.eq\.u,id\.gt\.0499/);
  assert.ok(!plan(inventory, now).videos.includes('u/shared'), 'a video referenced on a later page must stay');
  const sameId = plan([{ id: 'same', user_id: 'u', updated: day(8), media: [video('a')] }, { id: 'same', user_id: 'v', updated: day(1), media: [video('a')] }], now);
  assert.deepEqual(sameId.projects, [{ user_id: 'u', id: 'same' }]);
  assert.deepEqual(sameId.videos, ['u/a']);
  await assert.rejects(readProjects(async () => ({ response: { ok: false }, body: [] })), /Could not read projects/);
  await assert.rejects(readProjects(async () => ({ response: { ok: true }, body: first })), /Could not page through projects/);
  console.log('cleanup pagination checks passed');

  const old = { id: 'old', user_id: 'u', updated: day(8), updated_at: day(8), media: [video('shared')] };
  const changed = { ...old, updated: day(1), updated_at: day(1) };
  let reads = 0;
  const deletedVideos = [];
  const retained = await cleanupExpired(now, async (query, init) => {
    if (init?.method === 'DELETE') {
      assert.match(query, /updated_at\.eq\./, 'delete must check the exact version read');
      return { response: { ok: true }, body: [] }; // The project was edited before deletion.
    }
    reads++;
    return { response: { ok: true }, body: [old] };
  }, async (key) => deletedVideos.push(key));
  assert.deepEqual(retained, { projects: 0, videos: 0 });
  assert.deepEqual(deletedVideos, []);
  assert.equal(reads, 1);

  reads = 0;
  const after = await cleanupExpired(now, async (query, init) => {
    if (init?.method === 'DELETE') return { response: { ok: true }, body: [{ id: 'old' }] };
    reads++;
    return { response: { ok: true }, body: reads === 1 ? [old] : [{ ...changed, id: 'new' }] };
  }, async (key) => deletedVideos.push(key));
  assert.deepEqual(after, { projects: 1, videos: 0 }, 'a newly referenced video must be retained');
  assert.deepEqual(deletedVideos, []);

  reads = 0;
  const removed = await cleanupExpired(now, async (query, init) => {
    if (init?.method === 'DELETE') return { response: { ok: true }, body: [{ id: 'old' }] };
    return { response: { ok: true }, body: ++reads === 1 ? [old] : [] };
  }, async (key) => deletedVideos.push(key));
  assert.deepEqual(removed, { projects: 1, videos: 1 });
  assert.deepEqual(deletedVideos, ['u/shared']);
  deletedVideos.length = 0;

  await assert.rejects(cleanupExpired(now, async (query, init) => {
    if (init?.method === 'DELETE') return { response: { ok: true }, body: null };
    return { response: { ok: true }, body: [old] };
  }, async (key) => deletedVideos.push(key)), /Could not delete projects/);
  assert.deepEqual(deletedVideos, [], 'unknown delete results must not trigger file deletion');
  console.log('cleanup concurrent-edit checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
