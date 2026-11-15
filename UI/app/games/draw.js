// Draw the logo: a logo shows for 3 s, then hides; redraw it from memory with mouse or finger. Score 0–100 by how closely
// the drawing's outline matches the logo's. Loaded only when the player opens it (see panel.js).
import { shapeScore } from './scoring.js';
import { LOGOS } from './logos.js';

const SIZE = 300, SHOW_MS = 3000;

export function start(root, { onEnd }) {
  const title = document.createElement('p');
  title.className = 'draw-title';
  const canvas = document.createElement('canvas');
  canvas.className = 'game-canvas draw-canvas';
  canvas.setAttribute('aria-label', 'Drawing area');
  const scale = window.devicePixelRatio || 1;
  canvas.width = canvas.height = SIZE * scale;
  const actions = document.createElement('div');
  actions.className = 'row draw-actions';
  const clear = Object.assign(document.createElement('button'), { type: 'button', className: 'button ghost', textContent: 'Clear' });
  const done = Object.assign(document.createElement('button'), { type: 'button', className: 'button primary', textContent: 'Done' });
  actions.append(clear, done);
  root.replaceChildren(title, canvas, actions);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const css = getComputedStyle(root);
  const sky = css.getPropertyValue('--sky').trim() || '#3fa9f5';
  const ink = css.getPropertyValue('--text').trim() || '#0e0f14';

  let logo, strokes, phase, timer, started;
  const pad = 30, fit = ([x, y]) => [pad + x * (SIZE - pad * 2), pad + y * (SIZE - pad * 2)];
  function path(list, color, width) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = ctx.lineJoin = 'round';
    for (const stroke of list) {
      ctx.beginPath();
      stroke.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.stroke();
    }
  }
  function render() {
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (phase === 'show' || phase === 'scored') path(logo.strokes.map((s) => s.map(fit)), sky, phase === 'show' ? 5 : 3);
    if (phase !== 'show') path(strokes, ink, 4);
  }
  function round() {
    logo = LOGOS[Math.floor(Math.random() * LOGOS.length)];
    strokes = []; phase = 'show'; started = performance.now();
    title.textContent = `Remember this: ${logo.name}`;
    clear.hidden = done.hidden = true;
    render();
    timer = setTimeout(() => {
      phase = 'draw';
      title.textContent = `Now draw ${logo.name} from memory`;
      clear.hidden = done.hidden = false;
      done.textContent = 'Done';
      render();
    }, SHOW_MS);
  }
  const point = (event) => { const r = canvas.getBoundingClientRect(); return [(event.clientX - r.left) * (SIZE / r.width), (event.clientY - r.top) * (SIZE / r.height)]; };
  canvas.addEventListener('pointerdown', (event) => {
    if (phase !== 'draw') return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    strokes.push([point(event)]);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (phase !== 'draw' || !canvas.hasPointerCapture(event.pointerId)) return;
    strokes[strokes.length - 1].push(point(event));
    render();
  });
  clear.addEventListener('click', () => { strokes = []; render(); });
  done.addEventListener('click', () => {
    if (phase === 'scored') return round();
    const score = shapeScore(strokes, logo.strokes.map((s) => s.map(fit)));
    phase = 'scored';
    title.textContent = `${logo.name}: ${score} / 100`;
    clear.hidden = true;
    done.textContent = 'Next logo';
    render();
    onEnd(score, performance.now() - started);
  });
  round();
  return () => clearTimeout(timer);
}
