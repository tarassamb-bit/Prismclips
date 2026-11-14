// Opens the games panel in a headless Chromium, starts a game, then reports the Shorts as ready: the "Shorts ready" banner
// must appear on top of the game (the topmost element at its centre is the banner) and its button must call onView.
// Needs a Chromium: CHROME=/path/to/chrome, or Playwright's headless shell in its default cache. Skipped without one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url)); // UI/
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
    const bin = join(cache, dir, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    if (existsSync(bin)) return bin;
  }
  return null;
}

const page = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app/app.css"></head><body>
<div id="progress" class="progress"></div><div id="games" class="games-dock" hidden></div>
<script type="module">
import { mountGames } from '/app/games/panel.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let viewed = false;
try {
  const games = mountGames(document.getElementById('games'), { db: () => null, signedIn: () => false, onView: () => { viewed = true; } });
  document.querySelector('[data-g="open"][data-id="stack"]').click();
  for (let i = 0; i < 50 && !document.querySelector('.game-canvas'); i++) await wait(20);
  if (!document.querySelector('.game-canvas')) throw new Error('the game did not start');
  games.ready(3);
  const banner = document.querySelector('.games-ready');
  if (banner.hidden) throw new Error('banner hidden');
  if (!banner.textContent.includes('Your Shorts are ready!')) throw new Error('banner text: ' + banner.textContent);
  const r = banner.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!banner.contains(top)) throw new Error('something covers the banner: ' + (top?.className || top?.tagName));
  if (!document.querySelector('.game-canvas')) throw new Error('the game was closed by the banner');
  banner.querySelector('[data-g="view"]').click();
  if (!viewed) throw new Error('View Shorts did nothing');
  document.title = 'PASS';
} catch (error) { document.title = 'FAIL: ' + error.message; }
</script></body></html>`;

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' };

test('the "Shorts ready" banner appears on top of an open game', { skip: !findChrome() && 'no headless Chromium found' }, async () => {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/banner-test.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
    try {
      const body = await readFile(join(root, path.replace(/^\/+/, '')));
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/banner-test.html`;
    const dom = await new Promise((resolve, reject) => execFile(findChrome(),
      ['--headless', '--disable-gpu', '--window-size=1280,900', '--virtual-time-budget=5000', '--dump-dom', url],
      { timeout: 30_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
    const title = dom.match(/<title>([^<]*)<\/title>/)?.[1] ?? 'no result';
    assert.equal(title, 'PASS');
  } finally { server.close(); }
});
