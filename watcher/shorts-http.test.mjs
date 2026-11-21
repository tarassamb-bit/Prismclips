import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { serve } from './shorts.mjs';

test('short playback handles malformed paths and byte ranges without stopping the server', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'relio-shorts-test-'));
  const name = '12345678-1234-1234-1234-123456789abc.mp4';
  await writeFile(path.join(dir, name), 'abcdefghij');
  const server = serve(0, { directory: dir, host: '127.0.0.1' });
  try {
    await once(server, 'listening');
    const get = (url, headers = {}) => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path: url, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal((await get('/%')).status, 400);
    assert.deepEqual((await get(`/${name}`, { Range: 'bytes=2-4' })).body, 'cde');
    const suffix = await get(`/${name}`, { Range: 'bytes=-100' });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers['content-range'], 'bytes 0-9/10');
    assert.equal(suffix.body, 'abcdefghij');
    assert.equal((await get(`/${name}`, { Range: 'bytes=30-' })).status, 416);
    assert.equal((await get('/health')).body, 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
