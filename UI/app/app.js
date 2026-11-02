// Prism in the browser: projects, Shorts, the editor and export. The screens follow the macOS app's flows; the engine is in ./engine.
import { GeminiError, StageFailure, ShortMakerError } from './engine/gemini.js';
import { openSource, thumbnail } from './engine/media.js';
import * as Shorts from './engine/shortmaker.js';
import * as Framing from './engine/framing.js';
import * as Selection from './engine/selection.js';
import { render, preview, exportSettings } from './engine/render.js';
import { STYLE_TITLES, STYLE_DETAILS, VIDEO_TYPE_TITLES, VIDEO_TYPE_DETAILS, REGION_TITLES, EXPORT_QUALITIES, CAPTION_STYLES, VIDEO_TYPES } from './engine/models.js';
import { stylePreview } from './engine/captions.js';
import * as store from './store.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uuid = () => crypto.randomUUID();
const clock = (seconds) => {
  const total = Math.round(seconds), m = Math.floor(total / 60), s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};
const db = () => window.prismDb;

const state = {
  session: null,
  projects: [],
  project: null,
  selectedId: null,
  sources: new Map(),
  undo: [],
  previewToken: 0,
  task: null,
  dialog: null,
  usage: null,
};

// MARK: Sign-in and usage

async function accessToken() {
  return (await db()?.auth.getSession())?.data.session?.access_token ?? null;
}

async function refreshUsage() {
  if (!state.session) return;
  const { data, error } = await db().rpc('my_usage');
  state.usage = !error && data?.[0] ? { used: data[0].used, allowance: data[0].allowance } : null;
  renderUsage();
}

function renderUsage() {
  const badge = $('#usage-badge');
  if (!badge) return;
  badge.textContent = state.usage ? `${Math.floor(state.usage.used)} of ${Math.floor(state.usage.allowance)} min used` : '';
}

async function signIn(email, password) {
  const { error } = await db().auth.signInWithPassword({ email: email.trim(), password });
  return error ? error.message : null;
}

async function signUp(email, password) {
  const { data, error } = await db().auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: new URL('app/', location.origin + '/').href } });
  if (error) return { message: error.message };
  return { message: data.session ? null : 'Check your inbox to confirm your email, then sign in.' };
}

// MARK: Boot and routing

async function boot() {
  if (!('VideoDecoder' in window && 'VideoEncoder' in window && 'OffscreenCanvas' in window)) {
    $('#app').innerHTML = `<section class="card auth"><h1>Open Prism in another browser</h1>
      <p class="muted">Prism reads and renders video in your browser with WebCodecs, which this browser doesn’t have. Use a current Chrome, Edge, Safari or Firefox.</p></section>`;
    return;
  }
  if (!db()) return showSignedOut('Sign-in is unavailable right now. Check your connection and reload.');
  state.session = (await db().auth.getSession()).data.session;
  db().auth.onAuthStateChange((event, session) => {
    state.session = session;
    if (event === 'SIGNED_OUT') showSignedOut();
    else refreshUsage();
  });
  await document.fonts.load('700 66px Sora');
  if (!state.session) return showSignedOut();
  await showHome();
}

function showSignedOut(message = '') {
  state.project = null;
  $('#app').innerHTML = `
    <section class="card auth">
      <h1>Sign in to Prism</h1>
      <p class="muted">Prism AI makes Shorts from your videos. Sign in to use it; each account gets a beta allowance of minutes.</p>
      <form id="auth-form" class="stack">
        <label>Email <input name="email" type="email" autocomplete="email" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
        <div class="row">
          <button class="button primary" name="mode" value="in">Sign in</button>
          <button class="button ghost" name="mode" value="up" formnovalidate>Create account</button>
        </div>
        <p id="auth-status" class="muted" role="status">${esc(message)}</p>
      </form>
      <p class="muted small"><a href="../pricing.html">Pricing</a> · <a href="../login.html">Account help</a></p>
    </section>`;
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { email, password } = Object.fromEntries(new FormData(form));
    const mode = event.submitter?.value ?? 'in';
    const status = $('#auth-status');
    status.textContent = mode === 'up' ? 'Creating account…' : 'Signing in…';
    if (mode === 'up') {
      const { message } = await signUp(email, password);
      status.textContent = message ?? 'Signed in.';
      if (!message) await showHome();
      return;
    }
    const error = await signIn(email, password);
    if (error) status.textContent = error;
    else await showHome();
  });
}

async function showHome() {
  state.project = null;
  state.projects = await store.listProjects();
  const cards = state.projects.map((p) => {
    const poster = p.media.find((m) => m.thumbnail)?.thumbnail;
    const shorts = p.segments.length;
    return `<div class="project-card">
        <button class="open" data-action="open" data-id="${esc(p.id)}">
          <div class="poster">${poster ? `<img alt="" src="${poster}">` : ''}</div>
          <strong>${esc(p.title)}</strong>
          <span class="muted small">${shorts} ${shorts === 1 ? 'Short' : 'Shorts'} · ${new Date(p.updated ?? p.created).toLocaleDateString()}</span>
        </button>
        <button class="link danger" data-action="delete-project" data-id="${esc(p.id)}">Delete</button>
      </div>`;
  }).join('');
  $('#app').innerHTML = `
    <section class="home">
      <div class="row between">
        <h1>Projects</h1>
        <span class="row">
          <span id="usage-badge" class="muted small"></span>
          <button class="button ghost" data-action="usage">Usage</button>
          <label class="button primary">Import a video<input id="import" type="file" accept="video/*" hidden></label>
        </span>
      </div>
      <div id="drop" class="dropzone">Drop a video here to start a project</div>
      <div class="grid">${cards || '<p class="muted">No projects yet. Import a video to make your first Shorts.</p>'}</div>
      <p id="notice" class="muted" role="status"></p>
    </section>`;
  wireDropzone($('#drop'), (file) => createProject(file));
  $('#import').addEventListener('change', (event) => event.target.files[0] && createProject(event.target.files[0]));
  renderUsage();
  refreshUsage();
}

function wireDropzone(zone, onFile) {
  ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => { const file = e.dataTransfer.files[0]; if (file) onFile(file); });
}

// MARK: Projects and media

async function importMedia(project, file) {
  const source = await openSource(file);
  const media = {
    id: uuid(), name: file.name, size: file.size, lastModified: file.lastModified, duration: source.duration,
    width: source.width, height: source.height, hasAudio: source.hasAudio, contentHash: null, thumbnail: null,
    created: new Date().toISOString(),
  };
  media.thumbnail = await thumbnail(source, Math.min(1, source.duration / 2)).catch(() => null);
  await store.saveFile(media.id, file);
  project.media.push(media);
  state.sources.set(media.id, source);
  return media;
}

async function createProject(file) {
  const notice = $('#notice');
  if (notice) notice.textContent = 'Reading the video…';
  try {
    const project = { id: uuid(), title: file.name.replace(/\.[^.]+$/, ''), created: new Date().toISOString(), media: [], segments: [], transcripts: {} };
    await importMedia(project, file);
    await store.saveProject(project);
    await openProject(project.id);
  } catch (error) {
    if (notice) notice.textContent = error.message || 'That file is not a video this browser can read.';
    else alert(error.message);
  }
}

async function openProject(id) {
  const project = await store.loadProject(id);
  if (!project) return showHome();
  state.project = project;
  state.selectedId = project.segments[0]?.id ?? null;
  state.undo = [];
  for (const media of project.media) await sourceFor(media).catch(() => null);
  renderEditor();
  if (state.selectedId) selectShort(state.selectedId);
}

async function sourceFor(media) {
  if (state.sources.has(media.id)) return state.sources.get(media.id);
  const file = await store.loadFile(media.id);
  if (!file) throw new Error(`The file for ${media.name} is missing from this browser. Import it again.`);
  const source = await openSource(file);
  state.sources.set(media.id, source);
  return source;
}

async function persist() {
  if (state.project) await store.saveProject(state.project);
}

/** The video's name on Prism's server: its SHA-256 (the same value as on the Mac), else a hash of its name and length. */
async function serverKey(media) {
  if (media.contentHash) return media.contentHash;
  if (media.size <= 1.5e9) {
    const source = await sourceFor(media);
    const digest = await crypto.subtle.digest('SHA-256', await source.file.arrayBuffer());
    media.contentHash = hex(digest);
    await persist();
    return media.contentHash;
  }
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${media.name}|${Math.round(media.duration)}`)));
}
/** The allowance fields every Prism AI request carries, for a video that isn't starting a run. */
async function usageFor(media, source) {
  return { video: await serverKey(media), minutes: source.duration / 60, day: localDay() };
}
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

// MARK: Making Shorts

function openMakeDialog(mediaId = state.project.media[0]?.id) {
  const media = state.project.media.find((m) => m.id === mediaId) ?? state.project.media[0];
  if (!media) return;
  const minutes = Math.round(media.duration / 60 * 10) / 10;
  const styleOptions = CAPTION_STYLES.map((s) => `<option value="${s}">${STYLE_TITLES[s]}</option>`).join('');
  const typeOptions = VIDEO_TYPES.map((t) => `<option value="${t}">${VIDEO_TYPE_TITLES[t]}</option>`).join('');
  openDialog(`
    <form id="make-form" class="stack">
      <h2>Make Shorts</h2>
      <p class="muted small">${esc(media.name)} · ${minutes} min</p>
      <label>How many <select name="count"><option value="0">Auto (one per minute)</option>${[...Array(20)].map((_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></label>
      <label>Length <select name="duration"><option value="0">Auto (each story's length)</option><option>15</option><option>30</option><option selected>45</option><option>60</option><option>90</option></select></label>
      <label>Region <select name="region">${Object.entries(REGION_TITLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <div id="custom" class="row" hidden>
        <label>From (min) <input name="customStart" type="number" min="0" step="0.1" value="0"></label>
        <label>To (min) <input name="customEnd" type="number" min="0" step="0.1" value="${minutes}"></label>
      </div>
      <label>Kind of video <select name="videoType">${typeOptions}</select></label>
      <p class="muted small" id="type-detail">${VIDEO_TYPE_DETAILS.auto}</p>
      <label>Captions <select name="captionStyle">${styleOptions}</select></label>
      <canvas class="style-preview" id="make-style" aria-label="Caption style preview"></canvas>
      <div class="row end">
        <button type="button" class="button ghost" data-action="close">Cancel</button>
        <button class="button primary">Make Shorts</button>
      </div>
    </form>`);
  const form = $('#make-form');
  form.elements.region.addEventListener('change', (e) => { $('#custom').hidden = e.target.value !== 'custom'; });
  form.elements.videoType.addEventListener('change', (e) => { $('#type-detail').textContent = VIDEO_TYPE_DETAILS[e.target.value]; });
  const showStyle = () => stylePreview($('#make-style'), form.elements.captionStyle.value);
  form.elements.captionStyle.addEventListener('change', showStyle);
  showStyle();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const options = {
      count: Number(values.count), duration: Number(values.duration), region: values.region, videoType: values.videoType,
      captionStyle: values.captionStyle, customStart: Number(values.customStart) * 60, customEnd: Number(values.customEnd) * 60,
    };
    closeDialog();
    makeShorts(media, options);
  });
}

async function makeShorts(media, options) {
  if (state.task) return;
  if (options.region === 'custom' && !(options.customEnd > options.customStart && options.customEnd <= media.duration + 0.5)) {
    return showError('Choose a range inside the video', 'The end of the range must come after its start and fall inside the video.');
  }
  if (!state.session) return showSignedOut('Sign in to make Shorts.');
  const task = beginTask('Preparing video…');
  let key, minutes, check;
  try {
    key = await serverKey(media);
    minutes = (await sourceFor(media)).duration / 60;
    // Re-analyses are charged: the server says how many runs this video has had and what the next one costs.
    const { data, error } = await db().rpc('my_reanalysis', { p_video: key });
    // A server without re-analysis charging has no such function yet, so every run is a first run there.
    if (error && error.code !== 'PGRST202') throw error;
    check = error ? { runs: 0, charge: 0 } : { runs: data?.[0]?.runs ?? 0, charge: data?.[0]?.charge ?? 0 };
  } catch (error) {
    endTask(task);
    if (task.controller.signal.aborted) return;
    return showError('Prism couldn’t check your usage right now', 'Try again in a moment.', 'temporary');
  }
  endTask(task);
  if (check.runs === 0) return runShorts(media, options, key, minutes);
  await refreshUsage();
  const left = Math.max(0, (state.usage?.allowance ?? 0) - (state.usage?.used ?? 0));
  if (check.charge > left) {
    return showError('Not enough minutes', `This re-analysis needs ${Math.floor(check.charge)} min, but you have ${Math.floor(left)} min left. Ask for a promo code to get more, then enter it in Usage.`, 'limit');
  }
  confirmRerun(media, options, { key, minutes, check });
}

function confirmRerun(media, options, usage) {
  openDialog(`
    <div class="stack">
      <h2>Use your minutes?</h2>
      <p>You’ve analyzed this video before. Analyzing it again uses <strong>${Math.floor(usage.check.charge)} min</strong> of your allowance.</p>
      <div class="row end">
        <button class="button ghost" data-action="close">Cancel</button>
        <button class="button primary" id="confirm-rerun">Use ${Math.floor(usage.check.charge)} min and make Shorts</button>
      </div>
    </div>`);
  $('#confirm-rerun').addEventListener('click', () => {
    closeDialog();
    runShorts(media, options, usage.key, usage.minutes);
  });
}

async function runShorts(media, options, key, minutes) {
  if (state.task) return;
  const source = await sourceFor(media);
  const project = state.project;
  const projectId = project.id;
  const task = beginTask('Preparing video analysis…');
  const usedRanges = project.segments.filter((s) => s.mediaId === media.id).map((s) => ({ start: s.start, end: s.start + s.duration }));
  const saved = project.transcripts?.[media.id] ?? null;
  const configuration = {
    accessToken,
    usage: { video: key, minutes, day: localDay(), run: uuid() },
    onRetry: (message) => setTask(message),
  };
  try {
    // The server refuses an over-limit run too; checking first spares a request that can't succeed.
    const { data: allowed } = await db().rpc('usage_allowed', { p_video: key, p_day: localDay(), p_minutes: minutes });
    if (allowed === false) throw new GeminiError('usageLimit', 429);
    const results = await Shorts.analyze(source, configuration, {
      duration: options.duration, count: options.count, region: options.region, customStart: options.region === 'custom' ? options.customStart : null,
      customEnd: options.region === 'custom' ? options.customEnd : null, excluding: usedRanges, videoType: options.videoType, cachedTranscript: saved,
      signal: task.controller.signal,
      onTranscript: (transcript) => { project.transcripts ??= {}; project.transcripts[media.id] = transcript; },
      progress: (fraction, stage) => setTask(stage, fraction),
    });
    const podcast = (r) => r.videoType === 'podcast';
    const created = [];
    for (const r of results) {
      const segment = {
        id: uuid(), mediaId: media.id, start: r.start, duration: r.duration, caption: '', isMuted: false, captionStart: 0, captionDuration: null,
        fitToFrame: r.fit, captions: r.captions, cropZoom: 1.08, cropPosition: 0.5, cropKeyframes: r.cropKeyframes,
        cropTrackingVersion: Framing.VERSION, speechWords: r.speechWords, score: r.score, suggestedTitle: r.title, selectionReason: r.reason,
        suggestedDescription: r.description, captionNotice: r.warning, captionStyle: options.captionStyle, videoType: r.videoType,
        splitScreen: podcast(r) ? true : false, captionPosition: podcast(r) ? 'middle' : 'bottom', captionSize: 'medium', captionAnimated: false,
      };
      if (segment.splitScreen) {
        setTask(`Prism AI · finding both speakers · Short ${created.length + 1} of ${results.length}`);
        segment.splitCenters = await Framing.findSplitCenters(source, r.start, r.duration, configuration, task.controller.signal).catch(() => null) ?? undefined;
      }
      created.push(segment);
    }
    if (state.project?.id !== projectId) return;
    project.segments.push(...created);
    await persist();
    endTask(task);
    state.selectedId = created[0].id;
    renderEditor();
    selectShort(state.selectedId);
    await refreshUsage();
  } catch (error) {
    if (task.controller.signal.aborted) return endTask(task);
    endTask(task);
    reportGenerationError(error);
  }
}

function localDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function reportGenerationError(error) {
  const cause = error instanceof StageFailure ? error.underlying : error;
  if (cause instanceof GeminiError) {
    if (cause.failure === 'noStrongClips' || cause.failure === 'noDistinctClips') return showError('No Shorts found', cause.message);
    if (cause.failure === 'signIn' || cause.status === 401 || cause.status === 403) return showError('Check your sign-in', cause.message);
    if (cause.failure === 'usageLimit') return showError('You’ve reached your beta limit', cause.message, 'limit');
    if (cause.failure === 'request' && [429, 500, 502, 503, 504, 546].includes(cause.status)) return showError('Prism AI is unavailable right now', cause.message, 'temporary');
  }
  if (error instanceof ShortMakerError) return showError('Couldn’t make Shorts', error.message);
  showError('Couldn’t make Shorts', error instanceof StageFailure ? error.message : error?.message || 'Something went wrong. Your existing clips were kept.');
}

// MARK: Progress and dialogs

function beginTask(stage) {
  const task = { stage, progress: null, controller: new AbortController(), cancelled: false };
  state.task = task;
  renderTask();
  return task;
}
function setTask(stage, fraction = null) {
  if (!state.task) return;
  state.task.stage = stage;
  if (fraction !== null) state.task.progress = Math.max(state.task.progress ?? 0, fraction);
  renderTask();
}
function endTask(task) {
  if (state.task === task) state.task = null;
  renderTask();
}
function cancelTask() {
  if (!state.task) return;
  state.task.cancelled = true;
  state.task.controller.abort();
  state.task.stage = 'Cancelling…';
  renderTask();
  setTimeout(() => { if (state.task?.cancelled) endTask(state.task); }, 0);
}

function renderTask() {
  const host = $('#progress');
  if (!host) return;
  const task = state.task;
  host.hidden = !task;
  if (!task) return;
  host.innerHTML = `<div class="card progress-card" role="status">
      <strong>${esc(task.stage)}</strong>
      <div class="bar"><div style="width:${Math.round((task.progress ?? 0) * 100)}%"></div></div>
      <button class="button ghost" data-action="cancel">Cancel</button>
    </div>`;
}

function openDialog(html) {
  state.dialog = html;
  const host = $('#dialog');
  host.hidden = false;
  host.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  host.querySelector('input,select,button')?.focus();
}
function closeDialog() {
  state.dialog = null;
  $('#dialog').hidden = true;
  $('#dialog').innerHTML = '';
}
function showError(title, message, kind = '') {
  openDialog(`<div class="stack"><h2>${esc(title)}</h2><p>${esc(message)}</p>
    <div class="row end">${kind === 'limit' ? '<button class="button ghost" data-action="usage">Usage</button>' : ''}<button class="button primary" data-action="close">OK</button></div></div>`);
}

// MARK: Editor

function renderEditor() {
  const project = state.project;
  const shorts = project.segments.map((s, index) => {
    const media = project.media.find((m) => m.id === s.mediaId);
    const title = s.suggestedTitle || `${project.title} Short ${index + 1}`;
    return `<li><button class="short ${s.id === state.selectedId ? 'on' : ''}" data-action="select" data-id="${s.id}">
      <span class="short-title">${esc(title)}</span>
      <span class="muted small">${clock(s.duration)} · ${esc(media?.name ?? '')}</span></button></li>`;
  }).join('');
  const bin = project.media.map((m) => `<li class="media"><img alt="" src="${m.thumbnail ?? ''}"><span class="small">${esc(m.name)}</span>
      <button class="link" data-action="make" data-id="${m.id}">Make Shorts</button></li>`).join('');
  $('#app').innerHTML = `
    <section class="editor">
      <header class="bar-top">
        <button class="link" data-action="home">← Projects</button>
        <input id="title" class="title" value="${esc(project.title)}" aria-label="Project name">
        <span id="usage-badge" class="muted small"></span>
        <button class="button ghost" data-action="usage">Usage</button>
        <button class="button ghost" data-action="undo" title="Undo (Ctrl+Z)">Undo</button>
        <button class="button ghost" data-action="import-more">Add video</button>
        <input id="import-more" type="file" accept="video/*" hidden>
        <button class="button primary" data-action="export-dialog" ${project.segments.length ? '' : 'disabled'}>Export</button>
      </header>
      <div class="panes">
        <aside class="bin">
          <h3>Videos</h3><ul class="plain">${bin}</ul>
          <h3>Shorts</h3><ul class="plain">${shorts || '<li class="muted small">No Shorts yet. Use Make Shorts on a video.</li>'}</ul>
        </aside>
        <main class="stage" id="stage"></main>
        <aside class="inspector" id="inspector"></aside>
      </div>
    </section>`;
  $('#title').addEventListener('change', async (e) => { project.title = e.target.value.trim() || project.title; await persist(); });
  $('#import-more').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { await importMedia(project, file); await persist(); renderEditor(); } catch (error) { showError('Couldn’t add that video', error.message); }
  });
  renderUsage();
  renderTask();
  renderInspector();
}

function selected() {
  return state.project?.segments.find((s) => s.id === state.selectedId) ?? null;
}

async function selectShort(id) {
  state.selectedId = id;
  renderEditor();
  const segment = selected();
  if (!segment) return;
  const media = state.project.media.find((m) => m.id === segment.mediaId);
  const token = ++state.previewToken;
  setStage(`<p class="muted">Rendering preview…</p>`);
  try {
    const source = await sourceFor(media);
    if (segment.cropTrackingVersion !== Framing.VERSION || !segment.cropKeyframes) await retrack(segment, source);
    const url = await preview(source, segment);
    if (token !== state.previewToken) return;
    setStage(`<video id="player" class="player" controls playsinline src="${url}"></video>
      <p class="muted small">Preview at 540 × 960. Export renders 1080 × 1920.</p>${timelineHtml(segment)}`);
    wireTimeline(segment);
    renderInspector();
  } catch (error) {
    if (token !== state.previewToken) return;
    setStage(`<p class="error">${esc(error.message || 'The preview could not be rendered.')}</p>`);
  }
}

function setStage(html) {
  const stage = $('#stage');
  if (stage) stage.innerHTML = html;
}

async function retrack(segment, source) {
  const configuration = { accessToken, usage: await usageFor(state.project.media.find((m) => m.id === segment.mediaId), source) };
  if (segment.fitToFrame) segment.cropKeyframes = [{ time: 0, position: 0.5, preserveWholeFrame: true }, { time: segment.duration, position: 0.5, preserveWholeFrame: true }];
  else segment.cropKeyframes = await Framing.analyze(source, segment.start, segment.duration, segment.cropZoom ?? 1.08, configuration, segment.captions ?? []);
  segment.cropTrackingVersion = Framing.VERSION;
  await persist();
}

function renderInspector() {
  const host = $('#inspector');
  if (!host) return;
  const segment = selected();
  if (!segment) { host.innerHTML = '<p class="muted small">Select a Short to edit it.</p>'; return; }
  const media = state.project.media.find((m) => m.id === segment.mediaId);
  const source = state.sources.get(segment.mediaId);
  const maxStart = Math.max(0, (source?.duration ?? media?.duration ?? 0) - segment.duration);
  const styleOptions = CAPTION_STYLES.map((s) => `<option value="${s}" ${s === (segment.captionStyle ?? 'classic') ? 'selected' : ''}>${STYLE_TITLES[s]}</option>`).join('');
  host.innerHTML = `
    <div class="stack">
      <label>Title <input data-field="suggestedTitle" value="${esc(segment.suggestedTitle ?? '')}"></label>
      <label>Description <textarea data-field="suggestedDescription" rows="3">${esc(segment.suggestedDescription ?? '')}</textarea></label>
      <p class="muted small">${esc(segment.selectionReason ?? '')}</p>
      ${segment.captionNotice ? `<p class="notice small">${esc(segment.captionNotice)}</p>` : ''}
      <fieldset class="stack"><legend>Timing</legend>
        <label>Start (s) <input type="number" step="0.1" min="0" max="${maxStart}" data-field="start" value="${segment.start.toFixed(2)}"></label>
        <label>Length (s) <input type="number" step="0.1" min="0.5" data-field="duration" value="${segment.duration.toFixed(2)}"></label>
        <p class="muted small">${source ? `Source is ${clock(source.duration)} long.` : ''} Changing the timing re-tracks the framing.</p>
      </fieldset>
      <fieldset class="stack"><legend>Captions</legend>
        <label>Style <select data-field="captionStyle">${styleOptions}</select></label>
        <canvas class="style-preview" id="inspector-style" aria-label="Caption style preview"></canvas>
        <p class="muted small">${esc(STYLE_DETAILS[segment.captionStyle ?? 'classic'] ?? '')}</p>
        <label>Position <select data-field="captionPosition">${['top', 'middle', 'bottom'].map((p) => `<option value="${p}" ${p === (segment.captionPosition ?? 'bottom') ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>
        <label>Size <select data-field="captionSize">${['small', 'medium', 'large'].map((p) => `<option value="${p}" ${p === (segment.captionSize ?? 'medium') ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" data-field="captionAnimated" ${segment.captionAnimated ? 'checked' : ''}> Pop in new captions</label>
        <label>Caption lines <textarea data-field="captionTexts" rows="5">${esc((segment.captions ?? []).map((c) => c.text).join('\n'))}</textarea></label>
        <p class="muted small">Edit the words, one line per caption. Timing stays the same.</p>
        <button class="button ghost" data-action="regen-captions">Regenerate subtitles</button>
      </fieldset>
      <fieldset class="stack"><legend>Picture</legend>
        <label class="check"><input type="checkbox" data-field="splitScreen" ${segment.splitScreen ? 'checked' : ''}> Split screen (two speakers)</label>
        <label class="check"><input type="checkbox" data-field="fitToFrame" ${segment.fitToFrame ? 'checked' : ''}> Show the whole frame</label>
        <label class="check"><input type="checkbox" data-field="isMuted" ${segment.isMuted ? 'checked' : ''}> Mute audio</label>
        <label>On-screen text <input data-field="caption" value="${esc(segment.caption ?? '')}"></label>
        <button class="button ghost" data-action="retrack">Re-track the subject</button>
      </fieldset>
      <div class="row between">
        <button class="button ghost danger" data-action="remove">Remove Short</button>
        <button class="button ghost" data-action="export-one">Export this Short</button>
      </div>
    </div>`;
  stylePreview($('#inspector-style'), segment.captionStyle ?? 'classic');
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Moves or resizes a Short in its source. Captions and words are relative to the Short's start, so they shift with it. */
function applyTiming(s, start, duration) {
  const media = state.project.media.find((m) => m.id === s.mediaId);
  const total = state.sources.get(s.mediaId)?.duration ?? media.duration;
  start = clamp(start, 0, Math.max(0, total - 0.5));
  duration = clamp(duration, 0.5, total - start);
  const shift = start - s.start;
  const fit = (item) => {
    const from = Math.max(0, item.start - shift), to = Math.min(duration, item.start - shift + item.duration);
    return to > from ? { ...item, start: from, duration: to - from } : null;
  };
  s.captions = (s.captions ?? []).map(fit).filter(Boolean);
  s.speechWords = (s.speechWords ?? []).map(fit).filter(Boolean);
  s.start = start;
  s.duration = duration;
  s.cropKeyframes = null;
}

/** The Short's place in its source, with the other Shorts of the same video shown dimmed. */
function timelineHtml(segment) {
  const media = state.project.media.find((m) => m.id === segment.mediaId);
  const total = state.sources.get(media.id)?.duration ?? media.duration;
  const pct = (value) => `${(value / total * 100).toFixed(3)}%`;
  const others = state.project.segments.filter((s) => s.mediaId === media.id && s.id !== segment.id)
    .map((s) => `<div class="tl-other" style="left:${pct(s.start)};width:${pct(s.duration)}"></div>`).join('');
  return `<div class="timeline" data-total="${total}">
      <div class="tl-track" id="tl-track">${others}
        <div class="tl-clip" id="tl-clip" style="left:${pct(segment.start)};width:${pct(segment.duration)}"><span class="tl-handle l" data-edge="l"></span><span class="tl-handle r" data-edge="r"></span></div>
      </div>
      <div class="row between muted small mono"><span>0:00</span><span id="tl-label">${clock(segment.start)}–${clock(segment.start + segment.duration)}</span><span>${clock(total)}</span></div>
      <p class="muted small">Drag the block to move the Short, or its ends to trim it.</p>
    </div>`;
}

function wireTimeline(segment) {
  const track = $('#tl-track'), clip = $('#tl-clip');
  if (!track || !clip) return;
  const total = Number($('.timeline').dataset.total);
  clip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    clip.setPointerCapture(event.pointerId);
    const mode = event.target.dataset.edge ?? 'move';
    const x0 = event.clientX, start0 = segment.start, duration0 = segment.duration;
    const perPixel = total / track.getBoundingClientRect().width;
    let start = start0, duration = duration0;
    const move = (e) => {
      const delta = (e.clientX - x0) * perPixel;
      if (mode === 'move') { start = clamp(start0 + delta, 0, total - duration0); duration = duration0; }
      else if (mode === 'l') { start = clamp(start0 + delta, 0, start0 + duration0 - 0.5); duration = start0 + duration0 - start; }
      else { start = start0; duration = clamp(duration0 + delta, 0.5, total - start0); }
      clip.style.left = `${start / total * 100}%`;
      clip.style.width = `${duration / total * 100}%`;
      $('#tl-label').textContent = `${clock(start)}–${clock(start + duration)}`;
    };
    const finish = () => {
      clip.removeEventListener('pointermove', move);
      clip.removeEventListener('pointerup', finish);
      clip.removeEventListener('pointercancel', finish);
      if (Math.abs(start - start0) > 0.01 || Math.abs(duration - duration0) > 0.01) edit((s) => applyTiming(s, start, duration));
    };
    clip.addEventListener('pointermove', move);
    clip.addEventListener('pointerup', finish);
    clip.addEventListener('pointercancel', finish);
  });
}

/** Applies an edit to the selected Short: keeps an undo copy, saves, and re-renders the preview when the picture changed. */
async function edit(change, { rerender = true } = {}) {
  const segment = selected();
  if (!segment) return;
  state.undo.push({ id: segment.id, before: JSON.stringify(segment) });
  if (state.undo.length > 50) state.undo.shift();
  await change(segment);
  await persist();
  if (rerender) selectShort(segment.id);
  else renderEditor();
}

async function undo() {
  const last = state.undo.pop();
  if (!last) return;
  const index = state.project.segments.findIndex((s) => s.id === last.id);
  if (index >= 0) state.project.segments[index] = JSON.parse(last.before);
  await persist();
  selectShort(state.selectedId);
}

// MARK: Export

function openExportDialog(onlyId = null) {
  const list = state.project.segments.map((s, i) => `
    <label class="check"><input type="checkbox" name="pick" value="${s.id}" ${!onlyId || s.id === onlyId ? 'checked' : ''}>
      ${esc(s.suggestedTitle || `Short ${i + 1}`)} <span class="muted small">${clock(s.duration)}</span></label>`).join('');
  const qualities = Object.entries(EXPORT_QUALITIES).map(([k, q]) => `<option value="${k}">${q.title} — ${q.detail}</option>`).join('');
  openDialog(`
    <form id="export-form" class="stack">
      <h2>Export Shorts</h2>
      ${list}
      <label>Quality <select name="quality">${qualities}</select></label>
      <p class="muted small">Each Short downloads as an MP4, with its title and description in a .txt file next to it.</p>
      <p id="export-status" class="muted small" role="status"></p>
      <div class="row end">
        <button type="button" class="button ghost" data-action="close">Cancel</button>
        <button class="button primary">Export</button>
      </div>
    </form>`);
  $('#export-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const ids = [...form.querySelectorAll('input[name=pick]:checked')].map((i) => i.value);
    if (ids.length === 0) { $('#export-status').textContent = 'Choose at least one Short.'; return; }
    // Where the browser allows it, files go into a folder the person picks; otherwise they download one by one.
    let folder = null;
    if ('showDirectoryPicker' in window) {
      try { folder = await window.showDirectoryPicker({ id: 'prism-export', mode: 'readwrite', startIn: 'downloads' }); }
      catch (error) { if (error.name === 'AbortError') return; }
    }
    exportShorts(ids, form.elements.quality.value, folder);
  });
}

async function exportShorts(ids, quality, folder = null) {
  const task = beginTask('Exporting…');
  const settings = exportSettings(quality);
  const seconds = [];
  let made = 0;
  try {
    for (const [index, id] of ids.entries()) {
      const segment = state.project.segments.find((s) => s.id === id);
      const media = state.project.media.find((m) => m.id === segment.mediaId);
      const source = await sourceFor(media);
      const label = segment.suggestedTitle?.trim() || `${state.project.title} Short ${state.project.segments.indexOf(segment) + 1}`;
      setTask(`Exporting ${index + 1} of ${ids.length} · ${label}`, index / ids.length);
      const blob = await render(source, segment, {
        ...settings, quality, signal: task.controller.signal,
        metadata: { title: segment.suggestedTitle?.trim() ?? '', description: segment.suggestedDescription?.trim() ?? '' },
        progress: (fraction) => setTask(`Exporting ${index + 1} of ${ids.length} · ${label}`, (index + fraction) / ids.length),
      });
      const base = await uniqueName(folder, safeName(label));
      await saveFile(folder, blob, `${base}.mp4`);
      const notes = [segment.suggestedTitle?.trim(), segment.suggestedDescription?.trim()].filter(Boolean).join('\n\n');
      if (notes) await saveFile(folder, new Blob([notes + '\n'], { type: 'text/plain' }), `${base}.txt`);
      seconds.push(segment.duration);
      made++;
    }
  } catch (error) {
    endTask(task);
    if (task.controller.signal.aborted) return;
    return showError('Couldn’t export', error.message);
  }
  endTask(task);
  openDialog(`<div class="stack"><h2>Exported</h2>
    <p>${made} ${made === 1 ? 'Short' : 'Shorts'} ${folder ? `saved to the folder “${esc(folder.name)}”` : 'downloaded to your Downloads folder'}.</p>
    <div class="row end"><button class="button primary" data-action="close">OK</button></div></div>`);
  if (made > 0) recordExport(made, seconds.reduce((a, b) => a + b, 0), quality);
}

/** A name that doesn't exist in the folder yet ("Title", then "Title 2"); downloads can't be checked, so the browser numbers those. */
async function uniqueName(folder, base) {
  if (!folder) return base;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    try { await folder.getFileHandle(`${candidate}.mp4`); } catch (error) {
      if (error.name === 'NotFoundError') return candidate;
      throw error;
    }
  }
}

async function saveFile(folder, blob, name) {
  if (!folder) { download(blob, name); await new Promise((resolve) => setTimeout(resolve, 300)); return; }
  const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
  await writable.write(blob);
  await writable.close();
}

async function recordExport(count, seconds, quality) {
  try {
    await db().from('exports').insert({ short_count: count, seconds, quality });
  } catch { /* stats only; the export itself succeeded */ }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const safeName = (value) => value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Short';

// MARK: Usage and promo codes

async function openUsage() {
  await refreshUsage();
  const u = state.usage;
  openDialog(`
    <form id="promo-form" class="stack">
      <h2>Usage</h2>
      <p>${u ? `${Math.floor(u.used)} of ${Math.floor(u.allowance)} minutes used.` : 'Usage is unavailable right now.'}</p>
      <p class="muted small">Each video counts its length once. Analyzing a video again uses a share of its minutes, shown before you confirm.</p>
      <label>Promo code <input name="code" autocomplete="off"></label>
      <p id="promo-status" class="muted small" role="status"></p>
      <div class="row end">
        <a class="button ghost" href="../pricing.html">Pricing</a>
        <button class="button ghost" type="button" data-action="close">Close</button>
        <button class="button primary">Redeem</button>
      </div>
    </form>`);
  $('#promo-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get('code').trim();
    if (!code) return;
    const { error } = await db().rpc('redeem_promo', { p_code: code });
    $('#promo-status').textContent = error ? error.message : 'Promo code added. Your allowance is updated.';
    if (!error) refreshUsage();
  });
}

// MARK: Events

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'close') closeDialog();
  else if (action === 'cancel') cancelTask();
  else if (action === 'home') showHome();
  else if (action === 'open') openProject(target.dataset.id);
  else if (action === 'delete-project') {
    const project = await store.loadProject(target.dataset.id);
    if (!project || !confirm(`Delete “${project.title}” and its Shorts from this browser? This can't be undone.`)) return;
    await store.deleteProject(project);
    for (const media of project.media) state.sources.delete(media.id);
    showHome();
  }
  else if (action === 'select') selectShort(target.dataset.id);
  else if (action === 'make') openMakeDialog(target.dataset.id);
  else if (action === 'export-dialog') openExportDialog();
  else if (action === 'export-one') openExportDialog(state.selectedId);
  else if (action === 'undo') undo();
  else if (action === 'usage') openUsage();
  else if (action === 'import-more') $('#import-more').click();
  else if (action === 'retrack') edit(async (s) => { s.cropKeyframes = null; await retrack(s, await sourceFor(state.project.media.find((m) => m.id === s.mediaId))); });
  else if (action === 'remove') {
    if (!confirm('Remove this Short? You can undo this with Ctrl+Z.')) return;
    const index = state.project.segments.findIndex((s) => s.id === state.selectedId);
    state.undo.push({ id: state.selectedId, before: JSON.stringify(state.project.segments[index]) });
    state.project.segments.splice(index, 1);
    state.selectedId = state.project.segments[0]?.id ?? null;
    await persist();
    renderEditor();
    if (state.selectedId) selectShort(state.selectedId);
    else setStage('<p class="muted">Make Shorts from a video to start.</p>');
  } else if (action === 'regen-captions') regenerateCaptions();
});

document.addEventListener('change', (event) => {
  const field = event.target.dataset?.field;
  // Title and description save as you type (see the input listener).
  if (!field || field === 'suggestedTitle' || field === 'suggestedDescription' || !selected()) return;
  const input = event.target;
  edit(async (s) => {
    if (field === 'captionTexts') {
      const lines = input.value.split('\n');
      if (lines.length === (s.captions ?? []).length) s.captions = s.captions.map((c, i) => ({ ...c, text: lines[i] }));
      return;
    }
    if (field === 'start' || field === 'duration') {
      const value = Number(input.value);
      if (Number.isFinite(value)) applyTiming(s, field === 'start' ? value : s.start, field === 'duration' ? value : s.duration);
      return;
    }
    if (field === 'splitScreen') s.splitScreen = input.checked;
    else if (field === 'fitToFrame') { s.fitToFrame = input.checked; s.cropKeyframes = null; }
    else if (field === 'isMuted') s.isMuted = input.checked;
    else if (field === 'captionAnimated') s.captionAnimated = input.checked;
    else s[field] = input.value;
    if (field === 'splitScreen' && input.checked && !s.splitCenters) {
      const source = await sourceFor(state.project.media.find((m) => m.id === s.mediaId));
      const media = state.project.media.find((m) => m.id === s.mediaId);
      s.splitCenters = await Framing.findSplitCenters(source, s.start, s.duration, { accessToken, usage: await usageFor(media, source) }).catch(() => null) ?? undefined;
    }
  });
});

document.addEventListener('input', (event) => {
  if (event.target.dataset?.field === 'suggestedTitle' || event.target.dataset?.field === 'suggestedDescription') {
    const s = selected();
    if (s) { s[event.target.dataset.field] = event.target.value; persist(); }
  }
});

async function regenerateCaptions() {
  const segment = selected();
  if (!segment) return;
  const media = state.project.media.find((m) => m.id === segment.mediaId);
  const task = beginTask('Prism AI · regenerating subtitles…');
  try {
    const source = await sourceFor(media);
    // The saved sentence transcript is in source seconds, as the engine expects.
    const saved = state.project.transcripts?.[media.id]?.cues ?? null;
    const { cues, words, notice } = await Selection.regenerateCaptions(source, { start: segment.start, end: segment.start + segment.duration },
      { accessToken, usage: await usageFor(media, source) }, task.controller.signal, saved);
    endTask(task);
    await edit(async (s) => {
      s.captions = cues.map((c) => ({ ...c, start: c.start - segment.start }));
      s.speechWords = words.map((w) => ({ ...w, start: w.start - segment.start }));
      s.captionNotice = notice ?? undefined;
    });
  } catch (error) {
    endTask(task);
    if (!task.controller.signal.aborted) reportGenerationError(error);
  }
}

window.addEventListener('beforeunload', (event) => {
  // Analysis and export run in this tab; leaving would lose them.
  if (state.task) { event.preventDefault(); event.returnValue = ''; }
});

document.addEventListener('mousedown', (event) => { if (event.target.id === 'dialog') closeDialog(); });

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.dialog) { closeDialog(); return; }
  if (event.target.closest('input,textarea,select') || state.dialog) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
  if (event.key === ' ') { const player = $('#player'); if (player) { event.preventDefault(); player.paused ? player.play() : player.pause(); } }
});

boot();
