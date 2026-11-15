// Relio Motion (dev only): The model writes a scene, a sandboxed frame runs it, and the canvas engine exports an MP4 here.
// The sandbox (allow-scripts, no same-origin) keeps generated code away from this site's sign-in and storage: it can only
// draw and send messages back.
import { Output, BufferTarget, Mp4OutputFormat, CanvasSource, canEncodeVideo } from '../vendor/mediabunny-1.61.5.min.mjs';
import * as store from '../app/store.js';

const $ = (selector) => document.querySelector(selector);
// The frame size follows the chosen format (see setFormat); 9:16 until one is picked.
const FORMATS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '3:4': [1080, 1440] };
let W = 1080, H = 1920, format = '9:16';
const player = $('#player'), status = $('#status');
try { const theme = localStorage.getItem('prism-theme'); if (theme) document.documentElement.dataset.theme = theme; } catch {}
let engine = 'canvas', code = '', prompt = '', scene = null, repaired = false, preview = 0, previewTimeout = 0, downloadUrl = null, lastGood = null, restoring = false;
let originalPrompt = '', history = [], pendingBrief = null;
let previewShown = false, reviewPass = 0, frameRequest = null, frameRequestId = 0, runToken = 0, workController = null;

const canvasRunner = () => `<!doctype html><html><head><style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style></head>
<body><canvas id="c" width="${W}" height="${H}"></canvas><script>
const c = document.getElementById('c'), ctx = c.getContext('2d');
let scene = null, playing = false, startAt = 0, currentTime = 0, lastUpdate = 0, pending = null, exportCancelled = false;
const say = (m, t) => parent.postMessage(m, '*', t || []);
let videos = [];
// Videos show their frame at scene time t (looping); exports and review frames seek and wait, so every frame is exact.
const videoTime = (v, t) => t % Math.max(0.001, v.duration);
const sync = (t) => Promise.all(videos.map((v) => new Promise((resolve) => { v.pause(); if (Math.abs(v.currentTime - videoTime(v, t)) < 0.001) return resolve(); v.onseeked = () => resolve(); v.currentTime = videoTime(v, t); })));
function loadMedia(list) {
  globalThis.MEDIA = {}; videos = [];
  return Promise.all((list || []).map((m) => new Promise((resolve, reject) => {
    const e = document.createElement(m.kind === 'video' ? 'video' : 'img');
    e.onerror = () => reject(new Error('An uploaded file could not be opened.'));
    if (m.kind === 'video') { e.muted = true; e.loop = true; e.playsInline = true; e.preload = 'auto'; e.onloadeddata = () => resolve(); videos.push(e); } else e.onload = () => resolve();
    e.src = URL.createObjectURL(m.file); MEDIA[m.id] = e;
  })));
}
const fail = (e) => { playing = false; say({ type: 'error', message: String((e && e.stack) || e).slice(0, 1500) }); };
function frame(t) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ${W}, ${H}); scene.draw(ctx, t); ctx.restore(); }
function loop() {
  if (!playing) return;
  try { currentTime = ((performance.now() - startAt) / 1000) % scene.duration; for (const v of videos) { if (v.paused) v.play().catch(() => {}); if (Math.abs(v.currentTime - videoTime(v, currentTime)) > 0.3) v.currentTime = videoTime(v, currentTime); } frame(currentTime); if (performance.now() - lastUpdate > 100) { say({type:'playback', time:currentTime, playing:true}); lastUpdate = performance.now(); } } catch (e) { return fail(e); }
  requestAnimationFrame(loop);
}
addEventListener('message', async (event) => {
  const m = event.data || {};
  if (m.type === 'load') {
    try {
      await loadMedia(m.media);
      scene = new Function(m.code + '\\n;return typeof scene === "undefined" ? undefined : scene;')();
      if (!scene || typeof scene.draw !== 'function') throw new Error('The code must define const scene = { width, height, fps, duration, draw(ctx, t) }.');
      scene.fps = Math.min(60, Math.max(12, Number(scene.fps) || 30));
      if (!(scene.duration > 0 && scene.duration <= 60)) throw new Error('scene.duration must be between 0 and 60 seconds.');
      // Every part of the video runs once now, so a crash shows before playback, not halfway through an export.
      for (let t = 0; t < scene.duration; t += 0.25) frame(t);
      say({ type: 'ready', fps: scene.fps, duration: scene.duration });
      playing = true; startAt = performance.now(); loop();
    } catch (e) { fail(e); }
  } else if (m.type === 'capture-review' && scene) {
    try {
      const frames = [], capture = document.createElement('canvas'); capture.width = ${Math.round(W / 1.5)}; capture.height = ${Math.round(H / 1.5)};
      const captureCtx = capture.getContext('2d');
      for (const fraction of [0.02, 0.24, 0.48, 0.72, 0.96]) {
        const time = Math.min(scene.duration - 1 / scene.fps, Math.max(0, scene.duration * fraction));
        await sync(time); frame(time); captureCtx.drawImage(c, 0, 0, capture.width, capture.height);
        frames.push({time, image:capture.toDataURL('image/jpeg', .7)});
      }
      // Stretches where the picture barely changes (mean pixel change under 1/255 every 0.5 s), so the review can call out a still video.
      const tiny = document.createElement('canvas'); tiny.width = 27; tiny.height = 48;
      const tinyCtx = tiny.getContext('2d', { willReadFrequently: true }), still = [];
      let before = null, runStart = null;
      for (let time = 0; time <= scene.duration - 1 / scene.fps; time += 0.5) {
        await sync(time); frame(time); tinyCtx.drawImage(c, 0, 0, 27, 48);
        const pixels = tinyCtx.getImageData(0, 0, 27, 48).data;
        if (before) {
          let change = 0; for (let i = 0; i < pixels.length; i += 4) change += Math.abs(pixels[i] - before[i]) + Math.abs(pixels[i + 1] - before[i + 1]) + Math.abs(pixels[i + 2] - before[i + 2]);
          if (change / (pixels.length * 0.75) < 1) runStart ??= time - 0.5;
          else { if (runStart !== null && time - 0.5 - runStart >= 1.5) still.push([runStart, time - 0.5]); runStart = null; }
        }
        before = pixels;
      }
      const end = Math.floor((scene.duration - 1 / scene.fps) * 2) / 2;
      if (runStart !== null && end - runStart >= 1.5) still.push([runStart, end]);
      frame(currentTime); say({type:'review-frames', requestId:m.requestId, frames, still});
    } catch (error) { say({type:'review-capture-error', requestId:m.requestId, message:String(error.message || error)}); }
  } else if (m.type === 'playback-control' && scene) {
    if (m.action === 'pause') { playing = false; videos.forEach((v) => v.pause()); say({type:'playback', time:currentTime, playing:false}); }
    if (m.action === 'seek') { currentTime = Math.max(0, Math.min(scene.duration - 1 / scene.fps, Number(m.time) || 0)); if (!playing) await sync(currentTime); frame(currentTime); startAt = performance.now() - currentTime * 1000; say({type:'playback', time:currentTime, playing}); }
    if (m.action === 'play' && !playing) { playing = true; startAt = performance.now() - currentTime * 1000; loop(); say({type:'playback', time:currentTime, playing:true}); }
  } else if (m.type === 'export') {
    playing = false; exportCancelled = false;
    const count = Math.round(scene.duration * scene.fps);
    try {
      for (let i = 0; i < count; i++) {
        await sync(i / scene.fps); frame(i / scene.fps);
        const bitmap = await createImageBitmap(c);
        await new Promise((resolve) => { pending = resolve; say({ type: 'frame', i, count, bitmap }, [bitmap]); });
        if (exportCancelled) break;
      }
      if (!exportCancelled) say({ type: 'done' });
    } catch (e) { return fail(e); }
    playing = true; startAt = performance.now(); loop();
  } else if (m.type === 'cancel-export') { exportCancelled = true; if (pending) { const go = pending; pending = null; go(); }
  } else if (m.type === 'next' && pending) { const go = pending; pending = null; go(); }
});
<\/script></body></html>`;

/** Generated HTML with a small bridge: it reports the timeline length and seeks it to the time the page asks for. */
const htmlRunner = (page) => {
  const bridge = `<script>(function(){var say=function(m){parent.postMessage(m,'*')};
addEventListener('error',function(e){say({type:'error',message:String(e.message||e)})});
addEventListener('message',function(e){var m=e.data||{};if(m.type==='seek'&&window.timeline)window.timeline.seek(m.t,false)});
addEventListener('load',function(){setTimeout(function(){if(!window.timeline||typeof window.timeline.seek!=='function')return say({type:'error',message:'The page must set window.timeline to a paused GSAP timeline.'});
window.timeline.pause();var d=window.timeline.duration();if(!(d>0))return say({type:'error',message:'The timeline has no length.'});say({type:'ready',fps:30,duration:d})},100)})})();<\/script>`;
  return /<\/body>/i.test(page) ? page.replace(/<\/body>/i, `${bridge}</body>`) : page + bridge;
};

function setStatus(text, isError = false) {
  status.textContent = text;
  if (isError) {
    const notice = document.createElement('div');
    notice.className = 'chat-error';
    notice.textContent = text;
    $('#conversation').append(notice);
    notice.scrollIntoView({ block: 'nearest' });
  }
}

function showThinking(text = 'Creating your video') {
  let indicator = $('#thinking');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'thinking';
    indicator.className = 'thinking';
    indicator.setAttribute('role', 'status');
    indicator.innerHTML = '<img class="thinking-avatar" src="/icon.png" alt=""><span class="thinking-content"><span class="thinking-label"></span><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>';
    $('#conversation').append(indicator);
  }
  indicator.querySelector('.thinking-label').textContent = text;
  indicator.scrollIntoView({ block: 'nearest' });
}
function hideThinking() { $('#thinking')?.remove(); }
let busy = false;
function updateComposer() {
  const input = $('#prompt');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  $('#make').disabled = busy || !input.value.trim();
}
function setBusy(nextBusy) {
  busy = nextBusy;
  updateComposer();
  $('#stop').hidden = !busy || !workController;
  $('#make').hidden = busy && Boolean(workController);
  $('#engine').disabled = busy;
  $('#style').disabled = busy;
  modelButton.disabled = busy;
  if (busy) closeModelMenu(false);
}
function addAssistantMessage(text) {
  const message = document.createElement('div');
  message.className = 'assistant-message';
  const avatar = document.createElement('img');
  avatar.className = 'thinking-avatar';
  avatar.src = '/icon.png';
  avatar.alt = '';
  const content = document.createElement('p');
  content.textContent = text;
  message.append(avatar, content);
  $('#conversation').append(message);
  message.scrollIntoView({ block: 'nearest' });
}

// ---------- the user's photos and videos: they stay in this browser; only small JPEG frames go to /api/motion-index ----------
const media = [];
const loadMedia = (item) => new Promise((resolve, reject) => {
  const element = document.createElement(item.kind === 'image' ? 'img' : 'video');
  element.onerror = () => reject(new Error(`${item.name} could not be opened.`));
  if (item.kind === 'image') element.onload = () => resolve(element);
  else { element.muted = true; element.preload = 'auto'; element.onloadeddata = () => resolve(element); }
  element.src = item.url;
});
const seekTo = (video, time) => new Promise((resolve) => { video.onseeked = () => resolve(); video.currentTime = time; });
function jpeg(source, width, height, max = 512) {
  const k = Math.min(1, max / Math.max(width, height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(width * k), height: Math.round(height * k) });
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}
function mediaThumbs(items, removable) {
  const box = el('div', { className: 'attachments' });
  for (const item of items) {
    const thumb = el('div', { className: `media-thumb${item.description ? '' : ' pending'}`, title: item.description || 'Looking at this file…' }, el('img', { src: item.thumb || '', alt: item.description || item.name }), el('span', { className: 'media-kind' }, item.kind === 'video' ? `▶ ${formatTime(item.duration)}` : ''));
    if (removable) thumb.append(el('button', { className: 'media-remove', type: 'button', ariaLabel: `Remove ${item.name}`, onclick: () => { media.splice(media.indexOf(item), 1); URL.revokeObjectURL(item.url); renderAttachments(); } }, '×'));
    box.append(thumb);
  }
  return box;
}
function renderAttachments() {
  const box = $('#attachments');
  box.replaceChildren(...mediaThumbs(media, true).children);
  box.hidden = !media.length;
}
async function addFiles(files) {
  for (const file of files) {
    const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : '';
    if (!kind) { setStatus(`${file.name} is not a photo or video.`, true); continue; }
    if (media.length >= 8) { setStatus('Add up to 8 photos or videos.', true); break; }
    const base = file.name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 18) || kind;
    let id = base; for (let n = 2; media.some((m) => m.id === id); n++) id = `${base}_${n}`;
    const item = { id, kind, name: file.name, file, url: URL.createObjectURL(file), description: '' };
    try {
      const element = await loadMedia(item);
      item.width = element.naturalWidth || element.videoWidth; item.height = element.naturalHeight || element.videoHeight;
      if (kind === 'video') item.duration = element.duration;
      // One frame for a photo, three for a video (10%, 50%, 90%), as small JPEGs.
      const frames = [];
      if (kind === 'image') frames.push(jpeg(element, item.width, item.height));
      else for (const f of [0.1, 0.5, 0.9]) { await seekTo(element, item.duration * f); frames.push(jpeg(element, item.width, item.height)); }
      item.thumb = jpeg(element, item.width, item.height, 160);
      media.push(item); renderAttachments();
      // shortcut: hashes the whole file in memory; fine for phone clips, stream it if multi-GB uploads matter.
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const response = await fetch('/api/motion-index', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash, kind, frames }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      item.description = data.description;
    } catch (error) {
      if (!media.includes(item)) URL.revokeObjectURL(item.url);
      item.description = item.description || `A ${kind} named ${file.name}.`;
      setStatus(`${file.name}: ${error.message}`, true);
    }
    renderAttachments();
  }
}
const mediaList = () => media.map(({ id, kind, width, height, duration, description }) => ({ id, kind, width, height, ...(kind === 'video' ? { duration } : {}), description: description || `A ${kind}.` }));
$('#attach').addEventListener('click', () => $('#attach-input').click());
$('#attach-input').addEventListener('change', (event) => { addFiles([...event.target.files]); event.target.value = ''; });
const composer = $('.composer');
composer.addEventListener('dragover', (event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); composer.classList.add('dragging'); } });
composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
composer.addEventListener('drop', (event) => { event.preventDefault(); composer.classList.remove('dragging'); addFiles([...event.dataTransfer.files]); });

function fit() {
  const box = player.parentElement.getBoundingClientRect();
  player.style.transform = `scale(${box.width / W})`;
}
addEventListener('resize', fit);
new ResizeObserver(fit).observe(player.parentElement);

let isPlaying = true;
function formatTime(seconds) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; }
function updatePlayback(time, playing) {
  isPlaying = playing;
  $('#play-toggle').textContent = playing ? '❚❚' : '▶';
  $('#play-toggle').setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
  $('#play-toggle').title = playing ? 'Pause preview' : 'Play preview';
  $('#play-time').textContent = formatTime(time);
  if (scene) $('#play-seek').value = Math.round(Math.max(0, Math.min(1, time / scene.duration)) * 1000);
}
$('#play-toggle').addEventListener('click', () => {
  if (!scene) return;
  player.contentWindow.postMessage({type:'playback-control', action:isPlaying ? 'pause' : 'play'}, '*');
});
$('#play-seek').addEventListener('input', (event) => {
  if (!scene) return;
  const time = Number(event.target.value) / 1000 * scene.duration;
  $('#play-time').textContent = formatTime(time);
  player.contentWindow.postMessage({type:'playback-control', action:'seek', time}, '*');
});

const editor = $('#editor'), divider = $('#divider');
function resizePanels(clientX) {
  const box = editor.getBoundingClientRect();
  const percent = Math.max(25, Math.min(65, (clientX - box.left) / box.width * 100));
  editor.style.setProperty('--chat-width', `${percent}%`);
  divider.setAttribute('aria-valuenow', Math.round(percent));
}
divider.addEventListener('pointerdown', (event) => { divider.setPointerCapture(event.pointerId); resizePanels(event.clientX); });
divider.addEventListener('pointermove', (event) => { if (divider.hasPointerCapture(event.pointerId)) resizePanels(event.clientX); });
divider.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const box = editor.getBoundingClientRect();
  resizePanels(box.left + box.width * (Number(divider.getAttribute('aria-valuenow')) + (event.key === 'ArrowRight' ? 2 : -2)) / 100);
});
function fitComposerSelect(select) {
  const measure = document.createElement('span');
  const font = getComputedStyle(select).font;
  Object.assign(measure.style, {position:'fixed', visibility:'hidden', whiteSpace:'pre', font});
  measure.textContent = select.selectedOptions[0]?.textContent || '';
  document.body.append(measure);
  select.style.width = `${Math.ceil(measure.getBoundingClientRect().width) + 42}px`;
  measure.remove();
}
for (const select of [$('#style')]) {
  select.addEventListener('change', () => fitComposerSelect(select));
  fitComposerSelect(select);
}
document.fonts.ready.then(() => fitComposerSelect($('#style')));

// Model menu. "Default" lets each step use its own model; the list in models.json is also the server's allowlist.
// Choices are remembered in this browser.
const STEPS = [['code', 'Writing the code'], ['plan', 'Planning'], ['check', 'Checking frames']];
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
const modelButton = $('#model-button'), modelMenu = $('#model-menu'), modelSub = $('#model-sub');
let models = [], picked = 'default', effort = 'medium', sub = null;
// Relio picks the models: GPT-6 Luna Pro writes and polishes (best cheap coder in the Nov 2026 test); cheap MiMo plans and checks frames.
// Each has a backup model in models.json.
let defaults = { code: 'openai/gpt-6-luna-pro', plan: 'xiaomi/mimo-v2.6-flash', check: 'xiaomi/mimo-v2.6-flash' };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const recall = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const stepModel = (step) => models.find((m) => m.id === (picked === 'default' ? defaults[step] : picked));
const showsEffort = () => picked === 'default' ? STEPS.some(([step]) => stepModel(step)?.effort) : Boolean(stepModel('code')?.effort);
/** The model for one step, plus the effort level when that model has one. Empty: the server default. */
function choiceFor(step) {
  const model = stepModel(step);
  return model ? { model: model.id, ...(model.effort ? { reasoning: effort } : {}) } : {};
}
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child != null));
  return node;
}
function menuItem({ label, note, badge, checked, value, onClick, role = 'menuitem', opens }) {
  const item = el('button', { type: 'button', className: 'menu-item', onclick: onClick });
  item.setAttribute('role', role);
  if (role === 'menuitemradio') item.setAttribute('aria-checked', String(Boolean(checked)));
  if (opens) { item.dataset.sub = opens; item.setAttribute('aria-haspopup', 'menu'); }
  item.append(...[
    el('span', { className: 'menu-text' }, el('span', {}, label, badge ? el('span', { className: 'menu-badge', textContent: badge }) : null), note ? el('small', { textContent: note }) : null),
    value ? el('span', { className: 'menu-value', textContent: value }) : null,
    opens ? el('span', { className: 'menu-arrow', textContent: '›', ariaHidden: 'true' }) : null,
    checked ? el('span', { className: 'menu-check', textContent: '✓', ariaHidden: 'true' }) : null,
  ].filter(Boolean));
  return item;
}
function renderModelButton() {
  $('#model-name').textContent = picked === 'default' ? 'Default' : stepModel('code')?.label || 'Default';
  $('#model-effort').textContent = showsEffort() ? EFFORTS.find(([key]) => key === effort)[1] : '';
}
function renderModelMenu() {
  modelMenu.replaceChildren(...[
    menuItem({ label: 'Default', note: 'Each step uses its own model. Change them in Settings', role: 'menuitemradio', checked: picked === 'default', onClick: () => pickModel('default') }),
    ...models.map((m) => menuItem({ label: m.label, note: m.price, role: 'menuitemradio', checked: picked === m.id, onClick: () => pickModel(m.id) })),
    el('div', { className: 'menu-sep', role: 'separator' }),
    showsEffort() ? menuItem({ label: 'Effort', value: EFFORTS.find(([key]) => key === effort)[1], opens: 'effort', onClick: () => openSub('effort', true) }) : null,
  ].filter(Boolean));
  renderModelButton();
}
// The Effort list opens beside the main menu, which stays open (fixed, so the chat panel can't clip it).
function openSub(key, focus) {
  sub = key;
  for (const row of modelMenu.querySelectorAll('[data-sub]')) { row.classList.toggle('active', row.dataset.sub === key); row.setAttribute('aria-expanded', String(row.dataset.sub === key)); }
  modelSub.hidden = !key;
  if (!key) return;
  if (key === 'effort') {
    modelSub.replaceChildren(el('p', { className: 'menu-hint', textContent: 'Higher effort gives more thorough results, but takes longer and costs more.' }),
      ...EFFORTS.map(([level, label]) => menuItem({ label, badge: level === 'medium' ? 'Recommended' : null, role: 'menuitemradio', checked: effort === level, onClick: () => { effort = level; remember('motion-reasoning', level); closeModelMenu(); } })));
  }
  const menu = modelMenu.getBoundingClientRect(), width = modelSub.offsetWidth;
  modelSub.style.left = `${menu.right + 6 + width <= innerWidth - 8 ? menu.right + 6 : Math.max(8, menu.left - 6 - width)}px`;
  modelSub.style.bottom = `${innerHeight - menu.bottom}px`;
  if (focus) (modelSub.querySelector('[aria-checked="true"]') || modelSub.querySelector('button, select'))?.focus();
}
function pickModel(id) { picked = id; remember('motion-model', id); closeModelMenu(); }
function openModelMenu() {
  renderModelMenu();
  modelMenu.hidden = false;
  modelButton.setAttribute('aria-expanded', 'true');
  (modelMenu.querySelector('[aria-checked="true"]') || modelMenu.querySelector('button'))?.focus();
}
function closeModelMenu(focusButton = true) {
  if (modelMenu.hidden) return renderModelButton();
  sub = null;
  modelMenu.hidden = modelSub.hidden = true;
  modelButton.setAttribute('aria-expanded', 'false');
  renderModelButton();
  if (focusButton) modelButton.focus();
}
modelButton.addEventListener('click', () => modelMenu.hidden ? openModelMenu() : closeModelMenu());
document.addEventListener('pointerdown', (event) => { if (!modelMenu.hidden && !event.target.closest('.model-picker')) closeModelMenu(false); });
// Hovering a row opens its list, or closes the open one, like a desktop menu.
modelMenu.addEventListener('pointerover', (event) => {
  const row = event.target.closest('.menu-item');
  if (row && (row.dataset.sub || null) !== sub) openSub(row.dataset.sub || null, false);
});
modelMenu.parentElement.addEventListener('keydown', (event) => {
  if (modelMenu.hidden) return;
  const inSub = modelSub.contains(event.target), row = () => modelMenu.querySelector(`[data-sub="${sub}"]`);
  if (event.key === 'Escape' || (inSub && event.key === 'ArrowLeft' && event.target.tagName !== 'SELECT')) {
    event.preventDefault();
    if (inSub) { const back = row(); openSub(null); back?.focus(); } else closeModelMenu();
    return;
  }
  if (!inSub && event.key === 'ArrowRight' && event.target.dataset?.sub) { event.preventDefault(); openSub(event.target.dataset.sub, true); return; }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.target.tagName === 'SELECT') return;
  event.preventDefault();
  const focusable = [...(inSub ? modelSub : modelMenu).querySelectorAll('button, select')];
  const next = focusable.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1);
  focusable[(next + focusable.length) % focusable.length]?.focus();
});
fetch('/motion/models.json').then((response) => response.json()).then((list) => {
  models = list;
  // No model choice for users: older saved picks are ignored.
  const savedEffort = recall('motion-reasoning');
  if (EFFORTS.some(([key]) => key === savedEffort)) effort = savedEffort;
  renderModelButton();
}).catch(() => setStatus('The model list could not be loaded, so the server default is used.', true));
$('#prompt').addEventListener('input', updateComposer);
// Every send is a paid generation, so on touch screens Return makes a new line and only the send button sends.
$('#prompt').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) { event.preventDefault(); $('#make').click(); } });
document.querySelectorAll('[data-suggestion]').forEach((button) => button.addEventListener('click', () => { $('#prompt').value = button.dataset.suggestion; updateComposer(); $('#prompt').focus(); }));

function recoverPreview(message) {
  workController?.abort();
  workController = null;
  hideThinking();
  if (!$('#prompt').value.trim()) $('#prompt').value = prompt;
  if (lastGood && !restoring) {
    setStatus(`${message} Restoring your last preview.`, true);
    restoring = true;
    repaired = true;
    pendingBrief = null;
    originalPrompt = lastGood.originalPrompt;
    history = lastGood.history.slice();
    engine = lastGood.engine;
    $('#engine').value = engine;
    $('#style').value = lastGood.style || '';
    fitComposerSelect($('#style'));
    showThinking('Restoring your last preview');
    run(lastGood.code);
  } else {
    restoring = false;
    pendingBrief = null;
    setBusy(false);
    setStatus(message, true);
  }
}

function run(source) {
  runToken++;
  code = source;
  $('#code').value = source;
  scene = null;
  $('#playback').hidden = true;
  cancelAnimationFrame(preview);
  clearTimeout(previewTimeout);
  previewTimeout = setTimeout(() => {
    recoverPreview('The preview could not start. Please try again.');
  }, 30000);
  $('#export').disabled = true;
  player.srcdoc = engine === 'canvas' ? canvasRunner() : engine === 'html' ? htmlRunner(source) : '<!doctype html><html><head><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#000}</style></head><body><div id="root"></div><script src="/motion/runtime/engine-player.js"></script></body></html>';
  fit();
}

player.addEventListener('load', () => { if (engine !== 'html' && code) player.contentWindow.postMessage({ type: 'load', code, engine, media: media.map(({ id, kind, file }) => ({ id, kind, file })) }, '*'); });

async function generate(extra = {}) {
  const response = await fetch('/api/motion', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: workController?.signal,
    // Outside a send (a crash during playback) pendingBrief is null, so fall back to the accepted brief, history and style.
    body: JSON.stringify({ prompt, engine, format, ...(seconds ? { seconds } : {}), originalPrompt: pendingBrief?.originalPrompt || originalPrompt || prompt, history: pendingBrief?.history || history, ...(engine === 'canvas' && media.length ? { media: mediaList() } : {}), style: pendingBrief ? pendingBrief.style : lastGood?.style || '', ...choiceFor('code'), ...(stepModel('plan') ? { plan: choiceFor('plan') } : {}), ...extra }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

$('#make').addEventListener('click', async () => {
  prompt = $('#prompt').value.trim();
  const nextEngine = $('#engine').value;
  if (!prompt) return setStatus('Describe the video first.', true);
  const previousEngine = engine;
  const hasPrevious = Boolean(scene);
  const previous = hasPrevious && engine === nextEngine ? code : '';
  pendingBrief = { originalPrompt: hasPrevious ? originalPrompt : prompt, history: hasPrevious ? history.slice() : [], style: $('#style').value, isRevision: hasPrevious, request: prompt };
  engine = nextEngine;
  $('.welcome')?.remove();
  const message = document.createElement('div');
  message.className = 'message';
  message.textContent = prompt;
  if (media.length) message.prepend(mediaThumbs(media, false));
  $('#conversation').append(message);
  message.scrollIntoView({ block: 'nearest' });
  $('#prompt').value = '';
  const work = new AbortController();
  workController = work;
  setBusy(true);
  $('#export').disabled = true;
  repaired = false;
  reviewPass = 0;
  showThinking(pendingBrief.style ? 'Planning and creating your video' : 'Creating your video');
  setStatus('Creating your video…');
  try {
    const data = await generate(previous ? { previous } : {});
    if (work.signal.aborted) return;
    showThinking('Preparing your preview');
    setStatus('Preparing your preview…');
    run(data.code);
  } catch (error) {
    if (work.signal.aborted) return;
    workController = null;
    hideThinking();
    setStatus(error.message, true);
    if (!$('#prompt').value.trim()) $('#prompt').value = prompt;
    engine = previousEngine;
    pendingBrief = null;
    setBusy(false);
    $('#export').disabled = !scene || engine !== 'canvas';
  }
});

$('#run').addEventListener('click', () => { engine = $('#engine').value; repaired = true; run($('#code').value); });

$('#stop').addEventListener('click', () => {
  if (!workController) return;
  workController.abort();
  workController = null;
  runToken++;
  clearTimeout(previewTimeout);
  if (frameRequest) { const request = frameRequest; frameRequest = null; request.reject(new Error('Stopped.')); }
  hideThinking();
  if (!$('#prompt').value.trim()) $('#prompt').value = prompt;
  pendingBrief = null;
  addAssistantMessage('Stopped.');
  if (lastGood) {
    restoring = true;
    repaired = true;
    originalPrompt = lastGood.originalPrompt;
    history = lastGood.history.slice();
    engine = lastGood.engine;
    $('#engine').value = engine;
    $('#style').value = lastGood.style || '';
    fitComposerSelect($('#style'));
    showThinking('Restoring your last preview');
    setBusy(true);
    run(lastGood.code);
  } else {
    scene = null;
    code = '';
    player.srcdoc = '';
    $('#playback').hidden = true;
    $('#empty').hidden = false;
    $('#export').disabled = true;
    setBusy(false);
    setStatus('Stopped.');
  }
});

function captureReviewFrames() {
  if (engine === 'html') return Promise.reject(new Error('Frame capture is unavailable for this engine.'));
  return new Promise((resolve, reject) => {
    const requestId = ++frameRequestId;
    const timer = setTimeout(() => { if (frameRequest?.requestId === requestId) frameRequest = null; reject(new Error('Frame capture timed out.')); }, 45000);
    frameRequest = {requestId, resolve:(frames) => {clearTimeout(timer); resolve(frames);}, reject:(error) => {clearTimeout(timer); reject(error);}};
    player.contentWindow.postMessage({type:'capture-review', requestId}, '*');
  });
}
async function captureStyleReference(style) {
  if (!style) return null;
  const response = await fetch('/api/motion-reference', {method:'POST', headers:{'Content-Type':'application/json'}, signal:workController?.signal, body:JSON.stringify({style})});
  const source = await response.json().catch(() => ({}));
  if (!response.ok || !source.helpers || !source.reference) throw new Error('The style reference could not be loaded.');
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('sandbox','allow-scripts');
  frame.title = 'Isolated style reference';
  const bridge = `<script>
addEventListener('message',function(e){if(e.source!==parent||e.data?.type!=='render-reference')return;try{
  new Function(e.data.helpers+'\\n'+e.data.reference)();
  const s=window.STYLES?.[0];if(!s||typeof s.draw!=='function')throw new Error('The style reference has no drawable frame.');
  const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
  s.draw(canvas.getContext('2d'),1280,720,Number(s.frameT)||0);
  const small=document.createElement('canvas');small.width=640;small.height=360;
  small.getContext('2d').drawImage(canvas,0,0,640,360);
  parent.postMessage({type:'reference-ready',image:small.toDataURL('image/jpeg',.75)},'*');
}catch(err){parent.postMessage({type:'reference-error',message:String(err.message||err)},'*')}});
<\/script>`;
  frame.srcdoc = '<!doctype html><html><body>' + bridge + '</body></html>';
  return new Promise((resolve,reject) => {
    let settled=false;
    const timer=setTimeout(() => finish(new Error('The style reference timed out.')),30000);
    function finish(error,image) {
      if (settled) return; settled=true; clearTimeout(timer); removeEventListener('message',receive); frame.remove();
      if(error) reject(error); else resolve(image);
    }
    function receive(event) {
      if(event.source!==frame.contentWindow) return;
      if(event.data?.type==='reference-ready' && typeof event.data.image==='string') finish(null,event.data.image);
      if(event.data?.type==='reference-error') finish(new Error('The style reference could not be drawn.'));
    }
    addEventListener('message',receive);
    frame.addEventListener('load',() => frame.contentWindow.postMessage({type:'render-reference',helpers:source.helpers,reference:source.reference},'*'),{once:true});
    document.body.append(frame);
  });
}
async function reviewFrames(frames, reference) {
  const response = await fetch('/api/motion-review', {
    method:'POST', headers:{'Content-Type':'application/json'}, signal:workController?.signal,
    body:JSON.stringify({brief:pendingBrief?.originalPrompt || originalPrompt || prompt, history:pendingBrief?.history || history, latest:prompt, style:pendingBrief?.style || '', frames, ...choiceFor('check'), ...(reference ? {reference} : {})}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Visual review failed.');
  if (!Array.isArray(data.issues)) throw new Error('Visual review returned an invalid result.');
  return data.issues;
}


addEventListener('message', async (event) => {
  if (event.source !== player.contentWindow) return;
  const m = event.data || {};
  if ((m.type === 'review-frames' || m.type === 'review-capture-error') && frameRequest?.requestId === m.requestId) {
    const request = frameRequest; frameRequest = null;
    if (m.type === 'review-frames') request.resolve(Object.assign(m.frames, { still: Array.isArray(m.still) ? m.still : [] })); else request.reject(new Error(m.message || 'Frame capture failed.'));
    return;
  }
  if (m.type === 'ready') {
    const token = runToken;
    clearTimeout(previewTimeout);
    scene = { fps: m.fps, duration: m.duration };
    $('#play-duration').textContent = formatTime(m.duration);
    $('#playback').hidden = false;
    updatePlayback(0, true);
    $('#empty').hidden = true;
    $('#result').hidden = true;
    $('#result').removeAttribute('src');
    if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
    $('#export').innerHTML = '↓ &nbsp; Export MP4';
    let reviewMessage = '';
    if (!restoring) {
      try {
        reviewPass++;
        showThinking('Checking how it looks');
        const [frames, reference] = await Promise.all([captureReviewFrames(), captureStyleReference(pendingBrief?.style || '')]);
        reviewThumb = frames[Math.floor(frames.length / 2)]?.image ?? null;
        if (token !== runToken) return;
        const stillIssues = (frames.still || []).map(([from, to]) => `From ${from.toFixed(1)}s to ${to.toFixed(1)}s almost nothing moves: keep something animating the whole time.`);
        const issues = [...stillIssues, ...await reviewFrames(frames, reference)].slice(0, 4);
        if (token !== runToken) return;
        // Every new video gets one polish pass (the test's best setup), fixing any issues the check found.
        if (reviewPass === 1 && pendingBrief) {
          showThinking(issues.length ? 'Fixing issues found in the video' : 'Polishing your video');
          const polish = 'Second pass: make this video much better. Add detail and craft to every illustration and the background, fill empty areas of the frame, make the visual story clearer, and keep something moving at every moment. Keep the exact text and its order.';
          const correction = await generate({previous:code, visualFeedback:[...issues, polish].join('\n')});
          if (token !== runToken) return;
          if (!lastGood) lastGood = {engine, code, originalPrompt:pendingBrief?.originalPrompt || prompt, history:pendingBrief?.history || [], style:pendingBrief?.style || ''};
          run(correction.code);
          return;
        }
        reviewMessage = issues.length ? `Your video is ready, but a few things may need fixing: ${issues.join(' ')} Ask me to fix them, or describe another change.`
          : 'Your video is ready. Tell me what to change, or press Export MP4 to save it.';
      } catch (error) {
        if (token !== runToken) return;
        reviewMessage = 'Your video is ready. I couldn’t finish checking how it looks, so watch it through before you export.';
      }
    }
    hideThinking();
    workController = null;
    setBusy(false);
    if (restoring) {
      restoring = false;
      addAssistantMessage(opening ? 'Your saved video is open. Tell me what to change, or press Export MP4 to save it.' : 'Your last working preview is back. You can try that change again.');
      opening = false;
    } else {
      const selectedStyle = pendingBrief?.style || '';
      if (pendingBrief) {
        originalPrompt = pendingBrief.originalPrompt;
        history = pendingBrief.history;
        if (pendingBrief.isRevision) history = [...history, { role: 'user', content: pendingBrief.request }].slice(-8);
        pendingBrief = null;
      }
      lastGood = { engine, code, originalPrompt, history: history.slice(), style: selectedStyle };
      addAssistantMessage(reviewMessage);
      saveVideo();
    }
    $('#make').setAttribute('aria-label', 'Send changes');
    $('#make').title = 'Send changes';
    $('#export').disabled = engine !== 'canvas';
    setStatus(`Playing · ${m.duration.toFixed(1)} s at ${m.fps} fps${engine === 'canvas' ? '' : ' · preview only'}.`);
    if (engine === 'html') playHtml();
    // On a phone the preview sits below the chat: bring it into view the first time a video is ready.
    if (!previewShown && matchMedia('(max-width: 650px)').matches) $('.preview-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
    previewShown = true;
  } else if (m.type === 'error') {
    runToken++;
    clearTimeout(previewTimeout);
    if (exporter) { exportFailed(new Error(m.message || 'The preview stopped during export')); return; }
    // One automatic repair: The model gets its own code and the error. A second failure is shown for a manual edit.
    if (!repaired && prompt) {
      repaired = true;
      setBusy(true);
      showThinking('Fixing the preview');
      setStatus('Fixing the preview…');
      const repairToken = runToken;
      try { const result = await generate({ previous: code, error: m.message }); if (repairToken === runToken) run(result.code); } catch (error) { if (repairToken === runToken) recoverPreview(error.message); }
    } else {
      recoverPreview(`The preview failed: ${String(m.message || 'Unknown error').split('\n')[0]}.`);
    }
  } else if (m.type === 'playback' && scene) {
    updatePlayback(Number(m.time) || 0, Boolean(m.playing));
  } else if (m.type === 'frame') {
    await exporter?.frame(m);
  } else if (m.type === 'done') {
    await exporter?.done();
  }
});

/** Plays the HTML engine by seeking its paused timeline every frame, so the preview shows exactly what an export would. */
function playHtml() {
  const started = performance.now();
  const tick = () => {
    if (!scene || engine !== 'html') return;
    player.contentWindow.postMessage({ type: 'seek', t: ((performance.now() - started) / 1000) % scene.duration }, '*');
    preview = requestAnimationFrame(tick);
  };
  tick();
}

let exporter = null;
// One button: "Export MP4" until an MP4 exists for the current video, then "Download MP4".
const setExportLabel = (text) => { $('#export').innerHTML = `↓ &nbsp; ${text}`; };
function showExportProgress(percent) {
  const box = $('#export-progress');
  box.hidden = percent == null;
  if (percent != null) { box.querySelector('progress').value = percent; box.querySelector('span').textContent = `${percent}%`; }
}
function exportFailed(error) {
  showExportProgress(null);
  player.contentWindow.postMessage({ type: 'cancel-export' }, '*');
  exporter = null;
  hideThinking();
  setBusy(false);
  $('#export').disabled = !scene || engine !== 'canvas';
  setStatus(`Export failed: ${error.message || error}. Please try again.`, true);
}
$('#export').addEventListener('click', async () => {
  if (!scene || engine !== 'canvas') return;
  if (downloadUrl) { Object.assign(document.createElement('a'), { href: downloadUrl, download: 'relio-motion.mp4' }).click(); return; }
  setBusy(true);
  $('#export').disabled = true;
  showThinking('Preparing your export');
  try {
    const codec = (await canEncodeVideo('avc', { width: W, height: H, bitrate: 10e6 }).catch(() => false)) ? 'avc' : null;
    if (!codec) throw new Error('This browser cannot encode H.264 video. Try Chrome or Safari');
    const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d');
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const source = new CanvasSource(canvas, { codec, bitrate: 10e6, keyFrameInterval: 2, latencyMode: 'realtime' });
    output.addVideoTrack(source, { frameRate: scene.fps });
    await output.start();
    const fps = scene.fps;
    exporter = {
      async frame({ i, count, bitmap }) {
        try {
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          await source.add(i / fps, 1 / fps);
          const percent = Math.round((i + 1) / count * 100);
          showThinking(`Exporting video · ${percent}%`);
          showExportProgress(percent);
          player.contentWindow.postMessage({ type: 'next' }, '*');
        } catch (error) { bitmap.close(); exportFailed(error); }
      },
      async done() {
        try {
          showThinking('Finishing your export');
          source.close();
          await output.finalize();
          if (downloadUrl) URL.revokeObjectURL(downloadUrl);
          downloadUrl = URL.createObjectURL(new Blob([output.target.buffer], { type: 'video/mp4' }));
          Object.assign($('#result'), { src: downloadUrl, hidden: false });
          showExportProgress(null);
          setExportLabel('Download MP4');
          exporter = null;
          hideThinking();
          setBusy(false);
          $('#export').disabled = false;
          addAssistantMessage('Your MP4 is ready. Press Download MP4 at the top to save it.');
          setStatus('Your MP4 is ready to download.');
        } catch (error) { exportFailed(error); }
      },
    };
    showThinking('Exporting video · 0%');
    showExportProgress(0);
    player.contentWindow.postMessage({ type: 'export' }, '*');
  } catch (error) { exportFailed(error); }
});

// Saved videos. A Motion video is kept as a project next to the Shorts projects, so Home lists both. Only its code, brief
// and a small picture are stored (a few kilobytes, synced with the account like any project): no video file, so it costs
// almost nothing to keep, and it is drawn again from the code when opened.
let projectId = new URLSearchParams(location.search).get('project'), reviewThumb = null, opening = false;
/** The signed-in account's id, read from where the app's sign-in keeps it. Null when signed out. */
function signedInUser() {
  try { for (const key of Object.keys(localStorage)) if (/^sb-.+-auth-token$/.test(key)) return JSON.parse(localStorage.getItem(key))?.user?.id ?? null; } catch {}
  return null;
}
/** A review frame shrunk to a card-sized picture. */
function smallThumb(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 270, height: Math.round(270 * H / W) });
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}
async function saveVideo() {
  if (!lastGood) return;
  try {
    projectId ??= crypto.randomUUID();
    const existing = await store.loadProject(projectId);
    const thumbnail = (reviewThumb && await smallThumb(reviewThumb)) || existing?.motion?.thumbnail || null;
    const title = lastGood.originalPrompt.replace(/\s+/g, ' ').trim();
    await store.saveProject({
      ...(existing ?? { id: projectId, owner: signedInUser() ?? undefined, created: new Date().toISOString(), media: [], segments: [], transcripts: {} }),
      kind: 'motion', title: existing?.title ?? (title.length > 60 ? `${title.slice(0, 57)}…` : title || 'Motion video'),
      motion: { ...lastGood, format, seconds, duration: scene?.duration ?? 0, thumbnail },
    });
    // `history` here is the chat history, so the browser's is named in full.
    window.history.replaceState(null, '', `/motion/?project=${projectId}`);
  } catch { setStatus('This video could not be saved in this browser. Export it to keep it.', true); }
}
// A new video starts on a full screen with two choices, like the Create Shorts steps: style and format. The
// format can't change afterwards: the code is written for one frame size.
const STYLE_CHOICES = [['', 'No style', 'Relio picks the look'], ['flat-vector-science', 'Flat-Vector Science', 'Clean shapes, like an explainer'],
  ['watercolor-wash', 'Watercolor Wash', 'Soft, painted look'], ['shadow-puppet-theatre', 'Shadow Puppet Theatre', 'Dark cut-out figures']];
const FORMAT_CHOICES = [['9:16', 'Vertical', 'TikTok, Reels, Shorts'], ['16:9', 'Wide', 'YouTube, presentations'], ['3:4', 'Portrait', 'Instagram and feed posts']];
const SETUP_STEPS = ['style', 'format'];
// One picture per style, drawn once and kept while the page is open.
const stylePictures = new Map();
// The length is never asked: Relio picks it. Older projects may still carry a saved length.
let seconds = 0;
function setFormat(value) {
  format = Object.hasOwn(FORMATS, value) ? value : '9:16';
  [W, H] = FORMATS[format];
  const frame = player.parentElement;
  frame.style.aspectRatio = `${W} / ${H}`;
  frame.classList.toggle('wide', W > H);
  Object.assign(player.style, { width: `${W}px`, height: `${H}px` });
  fit();
}
function finishSetup() {
  $('#setup').hidden = true;
  $('#editor').hidden = false;
  fit();
}
function showSetup(step) {
  const index = SETUP_STEPS.indexOf(step);
  const choose = { style: (value) => { $('#style').value = value; fitComposerSelect($('#style')); showSetup('format'); },
    format: (value) => { setFormat(value); finishSetup(); $('#prompt').focus(); } }[step];
  const cards = { style: STYLE_CHOICES, format: FORMAT_CHOICES }[step].map(([value, name, note]) => el('button', { type: 'button', className: `setup-card is-${step}`, onclick: () => choose(value) },
    // Each style's box shows a frame of its reference drawing once that loads; until then, and for “No style”, a play mark.
    step === 'style' ? Object.assign(el('span', { className: 'style-preview', ariaHidden: 'true' }), { innerHTML: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5Z"/></svg>' }) : null,
    step === 'format' ? el('span', { className: 'setup-shape-box', ariaHidden: 'true' }, el('span', { className: 'setup-shape', style: `aspect-ratio:${FORMATS[value][0]}/${FORMATS[value][1]};${FORMATS[value][0] > FORMATS[value][1] ? 'width:70%' : 'height:96px'}` })) : null,
    el('span', { className: 'setup-text' }, el('strong', { textContent: step === 'format' ? `${name} · ${value}` : name }), el('small', { textContent: note }))));
  // The style grid waits for every picture, up to 3 s each; a picture that isn't ready by then shows the style's name.
  const pictures = step === 'style' ? Promise.all(cards.map((card, i) => {
    const [style, name] = STYLE_CHOICES[i], box = card.firstChild;
    box.dataset.style = style;
    if (!style) return null;
    if (!stylePictures.has(style)) stylePictures.set(style, captureStyleReference(style).catch(() => null));
    const show = (image) => box.replaceChildren(Object.assign(new Image(), { src: image, alt: '' }));
    return Promise.race([stylePictures.get(style), new Promise((resolve) => setTimeout(resolve, 3000, null))]).then((image) => {
      if (image) return show(image);
      box.replaceChildren(el('span', { className: 'style-fallback', textContent: name }));
      stylePictures.get(style).then((late) => { if (late) show(late); });
    });
  })) : null;
  $('#setup').replaceChildren(el('div', { className: 'setup-inner' }, ...[
    index ? el('button', { type: 'button', className: 'setup-back', textContent: '← Back', onclick: () => showSetup(SETUP_STEPS[index - 1]) })
      : el('a', { className: 'setup-back', href: '/app/create/choose', textContent: '← Back' }),
    el('p', { className: 'setup-step', textContent: `Step ${index + 1} of ${SETUP_STEPS.length} · ${{ style: 'Style', format: 'Format' }[step]}` }),
    el('h2', { className: 'setup-title', textContent: { style: 'Choose a style', format: 'How big is it?' }[step] }),
    el('div', { className: `setup-grid is-${step}`, hidden: Boolean(pictures) }, ...cards),
    pictures ? el('p', { className: 'setup-loading', textContent: 'Loading styles…' }) : null,
  ]));
  pictures?.then(() => { $('#setup .setup-loading')?.remove(); const grid = $('#setup .setup-grid'); if (grid) { grid.hidden = false; grid.querySelector('.setup-card').focus(); } });
  $('#editor').hidden = true;
  $('#setup').hidden = false;
  $('#setup').querySelector('.setup-card').focus();
}
if (!projectId) showSetup('style');

if (projectId) store.loadProject(projectId).then((project) => {
  const saved = project?.motion;
  if (!saved?.code) { projectId = null; window.history.replaceState(null, '', '/motion/'); showSetup('style'); return; }
  lastGood = { engine: saved.engine, code: saved.code, originalPrompt: saved.originalPrompt, history: saved.history ?? [], style: saved.style ?? '' };
  ({ engine, originalPrompt } = lastGood);
  setFormat(saved.format);
  seconds = saved.seconds || 0;
  finishSetup();
  history = lastGood.history.slice();
  $('#engine').value = engine;
  $('#style').value = lastGood.style;
  fitComposerSelect($('#style'));
  const brief = Object.assign(document.createElement('div'), { className: 'message', textContent: originalPrompt });
  $('#conversation').append(brief);
  opening = restoring = true;
  setBusy(true);
  showThinking('Opening your video');
  run(saved.code);
}).catch(() => { projectId = null; });

fit();
