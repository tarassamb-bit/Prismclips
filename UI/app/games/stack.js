// Stack the tower, in 3D: a slab slides in from one side, then the other; tap or press Space to drop it. Whatever hangs
// over the slab below is cut off and falls away, so the tower narrows. Score = slabs stacked. Loaded only when the
// player opens it (see panel.js). Each drop is cut along the axis it slid on with the same cutBlock the server trusts.
import { cutBlock, LIMITS } from './scoring.js';

const W = 300, H = 400;
const SIZE = 100;          // the base slab's width and depth, in world units
const SLAB = 16;           // slab height
const K = 1.05;            // world units to pixels
const COS = Math.cos(Math.PI / 6), SIN = Math.sin(Math.PI / 6);

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

  let tower, moving, axis, direction, speed, started, lastDrop, over, frame, falling, camera;
  function reset() {
    tower = [{ x: 0, z: 0, w: SIZE, d: SIZE }];
    falling = []; over = false; speed = 1.4; camera = 0;
    started = performance.now(); lastDrop = 0;
    spawn();
  }
  // The next slab copies the top one and starts outside it on the axis it will slide along.
  function spawn() {
    const top = tower[tower.length - 1];
    axis = tower.length % 2 ? 'x' : 'z';
    direction = 1;
    moving = { ...top, [axis]: top[axis] - SIZE * 1.3 };
  }
  function drop() {
    const now = performance.now();
    if (over) { reset(); return; }
    // At most one drop per interval: keeps the score honest and matches the server's height check.
    if (now - lastDrop < LIMITS.stackDropMs) return;
    lastDrop = now;
    const top = tower[tower.length - 1];
    const size = axis === 'x' ? 'w' : 'd';
    const kept = cutBlock({ x: top[axis], w: top[size] }, { x: moving[axis], w: moving[size] });
    if (!kept) {
      falling.push({ ...moving, y: tower.length * SLAB, vy: 0, level: tower.length });
      over = true;
      onEnd(tower.length - 1, now - started);
      return;
    }
    // The overhang falls away on whichever side it stuck out.
    const cut = moving[size] - kept.w;
    if (cut > 0.5) {
      const piece = { ...moving, [size]: cut, [axis]: moving[axis] < kept.x ? moving[axis] : kept.x + kept.w };
      falling.push({ ...piece, y: tower.length * SLAB, vy: 0, level: tower.length });
    }
    tower.push({ ...moving, [axis]: kept.x, [size]: kept.w });
    speed = Math.min(4.2, speed + 0.1);
    spawn();
  }

  // World (x right-back, z left-back, y up) to screen, with the camera following the top of the tower.
  const project = (x, y, z) => [W / 2 + (x - z) * COS * K, H * 0.62 + (x + z - SIZE) * SIN * K - (y - camera) * K];
  const color = (level, light) => `hsl(${(250 - level * 7 + 360) % 360} 55% ${light}%)`;
  function face(points, fill) {
    ctx.beginPath();
    points.forEach(([x, y, z], i) => { const [sx, sy] = project(x, y, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  // A box: its top and the two sides that face the viewer, lit from above-left.
  function box({ x, z, w, d }, y, h, shade, alpha = 1) {
    ctx.globalAlpha = alpha;
    face([[x, y + h, z], [x + w, y + h, z], [x + w, y + h, z + d], [x, y + h, z + d]], shade(70));
    face([[x, y, z + d], [x + w, y, z + d], [x + w, y + h, z + d], [x, y + h, z + d]], shade(52));
    face([[x + w, y, z], [x + w, y, z + d], [x + w, y + h, z + d], [x + w, y + h, z]], shade(40));
    ctx.globalAlpha = 1;
  }
  const slab = (b, y, level, alpha) => box(b, y, SLAB, (light) => color(level, light), alpha);
  const teal = (light) => `hsl(190 45% ${light - 18}%)`;
  function background() {
    const g = ctx.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.45, H * 0.8);
    g.addColorStop(0, '#7fd8ff'); g.addColorStop(1, '#2a9be8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Soft sun rays around the centre.
    ctx.save();
    ctx.translate(W / 2, H * 0.45);
    ctx.fillStyle = 'rgb(255 255 255 / .07)';
    for (let i = 0; i < 16; i++) {
      ctx.rotate(Math.PI / 8);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-40, -H); ctx.lineTo(40, -H); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  function draw() {
    if (!over) {
      const top = tower[tower.length - 1];
      moving[axis] += direction * speed;
      if (moving[axis] > top[axis] + SIZE * 1.3) direction = -1;
      if (moving[axis] < top[axis] - SIZE * 1.3) direction = 1;
    }
    camera += (Math.max(0, (tower.length - 6) * SLAB) - camera) * 0.08;
    background();
    // A tall teal column under the tower, so it stands on something.
    box({ x: 0, z: 0, w: SIZE, d: SIZE }, camera - 600, 600 - camera, teal);
    tower.forEach((b, i) => slab(b, i * SLAB, i));
    if (!over) slab(moving, tower.length * SLAB, tower.length);
    falling = falling.filter((p) => p.y > camera - 400);
    for (const p of falling) { p.vy += 0.5; p.y -= p.vy; slab(p, p.y, p.level, 0.85); }
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgb(0 0 0 / .25)'; ctx.shadowBlur = 8;
    ctx.font = '700 40px Sora, system-ui, sans-serif';
    ctx.fillText(String(tower.length - 1), W / 2, 58);
    if (over) {
      ctx.font = '600 15px Sora, system-ui, sans-serif';
      ctx.fillText('Missed! Tap to play again', W / 2, 86);
    }
    ctx.shadowBlur = 0;
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
