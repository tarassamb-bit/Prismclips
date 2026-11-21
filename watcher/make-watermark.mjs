// Draws the app's own moving watermark (UI/app/engine/render.js drawWatermark) as transparent 1080×1920 PNG frames, 30 a second,
// for one full loop of its four spots, so the live Shorts server can lay the identical watermark over its videos.
import { createRequire } from 'module';
import fs from 'fs';
// Run with the site's dev server on port 4173 and Playwright installed: node watcher/make-watermark.mjs watcher/wm
const require = createRequire(process.env.PLAYWRIGHT_DIR ?? import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4173/privacy', { waitUntil: 'load' });
const count = await page.evaluate(async () => {
  const { drawWatermark, loadWatermark } = await import('/app/engine/render.js');
  await loadWatermark();
  window.__canvas = new OffscreenCanvas(1080, 1920);
  window.__draw = async (t) => { const c = window.__canvas, ctx = c.getContext('2d'); ctx.clearRect(0, 0, 1080, 1920); drawWatermark(ctx, t);
    const blob = await c.convertToBlob({ type: 'image/png' }); const bytes = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  return Math.round((1.5 + 2.5 + 0.8 + 0.9) * 4 * 30);
});
for (let i = 0; i < count; i++) {
  const png = await page.evaluate((t) => window.__draw(t), i / 30);
  fs.writeFileSync(`${out}/${String(i).padStart(4, '0')}.png`, Buffer.from(png, 'base64'));
}
console.log('frames', count);
await browser.close();
