// Stack the tower: a block slides left and right; tap or press Space to drop it. The overhang is cut off, so the next
// block is narrower. Score = blocks stacked. Loaded only when the player opens it (see panel.js).
import { cutBlock, LIMITS } from './scoring.js';

const W = 300, H = 400, ROW = 22, BASE = 180;

export function start(root, { onEnd }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'game-canvas';
  canvas.setAttribute('aria-label', 'Stack the tower. Tap or press Space to drop the block.');
  canvas.tabIndex = 0;
  const scale = window.devicePixelRatio || 1;
  canvas.width = W * scale; canvas.height = H * scale;
  root.replaceChildren(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const css = getComputedStyle(root);
  const sky = css.getPropertyValue('--sky').trim() || '#3fa9f5';
  const ink = css.getPropertyValue('--text').trim() || '#0e0f14';

  let tower, moving, direction, speed, started, lastDrop, over, frame;
  function reset() {
    tower = [{ x: (W - BASE) / 2, w: BASE }];
    moving = { x: 0, w: BASE };
    direction = 1; speed = 1.6; over = false;
    started = performance.now(); lastDrop = 0;
  }
  function drop() {
    const now = performance.now();
    if (over) { reset(); return; }
    // At most one drop per interval: keeps the score honest and matches the server's height check.
    if (now - lastDrop < LIMITS.stackDropMs) return;
    lastDrop = now;
    const kept = cutBlock(tower[tower.length - 1], moving);
    if (!kept) { over = true; onEnd(tower.length - 1, now - started); return; }
    tower.push(kept);
    moving = { x: direction > 0 ? -kept.w : W, w: kept.w };
    speed = Math.min(5, speed + 0.12);
  }
  function draw() {
    if (!over) {
      moving.x += direction * speed;
      if (moving.x + moving.w > W) { moving.x = W - moving.w; direction = -1; }
      if (moving.x < 0) { moving.x = 0; direction = 1; }
    }
    ctx.clearRect(0, 0, W, H);
    // The camera follows the top of the tower once it passes the middle.
    const lift = Math.max(0, (tower.length + 1) * ROW - H * 0.6);
    const y = (i) => H - (i + 1) * ROW + lift;
    tower.forEach((b, i) => { ctx.globalAlpha = 0.45 + 0.55 * ((i % 4) / 3); ctx.fillStyle = sky; ctx.fillRect(b.x, y(i), b.w, ROW - 2); });
    ctx.globalAlpha = 1;
    if (!over) { ctx.fillStyle = sky; ctx.fillRect(moving.x, y(tower.length), moving.w, ROW - 2); }
    ctx.fillStyle = ink;
    ctx.font = '600 22px Sora, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(tower.length - 1), W / 2, 34);
    if (over) {
      ctx.font = '500 15px Sora, system-ui, sans-serif';
      ctx.fillText('Missed! Tap to play again', W / 2, 62);
    }
    frame = requestAnimationFrame(draw);
  }
  const onPointer = (event) => { event.preventDefault(); drop(); };
  const onKey = (event) => {
    if (event.code !== 'Space' || event.target.closest?.('input,textarea,select,button')) return;
    event.preventDefault();
    drop();
  };
  canvas.addEventListener('pointerdown', onPointer);
  window.addEventListener('keydown', onKey);
  reset();
  draw();
  canvas.focus({ preventScroll: true });
  return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', onKey); };
}
