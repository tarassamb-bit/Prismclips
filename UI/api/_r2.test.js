// Listing is used for quota enforcement and account purge. Never turn a partial response into a successful inventory.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { listObjects } = require('./_r2');

const response = (body) => ({ ok: true, text: async () => body });
const page = (truncated, contents = '', next = '') => `<ListBucketResult xmlns="urn:s3"><IsTruncated>${truncated}</IsTruncated>${contents}${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`;
const item = (key) => `<Contents><Key>${key}</Key><Size>17</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`;

test('lists beyond 20 pages with decoded continuation tokens', async () => {
  let calls = 0;
  const objects = await listObjects('u/', async (_method, _key, query) => {
    if (calls) assert.equal(query['continuation-token'], `next${calls}&`);
    calls++;
    return response(page(calls < 22, item(`u/video${calls}`), calls < 22 ? `next${calls}&amp;` : ''));
  });
  assert.equal(calls, 22);
  assert.equal(objects.length, 22);
  assert.equal(objects[21].key, 'u/video22');
});

test('rejects incomplete, repeated, and malformed listings instead of returning partial data', async () => {
  for (const xml of [page('true', item('u/a')), '<ListBucketResult><IsTruncated>false</IsTruncated><Contents>', page('false', item('other/a')), page('false', '<Contents><Key>u/a</Key><Size>oops</Size><LastModified>now</LastModified></Contents>')]) {
    await assert.rejects(listObjects('u/', async () => response(xml)), /video list/);
  }
  await assert.rejects(listObjects('u/', async () => response(page('true', item('u/a'), 'repeat'))), /incomplete video list/);
});
