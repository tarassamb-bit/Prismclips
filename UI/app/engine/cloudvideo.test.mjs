// Offline checks for the browser side of cloud videos (cloudvideo.js) against a stand-in /api/video: run with Node 24.
import assert from 'node:assert/strict';
import { uploadVideo, downloadVideo, removeVideos, cloudUsage, CloudVideoError } from '../cloudvideo.js';

let replies = [], calls = [], putStatus = 200, puts = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith('https://r2.test/')) return new Response(new Uint8Array(1000).fill(7), { headers: { 'Content-Length': '1000' } });
  const action = new URL(url, 'http://x').searchParams.get('action');
  calls.push([action, JSON.parse(options.body)]);
  const [status, body] = replies.shift() ?? [500, {}];
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
};
globalThis.XMLHttpRequest = class {
  upload = {};
  open(method, url) { this.url = url; }
  setRequestHeader() {}
  send(file) {
    puts.push(this.url);
    this.upload.onprogress?.({ lengthComputable: true, loaded: file.size / 2, total: file.size });
    this.status = putStatus;
    setTimeout(() => (putStatus ? this.onload() : this.onerror()));
  }
  abort() {}
};
const token = async () => 'jwt';
const media = { id: 'm1', name: 'talk.mp4' };
const file = new File([new Uint8Array(300)], 'talk.mp4', { type: 'video/mp4' });
const reset = (...list) => { replies = list; calls = []; puts = []; putStatus = 200; };
const never = () => { throw new Error('should not ask'); };

// Fits: link, upload with progress, finish.
reset([200, { url: 'https://r2.test/put', evicted: [] }], [200, { bytes: 300 }]);
const progress = [];
assert.deepEqual(await uploadVideo({ token, media, file, askRoom: never, onProgress: (p) => progress.push(p) }), { bytes: 300, evicted: [] });
assert.deepEqual(calls.map((c) => c[0]), ['upload', 'finish']);
assert.deepEqual(puts, ['https://r2.test/put']);
assert.deepEqual(progress, [0.5]);

// Already stored (the same file in another project): nothing is sent.
reset([200, { already: true, evicted: [] }]);
assert.deepEqual(await uploadVideo({ token, media, file, askRoom: never }), { bytes: 300, evicted: [], already: true });
assert.equal(puts.length, 0);

// No room: the person is asked; yes sends the exact list back, then uploads.
const evict = [{ mediaId: 'old', bytes: 200 }];
reset([409, { needsRoom: true, evict, cap: 500 }], [200, { url: 'https://r2.test/put', evicted: ['old'] }], [200, { bytes: 300 }]);
let asked = null;
assert.deepEqual(await uploadVideo({ token, media, file, askRoom: async (list, cap) => { asked = [list, cap]; return true; } }), { bytes: 300, evicted: ['old'] });
assert.deepEqual(asked, [evict, 500]);
assert.deepEqual(calls[1][1], { mediaId: 'm1', bytes: 300, confirm: true, evict: ['old'] });

// No, or not now: nothing is uploaded and nothing is deleted.
reset([409, { needsRoom: true, evict, cap: 500 }]);
await assert.rejects(uploadVideo({ token, media, file, askRoom: async () => false }), (e) => e.kind === 'declined');
reset([409, { needsRoom: true, evict, cap: 500 }]);
await assert.rejects(uploadVideo({ token, media, file, askRoom: async () => null }), (e) => e.kind === 'later');
assert.equal(calls.length, 1);
assert.equal(puts.length, 0);

// Too big for the whole cap, a list that changed meanwhile, the server not set up, a failed upload that already freed room.
reset([413, { tooBig: true, error: 'too big' }]);
await assert.rejects(uploadVideo({ token, media, file, askRoom: never }), (e) => e.kind === 'too_big');
reset([409, { needsRoom: true, evict, cap: 500 }], [409, { needsRoom: true, evict: [...evict, { mediaId: 'b', bytes: 1 }], cap: 500 }]);
await assert.rejects(uploadVideo({ token, media, file, askRoom: async () => true }), (e) => e.kind === 'later');
for (const reply of [[503, { error: 'Cloud video storage isn’t set up on the server yet.' }], [404, '<html>Not found</html>']]) {
  reset(reply);
  await assert.rejects(uploadVideo({ token, media, file, askRoom: never }), (e) => e.kind === 'unavailable');
}
reset([200, { url: 'https://r2.test/put', evicted: ['old'] }]); putStatus = 0;
await assert.rejects(uploadVideo({ token, media, file, askRoom: never }), (e) => e instanceof CloudVideoError && e.kind === 'failed' && e.evicted[0] === 'old');
reset([200, { url: 'https://r2.test/put', evicted: [] }], [413, { tooBig: true, error: 'over' }]);
await assert.rejects(uploadVideo({ token, media, file, askRoom: never }), (e) => e.kind === 'too_big');

// Download through a signed link, with progress; a removed video says so.
reset([200, { url: 'https://r2.test/get' }]);
const seen = [];
assert.equal((await downloadVideo({ token, mediaId: 'm1', type: 'video/mp4', onProgress: (p) => seen.push(p) })).size, 1000);
assert.equal(seen.at(-1), 1);
reset([404, { error: 'This video isn’t in the cloud anymore.' }]);
await assert.rejects(downloadVideo({ token, mediaId: 'gone', type: 'video/mp4' }), (e) => e.kind === 'failed' && /anymore/.test(e.message));

// Removal and usage.
reset([200, { deleted: 2 }]);
await removeVideos({ token, mediaIds: ['a', 'b'] });
assert.deepEqual(calls, [['delete', { mediaIds: ['a', 'b'] }]]);
reset([200, { used: 10, cap: 500, videos: [] }]);
assert.deepEqual(await cloudUsage({ token }), { used: 10, cap: 500, videos: [] });
console.log('cloud video checks passed');
