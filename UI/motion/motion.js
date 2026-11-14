// Relio Motion (dev only): The model writes a scene, a sandboxed frame runs it, and the canvas engine exports an MP4 here.
// The sandbox (allow-scripts, no same-origin) keeps generated code away from this site's sign-in and storage: it can only
// draw and send messages back.
import { Output, BufferTarget, Mp4OutputFormat, CanvasSource, canEncodeVideo } from '../vendor/mediabunny-1.61.5.min.mjs';

const $ = (selector) => document.querySelector(selector);
const W = 1080, H = 1920;
const player = $('#player'), status = $('#status');
try { const theme = localStorage.getItem('prism-theme'); if (theme) document.documentElement.dataset.theme = theme; } catch {}
const workspace = document.querySelector('.workspace');
const collapseButton = document.querySelector('.collapse-button');
function setCollapsed(collapsed) {
  workspace.classList.toggle('collapsed', collapsed);
  collapseButton.setAttribute('aria-expanded', String(!collapsed));
  collapseButton.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  collapseButton.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  try { localStorage.setItem('prism-sidebar', collapsed ? '1' : '0'); } catch {}
}
try { setCollapsed(localStorage.getItem('prism-sidebar') === '1'); } catch {}
collapseButton.addEventListener('click', () => setCollapsed(!workspace.classList.contains('collapsed')));
let engine = 'canvas', code = '', prompt = '', scene = null, repaired = false, preview = 0, previewTimeout = 0, downloadUrl = null, lastGood = null, restoring = false;
let originalPrompt = '', history = [], pendingBrief = null;
let reviewPass = 0, frameRequest = null, frameRequestId = 0, runToken = 0, workController = null;

const CANVAS_RUNNER = `<!doctype html><html><head><style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style></head>
<body><canvas id="c" width="${W}" height="${H}"></canvas><script>
const c = document.getElementById('c'), ctx = c.getContext('2d');
let scene = null, playing = false, startAt = 0, currentTime = 0, lastUpdate = 0, pending = null, exportCancelled = false;
const say = (m, t) => parent.postMessage(m, '*', t || []);
const fail = (e) => { playing = false; say({ type: 'error', message: String((e && e.stack) || e).slice(0, 1500) }); };
function frame(t) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ${W}, ${H}); scene.draw(ctx, t); ctx.restore(); }
function loop() {
  if (!playing) return;
  try { currentTime = ((performance.now() - startAt) / 1000) % scene.duration; frame(currentTime); if (performance.now() - lastUpdate > 100) { say({type:'playback', time:currentTime, playing:true}); lastUpdate = performance.now(); } } catch (e) { return fail(e); }
  requestAnimationFrame(loop);
}
addEventListener('message', async (event) => {
  const m = event.data || {};
  if (m.type === 'load') {
    try {
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
      const frames = [], capture = document.createElement('canvas'); capture.width = 720; capture.height = 1280;
      const captureCtx = capture.getContext('2d');
      for (const fraction of [0.02, 0.24, 0.48, 0.72, 0.96]) {
        const time = Math.min(scene.duration - 1 / scene.fps, Math.max(0, scene.duration * fraction));
        frame(time); captureCtx.drawImage(c, 0, 0, 720, 1280);
        frames.push({time, image:capture.toDataURL('image/jpeg', .7)});
      }
      frame(currentTime); say({type:'review-frames', requestId:m.requestId, frames});
    } catch (error) { say({type:'review-capture-error', requestId:m.requestId, message:String(error.message || error)}); }
  } else if (m.type === 'playback-control' && scene) {
    if (m.action === 'pause') { playing = false; say({type:'playback', time:currentTime, playing:false}); }
    if (m.action === 'seek') { currentTime = Math.max(0, Math.min(scene.duration - 1 / scene.fps, Number(m.time) || 0)); frame(currentTime); startAt = performance.now() - currentTime * 1000; say({type:'playback', time:currentTime, playing}); }
    if (m.action === 'play' && !playing) { playing = true; startAt = performance.now() - currentTime * 1000; loop(); say({type:'playback', time:currentTime, playing:true}); }
  } else if (m.type === 'export') {
    playing = false; exportCancelled = false;
    const count = Math.round(scene.duration * scene.fps);
    try {
      for (let i = 0; i < count; i++) {
        frame(i / scene.fps);
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
const modelButton = $('#model-button'), modelMenu = $('#model-menu');
let models = [], picked = 'default', effort = 'medium', menuView = 'main';
let defaults = { code: 'xiaomi/mimo-v2.6-flash', plan: 'meta/muse-ember', check: 'meta/muse-ember' };
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
function menuItem({ label, note, checked, value, onClick, role = 'menuitem', back }) {
  const item = el('button', { type: 'button', className: back ? 'menu-item menu-back' : 'menu-item', onclick: onClick });
  item.setAttribute('role', role);
  if (role === 'menuitemradio') item.setAttribute('aria-checked', String(Boolean(checked)));
  item.append(...[
    back ? el('span', { className: 'menu-arrow', textContent: '‹', ariaHidden: 'true' }) : null,
    el('span', { className: 'menu-text' }, el('span', { textContent: label }), note ? el('small', { textContent: note }) : null),
    value ? el('span', { className: 'menu-value', textContent: value }) : null,
    value !== undefined && !checked && role === 'menuitem' && !back ? el('span', { className: 'menu-arrow', textContent: '›', ariaHidden: 'true' }) : null,
    checked ? el('span', { className: 'menu-check', textContent: '✓', ariaHidden: 'true' }) : null,
  ].filter(Boolean));
  return item;
}
function renderModelButton() {
  $('#model-name').textContent = picked === 'default' ? 'Default' : stepModel('code')?.label || 'Default';
  $('#model-effort').textContent = showsEffort() ? EFFORTS.find(([key]) => key === effort)[1] : '';
}
function renderModelMenu() {
  const go = (view) => () => { menuView = view; renderModelMenu(); modelMenu.querySelector('button, select')?.focus(); };
  const items = [];
  if (menuView === 'main') {
    items.push(menuItem({ label: 'Default', note: 'Each step uses its own model', role: 'menuitemradio', checked: picked === 'default', onClick: () => pickModel('default') }));
    for (const m of models) items.push(menuItem({ label: m.label, note: m.note, role: 'menuitemradio', checked: picked === m.id, onClick: () => pickModel(m.id) }));
    items.push(el('div', { className: 'menu-sep', role: 'separator' }));
    if (showsEffort()) items.push(menuItem({ label: 'Effort', value: EFFORTS.find(([key]) => key === effort)[1], onClick: go('effort') }));
    items.push(menuItem({ label: 'Defaults', value: '', onClick: go('defaults') }));
  } else if (menuView === 'effort') {
    items.push(menuItem({ label: 'Effort', back: true, onClick: go('main') }));
    items.push(el('p', { className: 'menu-hint', textContent: 'Higher effort gives more thorough results, but takes longer and costs more. Models without levels ignore it.' }));
    for (const [key, label] of EFFORTS) items.push(menuItem({ label, role: 'menuitemradio', checked: effort === key, onClick: () => { effort = key; remember('motion-reasoning', key); closeModelMenu(); } }));
  } else {
    items.push(menuItem({ label: 'Defaults', back: true, onClick: go('main') }));
    items.push(el('p', { className: 'menu-hint', textContent: 'The model each step uses when Default is picked.' }));
    for (const [step, label] of STEPS) {
      const select = el('select', { ariaLabel: `${label} model`, onchange: () => { defaults[step] = select.value; remember('motion-defaults', JSON.stringify(defaults)); renderModelButton(); } },
        ...models.map((m) => el('option', { value: m.id, textContent: m.label, selected: defaults[step] === m.id })));
      items.push(el('label', { className: 'menu-step' }, el('span', { textContent: label }), select));
    }
  }
  modelMenu.replaceChildren(...items);
  renderModelButton();
}
function pickModel(id) { picked = id; remember('motion-model', id); closeModelMenu(); }
function openModelMenu() {
  menuView = 'main';
  renderModelMenu();
  modelMenu.hidden = false;
  modelButton.setAttribute('aria-expanded', 'true');
  (modelMenu.querySelector('[aria-checked="true"]') || modelMenu.querySelector('button'))?.focus();
}
function closeModelMenu(focusButton = true) {
  if (modelMenu.hidden) return renderModelButton();
  modelMenu.hidden = true;
  modelButton.setAttribute('aria-expanded', 'false');
  renderModelButton();
  if (focusButton) modelButton.focus();
}
modelButton.addEventListener('click', () => modelMenu.hidden ? openModelMenu() : closeModelMenu());
document.addEventListener('pointerdown', (event) => { if (!modelMenu.hidden && !event.target.closest('.model-picker')) closeModelMenu(false); });
modelMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeModelMenu(); return; }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.target.tagName === 'SELECT') return;
  event.preventDefault();
  const focusable = [...modelMenu.querySelectorAll('button, select')];
  const next = focusable.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1);
  focusable[(next + focusable.length) % focusable.length]?.focus();
});
fetch('/motion/models.json').then((response) => response.json()).then((list) => {
  models = list;
  const known = (id) => list.some((m) => m.id === id);
  const savedModel = recall('motion-model'), savedEffort = recall('motion-reasoning');
  if (savedModel === 'default' || known(savedModel)) picked = savedModel;
  if (EFFORTS.some(([key]) => key === savedEffort)) effort = savedEffort;
  try { for (const [step, id] of Object.entries(JSON.parse(recall('motion-defaults') || '{}'))) if (step in defaults && known(id)) defaults[step] = id; } catch {}
  renderModelButton();
}).catch(() => setStatus('The model list could not be loaded, so the server default is used.', true));
$('#prompt').addEventListener('input', updateComposer);
$('#prompt').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#make').click(); } });
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
  player.srcdoc = engine === 'canvas' ? CANVAS_RUNNER : engine === 'html' ? htmlRunner(source) : '<!doctype html><html><head><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#000}</style></head><body><div id="root"></div><script src="/motion/runtime/engine-player.js"></script></body></html>';
  fit();
}

player.addEventListener('load', () => { if (engine !== 'html' && code) player.contentWindow.postMessage({ type: 'load', code, engine }, '*'); });

async function generate(extra = {}) {
  const response = await fetch('/api/motion', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: workController?.signal,
    // Outside a send (a crash during playback) pendingBrief is null, so fall back to the accepted brief, history and style.
    body: JSON.stringify({ prompt, engine, originalPrompt: pendingBrief?.originalPrompt || originalPrompt || prompt, history: pendingBrief?.history || history, style: pendingBrief ? pendingBrief.style : lastGood?.style || '', ...choiceFor('code'), ...(stepModel('plan') ? { plan: choiceFor('plan') } : {}), ...extra }),
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
    if (m.type === 'review-frames') request.resolve(m.frames); else request.reject(new Error(m.message || 'Frame capture failed.'));
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
    $('#download').hidden = true;
    $('#download').removeAttribute('href');
    if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
    let reviewMessage = '';
    if (!restoring) {
      try {
        reviewPass++;
        showThinking('Checking sampled frames');
        const [frames, reference] = await Promise.all([captureReviewFrames(), captureStyleReference(pendingBrief?.style || '')]);
        if (token !== runToken) return;
        const issues = await reviewFrames(frames, reference);
        if (token !== runToken) return;
        if (issues.length && reviewPass === 1) {
          showThinking('Fixing issues found in the video');
          const correction = await generate({previous:code, visualFeedback:issues.join('\n')});
          if (token !== runToken) return;
          if (!lastGood) lastGood = {engine, code, originalPrompt:pendingBrief?.originalPrompt || prompt, history:pendingBrief?.history || [], style:pendingBrief?.style || ''};
          run(correction.code);
          return;
        }
        reviewMessage = issues.length ? `I checked five sampled frames${reference ? ' against the selected style' : ''}, but these issues may still need attention: ${issues.join(' ')}` : `I checked five sampled frames${reference ? ' against the selected style' : ''} and found no obvious issues. Other frames may still need review.`;
      } catch (error) {
        if (token !== runToken) return;
        reviewMessage = `Your preview is ready, but I couldn’t complete the visual check: ${error.message || 'Please try again.'}`;
      }
    }
    hideThinking();
    workController = null;
    setBusy(false);
    if (restoring) {
      restoring = false;
      addAssistantMessage('Your last working preview is back. You can try that change again.');
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
    }
    $('#make').setAttribute('aria-label', 'Send changes');
    $('#make').title = 'Send changes';
    $('#export').disabled = engine !== 'canvas';
    setStatus(`Playing · ${m.duration.toFixed(1)} s at ${m.fps} fps${engine === 'canvas' ? '' : ' · preview only'}.`);
    if (engine === 'html') playHtml();
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
function exportFailed(error) {
  player.contentWindow.postMessage({ type: 'cancel-export' }, '*');
  exporter = null;
  hideThinking();
  setBusy(false);
  $('#export').disabled = !scene || engine !== 'canvas';
  setStatus(`Export failed: ${error.message || error}. Please try again.`, true);
}
$('#export').addEventListener('click', async () => {
  if (!scene || engine !== 'canvas') return;
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
          showThinking(`Exporting video · ${Math.round((i + 1) / count * 100)}%`);
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
          Object.assign($('#download'), { href: downloadUrl, hidden: false });
          exporter = null;
          hideThinking();
          setBusy(false);
          $('#export').disabled = false;
          addAssistantMessage('Your MP4 is ready. Use Download MP4 below the preview to save it.');
          setStatus('Your MP4 is ready to download.');
        } catch (error) { exportFailed(error); }
      },
    };
    showThinking('Exporting video · 0%');
    player.contentWindow.postMessage({ type: 'export' }, '*');
  } catch (error) { exportFailed(error); }
});

fit();
