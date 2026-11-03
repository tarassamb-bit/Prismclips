// Offline checks for the cloud video function (api/video.js): run `node video-check.js`. No network or real keys needed.
const assert = require('assert');
const { presign } = require('./api/_r2');

// The S3 signature matches Amazon's published example for a presigned GET.
const example = presign({
  method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1', expires: 86400,
  accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: new Date('2013-05-24T00:00:00Z'),
});
assert.match(example, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);

const USER = '4ab15da9-b1b9-464a-b2a6-edf1d7e7dc8c';
const OTHER = '11111111-2222-3333-4444-555555555555';
const MB = 1_000_000;
let objects, deleted, signedIn;
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname === '/auth/v1/user') return new Response(JSON.stringify(signedIn ? { id: USER } : {}), { status: signedIn ? 200 : 401 });
  assert.ok(u.searchParams.get('X-Amz-Signature'), 'every storage call is signed');
  const method = init.method || 'GET';
  if (u.pathname === '/prism-videos' && u.searchParams.get('list-type') === '2') {
    const prefix = u.searchParams.get('prefix');
    const items = [...objects].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>${v.at}</LastModified><Size>${v.bytes}</Size></Contents>`).join('');
    return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
  }
  const key = decodeURIComponent(u.pathname.replace('/prism-videos/', ''));
  if (method === 'HEAD') return objects.has(key) ? new Response(null, { headers: { 'content-length': String(objects.get(key).bytes) } }) : new Response(null, { status: 404 });
  if (method === 'DELETE') { deleted.push(key); objects.delete(key); return new Response(null, { status: 204 }); }
  throw new Error(`Unexpected call: ${method} ${url}`);
};
const handler = require('./api/video');

async function call(action, body = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const req = { method: 'POST', url: `/api/video?action=${action}`, headers: { authorization: 'Bearer token' }, [Symbol.asyncIterator]: () => chunks.values() };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.body = JSON.parse(text); } };
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}
const reset = (entries = []) => { objects = new Map(entries); deleted = []; signedIn = true; };

(async () => {
  // Not configured, and not signed in.
  reset();
  assert.equal((await call('usage')).status, 503);
  Object.assign(process.env, { R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK', R2_BUCKET: 'prism-videos' });
  signedIn = false;
  assert.equal((await call('usage')).status, 401);

  // Usage counts only this account's videos.
  reset([[`${USER}/a`, { bytes: 100 * MB, at: '2026-11-01T10:00:00Z' }], [`${OTHER}/x`, { bytes: 400 * MB, at: '2026-11-01T09:00:00Z' }]]);
  let r = await call('usage');
  assert.deepEqual([r.status, r.body.used, r.body.cap, r.body.videos.length], [200, 100 * MB, 1000 * MB, 1], 'the cap is 1 GB unless set');
  process.env.R2_CAP_MB = '500';
  assert.equal((await call('usage')).body.cap, 500 * MB);

  // The same file already stored (another project uses it): nothing is sent again.
  r = await call('upload', { mediaId: 'a', bytes: 100 * MB });
  assert.deepEqual([r.status, r.body.already, r.body.url], [200, true, undefined]);

  // A video bigger than the whole cap stays on the device.
  r = await call('upload', { mediaId: 'big', bytes: 600 * MB });
  assert.equal(r.status, 413);
  assert.ok(r.body.tooBig);
  assert.match(r.body.error, /500 MB of cloud space/);

  // A video that fits gets a signed upload link for this account's own path.
  r = await call('upload', { mediaId: 'new-1', bytes: 200 * MB });
  assert.equal(r.status, 200);
  assert.ok(r.body.url.startsWith(`https://acc.r2.cloudflarestorage.com/prism-videos/${USER}/new-1?`));
  assert.match(r.body.url, /X-Amz-Expires=3600/);

  // Over the cap: the oldest videos are named, nothing is deleted until the person agrees to exactly those.
  reset([
    [`${USER}/old`, { bytes: 250 * MB, at: '2026-10-01T10:00:00Z' }],
    [`${USER}/mid`, { bytes: 150 * MB, at: '2026-10-15T10:00:00Z' }],
    [`${USER}/newest`, { bytes: 50 * MB, at: '2026-10-30T10:00:00Z' }],
  ]);
  r = await call('upload', { mediaId: 'next', bytes: 350 * MB });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.evict.map((v) => v.mediaId), ['old', 'mid']);
  assert.equal(deleted.length, 0, 'nothing is deleted before the person agrees');
  r = await call('upload', { mediaId: 'next', bytes: 350 * MB, confirm: true, evict: ['old'] });
  assert.equal(r.status, 409, 'agreeing to a different list asks again');
  assert.equal(deleted.length, 0);
  r = await call('upload', { mediaId: 'next', bytes: 350 * MB, confirm: true, evict: ['old', 'mid'] });
  assert.equal(r.status, 200);
  assert.deepEqual(deleted, [`${USER}/old`, `${USER}/mid`]);
  assert.deepEqual(r.body.evicted, ['old', 'mid']);

  // What actually arrived is checked: over the cap it is removed again.
  reset([[`${USER}/a`, { bytes: 300 * MB, at: '2026-10-01T10:00:00Z' }], [`${USER}/b`, { bytes: 250 * MB, at: '2026-10-02T10:00:00Z' }]]);
  r = await call('finish', { mediaId: 'b' });
  assert.equal(r.status, 413);
  assert.deepEqual(deleted, [`${USER}/b`]);
  reset([[`${USER}/a`, { bytes: 300 * MB, at: '2026-10-01T10:00:00Z' }]]);
  r = await call('finish', { mediaId: 'a' });
  assert.deepEqual([r.status, r.body.bytes], [200, 300 * MB]);
  assert.equal((await call('finish', { mediaId: 'missing' })).status, 404);

  // Downloads only of videos that exist; deletes only inside this account; no way out of the account's folder.
  r = await call('download', { mediaId: 'a' });
  assert.ok(r.body.url.includes(`/prism-videos/${USER}/a?`));
  assert.equal((await call('download', { mediaId: 'gone' })).status, 404);
  reset([[`${USER}/a`, { bytes: 1, at: 'x' }], [`${OTHER}/a`, { bytes: 1, at: 'x' }]]);
  r = await call('delete', { mediaIds: ['a'] });
  assert.deepEqual(deleted, [`${USER}/a`]);
  assert.ok(objects.has(`${OTHER}/a`), 'another account’s video with the same id is untouched');
  for (const bad of ['../x', `${OTHER}/a`, 'a/b', '']) assert.equal((await call('download', { mediaId: bad })).status, 400, bad);
  assert.equal((await call('nonsense')).status, 400);

  // Deleting the account removes every one of its videos, and none of anyone else's.
  reset([[`${USER}/a`, { bytes: 1, at: 'x' }], [`${USER}/b`, { bytes: 1, at: 'x' }], [`${OTHER}/a`, { bytes: 1, at: 'x' }]]);
  r = await call('purge');
  assert.deepEqual([r.status, r.body.deleted, deleted.sort()], [200, 2, [`${USER}/a`, `${USER}/b`]]);
  assert.ok(objects.has(`${OTHER}/a`));

  console.log('video-check: signature, cap, oldest-first room with consent, size check, downloads and account isolation passed');
})().catch((error) => { console.error(error); process.exit(1); });
