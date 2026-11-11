// Relio in the browser: projects, Shorts, the editor and export. The screens follow the macOS app's flows; the engine is in ./engine.
import { GeminiError, StageFailure, ShortMakerError } from './engine/gemini.js';
import { openSource, thumbnail, frameImage, letterbox } from './engine/media.js';
import * as Shorts from './engine/shortmaker.js';
import * as Framing from './engine/framing.js';
import * as Selection from './engine/selection.js';
import { render, preview, exportSettings, drawFrame, layoutAt } from './engine/render.js';
import { STYLE_TITLES, STYLE_DETAILS, VIDEO_TYPE_TITLES, VIDEO_TYPE_DETAILS, REGION_TITLES, EXPORT_QUALITIES, CAPTION_STYLES, VIDEO_TYPES } from './engine/models.js';
import { stylePreview } from './engine/captions.js';
import { mountPlayer, unmountPlayer } from './player.js';
import * as store from './store.js';
import { configureSync, requestSync, sync, syncStatus, onSyncStatus } from './sync.js';
import { uploadVideo, downloadVideo, removeVideos, removeAllVideos, cloudUsage, CloudVideoError } from './cloudvideo.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uuid = () => crypto.randomUUID();
const clock = (seconds) => {
  const total = Math.round(seconds), m = Math.floor(total / 60), s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};
const db = () => window.prismDb;
const userId = () => state.session?.user?.id ?? null;
/** This browser can hold several accounts' projects; only the signed-in account's (and ones saved before accounts, which the first sync claims) show. */
const isMine = (item) => userId() !== null && (!item.owner || item.owner === userId());

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
  badge.textContent = state.usage ? `${Math.ceil(state.usage.used)} of ${Math.floor(state.usage.allowance)} min used` : '';
}



// MARK: Routes: every screen has its own address, so reload, Back and shared links all work

/** A custom analytics event (see /analytics.js). Only counts and buckets go in `data`, never titles or anything a person wrote. */
const track = (name, data) => window.prismTrack?.(name, data);
const lengthBucket = (minutes) => minutes < 10 ? '<10 min' : minutes < 30 ? '10–30 min' : minutes < 60 ? '30–60 min' : '60+ min';

const slug = (name) => name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
/** Projects and folders are named by their title plus the start of their id, so two with the same name still have different addresses. */
const projectPath = (project) => `/app/project/${encodeURIComponent(slug(project.title))}-${project.id.slice(0, 8)}`;
const folderPath = (folder) => `/app/folder/${encodeURIComponent(slug(folder.name))}-${folder.id.slice(0, 8)}`;
const CREATE_STEPS = ['choose-video', 'settings', 'captions', 'content-type'];

let routing = false;
/** Puts the screen's address in the browser's bar. Moving between screens adds a history entry; `replace` rewrites the current one. */
function setUrl(path, replace = false) {
  state.path = path;
  if (routing || location.pathname === path) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
}

/** Shows whatever the address names; an address that names nothing shows Home. */
async function route() {
  routing = true;
  try {
    const [first, second, third] = location.pathname.replace(/^\/app\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const idOf = (part) => part?.split('-').at(-1) ?? '';
    if (first === 'create') {
      const step = Math.max(1, CREATE_STEPS.indexOf(second) + 1);
      // With a video already chosen the steps can be walked with Back and Forward; otherwise start at the first.
      if (state.create?.project) { state.create.step = step; setScreen('create'); renderCreate(); }
      else startCreate();
    } else if (first === 'settings') await showSettings(second);
    else if (first === 'folder' && second) {
      const folder = (await store.listFolders()).filter(isMine).find((f) => f.id.startsWith(idOf(second)));
      await showHome(folder ? { folderId: folder.id } : null);
    } else if (first === 'project' && second) {
      const project = (await store.listProjects()).filter(isMine).find((p) => p.id.startsWith(idOf(second)));
      if (project) await openProject(project.id, third); else await showHome();
    } else await showHome();
  } finally { routing = false; }
  // The address as the screen itself spells it (a short link or an old name becomes the proper one).
  if (state.path && location.pathname !== state.path) history.replaceState(null, '', state.path);
}
window.addEventListener('popstate', () => route());

// MARK: Boot and the app shell (sidebar, title bar and sign-in card, as in the macOS app)

const SCREEN_TITLES = { home: 'Home', create: 'Create Shorts', settings: 'Settings' };

async function boot() {
  if (!('VideoDecoder' in window && 'VideoEncoder' in window && 'OffscreenCanvas' in window)) {
    $('#app').innerHTML = `<section class="card auth"><h1>Open Relio in another browser</h1>
      <p class="muted">Relio reads and renders video in your browser with WebCodecs, which this browser doesn’t have. Use a current Chrome, Edge, Safari or Firefox.</p></section>`;
    return;
  }
  configureSync({
    db, userId,
    ensureHashes,
    // Something arrived from another device: Home shows it at once.
    onUpdated: () => { if (state.screen === 'home') showHome(state.homeView); },
    // With the projects in step, deleted projects' videos are removed from storage and new videos go up.
    afterSync: () => { removePendingVideos(); uploadPending(); expireUntouched(); },
  });
  applyTheme(savedTheme());
  applyCollapsed(savedSidebar() === '1');
  if (!db()) {
    await route();
    return renderGate('Sign-in is unavailable right now. Check your connection and reload.');
  }
  state.session = (await db().auth.getSession()).data.session;
  db().auth.onAuthStateChange((_event, session) => {
    state.session = session;
    renderGate();
    if (session) { refreshUsage(); requestSync(0); }
  });
  // Captions draw on canvas, which never waits for a font: load the Latin and Cyrillic caption faces first.
  await Promise.all([document.fonts.load('800 66px "Relio Captions"', 'Aa Яя ĄŁ'), document.fonts.load('500 46px Sora')]).catch(() => {});
  renderGate();
  await route();
  refreshUsage();
  if (state.session) requestSync(0);
}

function setScreen(screen) {
  state.screen = screen;
  const title = screen === 'editor' ? (state.project?.title ?? 'Editor') : SCREEN_TITLES[screen];
  const heading = $('#screen-title');
  if (screen === 'editor') {
    // The project's name is the title: edit it in place.
    if (!heading.querySelector('input')) heading.innerHTML = '<input id="title" class="title-input" aria-label="Project name">';
    heading.querySelector('input').value = state.project?.title ?? '';
  } else heading.textContent = title;
  $('#export-button').hidden = screen !== 'editor';
  document.title = `${title} · Relio Clips`;
  // The editor keeps only what editing needs, so the theme switch lives on the other screens.
  $('.theme-toggle').hidden = screen === 'editor';
  for (const button of document.querySelectorAll('.side-button')) {
    button.classList.toggle('selected', button.dataset.screen === screen);
  }
}

function savedSidebar() {
  try { return localStorage.getItem('prism-sidebar'); } catch { return null; }
}
function applyCollapsed(collapsed) {
  $('.shell').classList.toggle('collapsed', collapsed);
  const button = $('.collapse-button');
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  try { localStorage.setItem('prism-sidebar', collapsed ? '1' : '0'); } catch { /* the choice just isn't remembered */ }
}

function savedTheme() {
  try { return localStorage.getItem('prism-theme'); } catch { return null; }
}
/** Switches theme as one short crossfade of a snapshot, so the page never repaints piece by piece; plain switch where that isn't supported. */
function switchTheme(theme) {
  const change = () => applyTheme(theme);
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(change);
  else change();
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try { if (theme) localStorage.setItem('prism-theme', theme); } catch { /* the choice just isn't remembered */ }
  const dark = (theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'dark';
  $('#theme-dark')?.setAttribute('aria-pressed', String(dark));
  $('#theme-light')?.setAttribute('aria-pressed', String(!dark));
}

const bytes = (value) => (value >= 1e9 ? `${Number((value / 1e9).toFixed(1))} GB` : value >= 1e6 ? `${Math.round(value / 1e6)} MB`
  : value > 0 ? `${Math.max(1, Math.round(value / 1e3))} KB` : '0 MB');

/** While nobody is signed in, the full-screen sign-in screen (/auth.js) covers the whole app. */
function renderGate(message = '') {
  const gate = $('#gate');
  const open = !state.session;
  $('.shell').inert = open;
  gate.hidden = !open;
  if (!open) { gate.innerHTML = ''; return; }
  if (gate.querySelector('.auth') && !message) return;
  gate.innerHTML = '';
  const screen = window.prismAuth.mount(gate, {
    db: db(), mode: new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'signin', redirectTo: location.origin + '/app/',
    onSignedIn: async () => {
      state.session = (await db().auth.getSession()).data.session;
      renderGate();
      refreshUsage();
    },
  });
  if (message) gate.querySelector('.auth-status').textContent = message;
  return screen;
}

// MARK: Home (projects and folders), as in the macOS app

const dateText = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';

/** `view` is null for Home, or { folderId } inside a folder. */
// A project nobody edited for this long is deleted with its video and Shorts, here and in the cloud. Editing restarts the clock.
const UNTOUCHED_DAYS = 7;

/** Whole days before an untouched project is deleted: 7 right after an edit, 1 on its last day. */
function daysLeft(project) {
  const edited = Date.parse(project.updated ?? project.created);
  return Number.isFinite(edited) ? Math.max(1, UNTOUCHED_DAYS - Math.floor((Date.now() - edited) / 86_400_000)) : UNTOUCHED_DAYS;
}

/** Runs after each sync, so an edit made on another device arrives before anything is judged untouched. */
async function expireUntouched() {
  const cutoff = Date.now() - UNTOUCHED_DAYS * 86_400_000;
  let removed = 0;
  for (const project of (await store.listProjects()).filter(isMine)) {
    // An unreadable date never counts as old, and the open project is never removed under the person.
    if (project.id === state.project?.id || !(Date.parse(project.updated ?? project.created) < cutoff)) continue;
    await store.deleteProject(project);
    removed++;
  }
  if (!removed) return;
  requestSync(0);
  if (state.screen === 'home') showHome(state.homeView);
}

/** Once per account: the 7-day rule, before it can surprise anyone. */
function retentionNotice() {
  const key = `relio.retention-notice.${userId()}`;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch { /* storage blocked: show it each time */ }
  openDialog(`<div class="stack"><h2>Projects you don’t edit are deleted after ${UNTOUCHED_DAYS} days</h2>
    <p>If you don’t change a project for ${UNTOUCHED_DAYS} days, Relio deletes it: the video, its Shorts and everything else in it, on this device and in the cloud. Any edit, re-analysis or export, like moving a clip on the timeline, starts a new ${UNTOUCHED_DAYS}-day period. You’ll see a warning on Home 2 days before.</p>
    <p class="muted small">Export the Shorts you want to keep. Exported files on your computer are never touched.</p>
    <div class="row end"><button class="button primary" data-action="close">Got it</button></div></div>`);
}

async function showHome(view = null) {
  state.project = null;
  state.create = null;
  state.homeView = view;
  setScreen('home');
  if (userId()) retentionNotice();
  const [everything, allFolders] = await Promise.all([store.listProjects(), store.listFolders()]);
  const all = everything.filter(isMine), folders = allFolders.filter(isMine);
  state.projects = all;
  state.folders = folders;
  // A project that came from another device has no video here until it is added again.
  const noVideo = new Map(); // project id -> every missing video is in the cloud
  for (const p of all) {
    const missing = [];
    for (const m of p.media) if (!(await store.hasFile(m.id))) missing.push(m);
    if (missing.length) noVideo.set(p.id, missing.every((m) => m.cloud?.uploaded));
  }
  // There is no Trash anymore: projects still in it were meant to go, so they are deleted, here and in the cloud.
  const trashed = all.filter((p) => p.trashed);
  if (trashed.length) {
    for (const project of trashed) { await store.deleteProject(project); for (const media of project.media) state.sources.delete(media.id); }
    requestSync(0);
  }
  const live = all.filter((p) => !p.trashed);
  const folder = view?.folderId ? folders.find((f) => f.id === view.folderId) : null;
  if (view?.folderId && !folder) return showHome();
  setUrl(folder ? folderPath(folder) : '/app');
  const inFolder = (id) => live.filter((p) => p.folderId === id);

  const card = (p) => {
    const poster = p.media.find((m) => m.thumbnail)?.thumbnail;
    const info = `${plural(p.segments.length, 'Short')} · ${dateText(p.updated ?? p.created)}`;
    const left = daysLeft(p);
    const expiry = left <= 2 ? `<span class="missing small">${left <= 1 ? 'Deleted tomorrow' : `Deleted in ${left} days`} unless you edit or export it</span>` : '';
    const away = noVideo.has(p.id) ? `<span class="missing small">${noVideo.get(p.id) ? 'Video downloads when you open it' : 'Video not on this device'}</span>` : '';
    const body = `<div class="poster">${poster ? `<img alt="" src="${poster}">` : ''}<span class="badge">${clock(p.media[0]?.duration ?? 0)}</span></div>
          <strong class="p-title">${esc(p.title)}</strong><span class="muted small">${info}</span>${expiry}${away}`;
    return `<div class="project-card" draggable="true" data-project="${esc(p.id)}">
          <button class="open" data-action="open" data-id="${esc(p.id)}">${body}</button>
          <button class="card-menu" data-action="project-menu" data-id="${esc(p.id)}" aria-label="Options for ${esc(p.title)}" aria-haspopup="menu">⋯</button></div>`;
  };
  const grid = (list) => (list.length ? `<div class="grid">${list.map(card).join('')}</div>` : '');
  const back = '<button class="link back-home" data-action="home">← Home</button>';

  let html;
  if (folder) {
    const list = inFolder(folder.id);
    html = `${back}<div class="row between"><h2>${esc(folder.name)}</h2>
        <button class="card-menu shown" data-action="folder-menu" data-id="${esc(folder.id)}" aria-label="Folder options" aria-haspopup="menu">⋯</button></div>
      ${grid(list) || `<div class="empty"><strong>This folder is empty</strong><span class="muted">Go back to Projects and drag a project onto this folder, or open a project’s ⋯ menu › Move to folder.</span></div>`}`;
  } else {
    const tiles = folders.map((f) => `<div class="folder-tile" data-folder="${esc(f.id)}">
        <button class="open" data-action="open-folder" data-id="${esc(f.id)}">${folderIcon}<span><strong>${esc(f.name)}</strong><span class="muted small">${plural(inFolder(f.id).length, 'project')}</span></span></button>
        <button class="card-menu" data-action="folder-menu" data-id="${esc(f.id)}" aria-label="Options for ${esc(f.name)}" aria-haspopup="menu">⋯</button></div>`).join('');
    const loose = live.filter((p) => !folders.some((f) => f.id === p.folderId));
    html = `<button class="start-card" data-action="create">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>
        <span class="start-text"><strong>Start creating</strong><span>One in. Many out. Choose a video and Relio finds the moments worth sharing.</span></span>
        <span class="start-arrow" aria-hidden="true">→</span></button>
      <div class="row between"><h2>Projects</h2><button class="link new-folder" data-action="new-folder">${folderIcon}New folder</button></div>
      ${tiles ? `<div class="folders">${tiles}</div>` : ''}
      ${grid(loose) || (live.length === 0 ? '<div class="empty"><strong>Your projects will appear here</strong><span class="muted">Create a Short to start your first project.</span></div>' : '')}`;
  }
  // Day 5 on: a banner names the projects about to go, so nobody loses one without warning.
  const soon = all.filter((p) => daysLeft(p) <= 2).sort((a, b) => daysLeft(a) - daysLeft(b));
  const warning = soon.length ? `<div class="notice" role="status"><strong>${soon.length === 1 ? `“${esc(soon[0].title)}” will be deleted ${daysLeft(soon[0]) <= 1 ? 'tomorrow' : `in ${daysLeft(soon[0])} days`}.` : `${soon.length} projects will be deleted within 2 days.`}</strong> Export your Shorts now, or make any edit to keep a project for another ${UNTOUCHED_DAYS} days.</div>` : '';
  $('#app').innerHTML = `<section class="dashboard">${warning}${html}</section>`;
}

// MARK: Menus and the small dialogs behind them

function closeMenu() {
  $('#menu')?.remove();
}

/** A pop-up menu next to `anchor` (or at the pointer for a right-click). Items are { label, run, danger } or '-' for a divider. */
function openMenu(items, anchor, point = null) {
  closeMenu();
  const menu = document.createElement('div');
  menu.id = 'menu';
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === '-') { menu.append(document.createElement('hr')); continue; }
    const button = Object.assign(document.createElement('button'), { textContent: item.label, className: item.danger ? 'danger' : '' });
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => { closeMenu(); item.run(); });
    menu.append(button);
  }
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  const rect = anchor?.getBoundingClientRect();
  const x = point ? point.x : rect.right - box.width, y = point ? point.y : rect.bottom + 4;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
  menu.querySelector('button')?.focus();
}

/** Changes a project in storage without counting as an edit of its content. */
async function changeProject(id, change) {
  const project = await store.loadProject(id);
  if (!project) return;
  change(project);
  await store.saveProject(project, { touch: false });
  showHome(state.homeView);
}

/** Deletes a project for good in one step: here, in the cloud copy of the account, and its stored video (unless another project
 * uses the same video). Opening the ⋯ menu first is what guards against a slip. */
/** Deletes the account for good: every cloud video first, then the account with all its rows, then this browser's copy. */
async function deleteAccount() {
  const user = state.session?.user;
  if (!user || !confirm(`Are you sure you want to delete your account ${user.email}? Your projects, Shorts, stats and every video in the cloud are deleted for good. This can't be undone.`)) return;
  const note = (text) => { if ($('#delete-account-note')) $('#delete-account-note').textContent = text; };
  note('Deleting…');
  try {
    await removeAllVideos({ token: accessToken });
  } catch (error) {
    // Stop here, so no video is left behind in the cloud without an account; with no cloud storage set up there is nothing to remove.
    if (error.kind !== 'unavailable') return note(`Your account wasn't deleted: ${error.message}`);
  }
  const { error } = await db().rpc('delete_my_account');
  if (error) return note(`Your account wasn't deleted: ${error.message}`);
  await store.deleteOwner(user.id);
  await db().auth.signOut().catch(() => {});
  state.session = null;
  renderGate();
}

async function deleteProjectNow(id) {
  const project = await store.loadProject(id);
  if (!project || !confirm(`Are you sure you want to delete “${project.title}”? It is deleted for good, including its video in the cloud.`)) return;
  await store.deleteProject(project);
  for (const media of project.media) state.sources.delete(media.id);
  requestSync(0);
  showHome(state.homeView);
}

function projectMenu(id, anchor, point) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return;
  openMenu([
    { label: 'Rename', run: () => askName('Rename project', project.title, 'Rename', (name) => changeProject(id, (p) => { p.title = name; })) },
    { label: 'Move to folder…', run: () => moveDialog(project) },
    ...(project.folderId ? [{ label: 'Remove from folder', run: () => changeProject(id, (p) => { delete p.folderId; }) }] : []),
    { label: 'Show stats', run: () => statsDialog(project) },
    '-',
    { label: 'Delete', danger: true, run: () => deleteProjectNow(id) },
  ], anchor, point);
}

function folderMenu(id, anchor, point) {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) return;
  openMenu([
    { label: 'Rename folder', run: () => askName('Rename folder', folder.name, 'Rename', async (name) => { await store.saveFolder({ ...folder, name }); showHome(state.homeView); }) },
    { label: 'Delete folder', danger: true, run: () => deleteFolder(folder) },
  ], anchor, point);
}

/** A one-field dialog: used to name or rename projects and folders. */
function askName(title, value, action, done) {
  openDialog(`<form id="name-form" class="stack"><h2>${esc(title)}</h2>
    <input name="name" value="${esc(value)}" maxlength="100" aria-label="Name" autocomplete="off">
    <div class="row end"><button type="button" class="button ghost" data-action="close">Cancel</button><button class="button primary">${esc(action)}</button></div></form>`);
  const input = $('#name-form input');
  input.select();
  $('#name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    closeDialog();
    done(name);
  });
}

function newFolder(then = null) {
  askName('New folder', '', 'Create', async (name) => {
    const folder = { id: uuid(), owner: userId(), name, created: new Date().toISOString() };
    await store.saveFolder(folder);
    if (then) await then(folder);
    else showHome(state.homeView);
  });
}

function moveDialog(project) {
  const rows = state.folders.map((f) => `<button class="choice-row ${f.id === project.folderId ? 'on' : ''}" data-move="${esc(f.id)}">${folderIcon}<span>${esc(f.name)}</span>${f.id === project.folderId ? '<span class="muted small">current</span>' : ''}</button>`).join('');
  openDialog(`<div class="stack"><h2>Move to folder</h2><p class="muted small">${esc(project.title)}</p>
    <div class="stack">${rows || '<p class="muted small">No folders yet.</p>'}</div>
    <button class="button ghost" data-move="new">New folder…</button>
    <div class="row end"><button class="button ghost" data-action="close">Cancel</button></div></div>`);
  $('#dialog').querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => {
    closeDialog();
    if (button.dataset.move === 'new') newFolder((folder) => changeProject(project.id, (p) => { p.folderId = folder.id; }));
    else changeProject(project.id, (p) => { p.folderId = button.dataset.move; });
  }));
}

async function deleteFolder(folder) {
  if (!confirm(`Delete the folder “${folder.name}”? Its projects go back to Projects.`)) return;
  for (const project of state.projects.filter((p) => p.folderId === folder.id)) {
    delete project.folderId;
    await store.saveProject(project, { touch: false });
  }
  await store.deleteFolder(folder.id);
  showHome();
}

function statsDialog(project) {
  const total = (list, key) => list.reduce((sum, item) => sum + (item[key] ?? 0), 0);
  const sizes = [...new Set(project.media.map((m) => `${m.width} × ${m.height}`))];
  const rows = [
    ['Shorts', project.segments.length],
    ['Total length of Shorts', clock(total(project.segments, 'duration'))],
    ['Exported videos', project.exported ?? 0],
    ['Source videos', project.media.length],
    ['Source length', clock(total(project.media, 'duration'))],
    ['Resolution', sizes.join(', ') || '—'],
    ['Created', dateText(project.created)],
    ['Size on disk', bytes(total(project.media, 'size'))],
  ];
  openDialog(`<div class="stack"><h2>${esc(project.title)}</h2><dl class="stats">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="row end"><button class="button primary" data-action="close">OK</button></div></div>`);
}

// Right-click on a card or folder opens the same menu as its ⋯ button.
document.addEventListener('contextmenu', (event) => {
  const project = event.target.closest('[data-project]'), folder = event.target.closest('[data-folder]');
  if (!project && !folder) return;
  event.preventDefault();
  const point = { x: event.clientX, y: event.clientY };
  if (project) projectMenu(project.dataset.project, null, point);
  else folderMenu(folder.dataset.folder, null, point);
});
document.addEventListener('mousedown', (event) => { if (!event.target.closest('#menu')) closeMenu(); });

// Dragging a project onto a folder moves it there.
let dragged = null;
document.addEventListener('dragstart', (event) => {
  const card = event.target.closest?.('[data-project]');
  if (!card) return;
  dragged = card.dataset.project;
  event.dataTransfer.setData('text/plain', dragged);
  event.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragend', () => { dragged = null; for (const tile of document.querySelectorAll('.folder-tile.over')) tile.classList.remove('over'); });
document.addEventListener('dragover', (event) => {
  const tile = event.target.closest?.('[data-folder]');
  if (dragged && tile) { event.preventDefault(); tile.classList.add('over'); }
});
document.addEventListener('dragleave', (event) => event.target.closest?.('[data-folder]')?.classList.remove('over'));
document.addEventListener('drop', (event) => {
  const tile = event.target.closest?.('[data-folder]');
  if (!dragged || !tile) return;
  event.preventDefault();
  const id = dragged;
  dragged = null;
  changeProject(id, (p) => { p.folderId = tile.dataset.folder; });
});

// Dropping a video anywhere on Home or on the first Create step starts Shorts from it.
let dragDepth = 0;
const dropAllowed = () => state.session && (state.screen === 'home' || (state.screen === 'create' && state.create?.step === 1));
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragenter', (event) => {
  if (!hasFiles(event) || !dropAllowed()) return;
  event.preventDefault();
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
document.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#drop-overlay').hidden = true;
});
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const file = [...event.dataTransfer.files].find((f) => f.type.startsWith('video/') || !f.type);
  if (file && dropAllowed()) startCreate({ file });
});

// MARK: Create Shorts (five steps: video, settings, captions, content type, then the run)

// Names as Relio AI is told them; Auto detects the language once per video.
const LANGUAGES = ['auto', 'English', 'Ukrainian', 'Polish', 'German', 'French', 'Spanish', 'Italian', 'Portuguese', 'Dutch', 'Czech',
  'Lithuanian', 'Latvian', 'Estonian', 'Romanian', 'Turkish', 'Russian', 'Arabic', 'Hindi', 'Japanese', 'Korean', 'Chinese'];
const LENGTHS = [[0, 'Auto'], [15, '15 seconds'], [30, '30 seconds'], [45, '45 seconds'], [60, '60 seconds'], [90, '90 seconds']];

function startCreate({ project = null, media = null, file = null } = {}) {
  setScreen('create');
  state.create = {
    step: media ? 2 : 1, project, media, count: 0, duration: 0, region: 'entireVideo', customStart: 0, language: 'auto',
    customEnd: media ? Math.round(media.duration / 6) / 10 : 0, style: 'auto', videoType: 'auto', busy: false, error: '',
  };
  if (file) chooseVideo(file);
  else renderCreate();
}

async function chooseVideo(file) {
  track('video_selected');
  const c = state.create;
  c.error = '';
  c.busy = true;
  renderCreate();
  try {
    // A video chosen before and never used for Shorts leaves nothing behind.
    if (c.project && c.project.segments.length === 0) await store.deleteProject(c.project);
    const project = { id: uuid(), owner: userId(), title: file.name.replace(/\.[^.]+$/, ''), created: new Date().toISOString(), media: [], segments: [], transcripts: {} };
    const media = await importMedia(project, file);
    await store.saveProject(project);
    Object.assign(c, { project, media, customEnd: Math.round(media.duration / 6) / 10, step: 2 });
  } catch (error) {
    c.error = error.message || 'That file is not a video this browser can read.';
  }
  c.busy = false;
  renderCreate();
}

/** Why the custom range can't be used, or null when it can. */
function rangeProblem(c) {
  if (c.region !== 'custom') return null;
  const total = c.media.duration / 60;
  return c.customStart >= 0 && c.customEnd > c.customStart && c.customEnd <= total + 0.01 ? null : `Choose a range inside the video: from 0 to ${total.toFixed(2)} minutes, with the end after the start.`;
}

function renderCreate() {
  const c = state.create;
  setUrl(`/app/create/${CREATE_STEPS[c.step - 1]}`);
  const eyebrow = (n, label) => `<p class="eyebrow">Step ${n} of 5 · ${label}</p>`;
  const back = `<button class="link back" data-action="home">← Back to Home</button>`;
  let html;
  if (c.step === 1) {
    html = `${eyebrow(1, 'Choose video')}<h2 class="big">Choose a video</h2>
      <p class="muted">Relio keeps the video in this browser and saves it to your account, so the project opens on any device you sign in on. Relio AI reads its audio and some frames.</p>
      <label class="drop-card ${c.busy ? 'busy' : ''}"><input id="pick" type="file" accept="video/*" hidden ${c.busy ? 'disabled' : ''}>
        <span class="drop-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 16V4m-5 5 5-5 5 5M5 20h14"/></svg></span>
        <strong>${c.busy ? 'Reading the video…' : 'Drop a video here'}</strong>
        ${c.busy ? '' : '<span class="muted small">or</span><span class="button primary">Choose a video</span>'}</label>
      ${c.error ? `<p class="error" role="alert">${esc(c.error)}</p>` : ''}${back}`;
  } else if (c.step === 2) {
    const m = c.media;
    const problem = rangeProblem(c);
    const where = { entireVideo: 'the entire video', firstHalf: 'the first half', lastHalf: 'the last half', custom: 'the chosen range' }[c.region];
    const many = c.count > 0 ? `up to ${c.count} distinct moments` : 'as many distinct moments as are strong (about one per minute)';
    const long = c.duration > 0 ? `of about ${c.duration} seconds` : 'as long as each story needs';
    html = `${eyebrow(2, 'Set up Shorts')}<h2 class="big">Choose your Short settings</h2><p class="muted">Your video is ready. Choose how to turn it into Shorts.</p>
      <div class="panel"><p class="file-line"><span class="tick">✓</span> ${esc(m.name)}</p>
        <p class="muted">Video duration: ${clock(m.duration)} · ${(m.duration / 60).toFixed(2)} minutes</p>
        <button class="button ghost" data-create="different">Choose a different video</button></div>
      <div class="panel"><p class="muted small">Shorts settings</p>
        <div class="settings-row">
          <div><span class="muted small">How many</span>
            <span class="stepper"><button class="button ghost" data-create="less" aria-label="Fewer Shorts">−</button><strong>${c.count > 0 ? `${c.count} ${c.count === 1 ? 'Short' : 'Shorts'}` : 'Auto'}</strong><button class="button ghost" data-create="more" aria-label="More Shorts">+</button></span></div>
          <label>Approx. length <select id="length">${LENGTHS.map(([v, t]) => `<option value="${v}" ${v === c.duration ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Language <select id="language">${LANGUAGES.map((l) => `<option value="${l}" ${l === c.language ? 'selected' : ''}>${l === 'auto' ? 'Auto' : l}</option>`).join('')}</select></label>
          <label>Take clips from <select id="region">${Object.entries(REGION_TITLES).map(([k, t]) => `<option value="${k}" ${k === c.region ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        </div>
        ${c.region === 'custom' ? `<div class="settings-row"><label>Start (minutes) <input id="from" type="number" min="0" step="0.1" value="${c.customStart}"></label>
          <label>End (minutes) <input id="to" type="number" min="0" step="0.1" value="${c.customEnd}"></label></div>
          <p class="muted small">${problem ? esc(problem) : `Analyze ${clock(c.customStart * 60)} to ${clock(c.customEnd * 60)} · ${clock((c.customEnd - c.customStart) * 60)} selected`}</p>` : ''}
        <p class="muted small">Relio will analyze frames and available speech, then suggest ${many} ${long} in ${where}. Review every pick before exporting.</p></div>
      <button class="button primary" data-create="next" ${problem ? 'disabled' : ''}>Next: Choose captions →</button>${back}`;
  } else if (c.step === 3) {
    html = `${eyebrow(3, 'Choose captions')}<h2 class="big">Choose your captions</h2><p class="muted">Pick how spoken words appear. You can change this for each Short later.</p>
      <div class="cards">${CAPTION_STYLES.map((s) => `<button class="choice ${s === c.style ? 'on' : ''}" data-style="${s}"><canvas class="style-preview" data-preview="${s}" aria-hidden="true"></canvas><strong>${STYLE_TITLES[s]}</strong><span class="muted small">${STYLE_DETAILS[s]}</span></button>`).join('')}
        <button class="choice ${c.style === 'none' ? 'on' : ''}" data-style="none"><span class="style-preview no-captions" aria-hidden="true">Aa</span><strong>No captions</strong><span class="muted small">Shorts start without captions. Turn them on for any Short later.</span></button></div>
      <div class="row"><button class="button primary" data-create="next">Next: Choose content type →</button><button class="link" data-create="prev">← Back</button></div>`;
  } else {
    html = `${eyebrow(4, 'Choose content type')}<h2 class="big">What kind of video is it?</h2><p class="muted">This tunes how Relio picks moments and frames them.</p>
      <div class="cards">${VIDEO_TYPES.map((t) => `<button class="choice ${t === c.videoType ? 'on' : ''}" data-type="${t}"><strong>${VIDEO_TYPE_TITLES[t]}</strong><span class="muted small">${VIDEO_TYPE_DETAILS[t]}</span></button>`).join('')}</div>
      <div class="row"><button class="button primary" data-create="make">Make Shorts</button><button class="link" data-create="prev">← Back</button></div>`;
  }
  $('#app').innerHTML = `<section class="create">${html}</section>`;
  for (const canvas of document.querySelectorAll('[data-preview]')) stylePreview(canvas, canvas.dataset.preview);
  $('#pick')?.addEventListener('change', (event) => event.target.files[0] && chooseVideo(event.target.files[0]));
  $('#length')?.addEventListener('change', (event) => { c.duration = Number(event.target.value); renderCreate(); });
  $('#region')?.addEventListener('change', (event) => { c.region = event.target.value; renderCreate(); });
  $('#language')?.addEventListener('change', (event) => { c.language = event.target.value; });
  for (const [id, key] of [['#from', 'customStart'], ['#to', 'customEnd']]) {
    $(id)?.addEventListener('change', (event) => { c[key] = Number(event.target.value) || 0; renderCreate(); });
  }
}

async function createAction(action) {
  const c = state.create;
  if (!c) return;
  if (action === 'less') c.count = Math.max(0, c.count - 1);
  else if (action === 'more') c.count = Math.min(Shorts.MAX_SHORTS, c.count + 1);
  else if (action === 'prev') c.step -= 1;
  else if (action === 'next') c.step += 1;
  else if (action === 'different') {
    // An import that never made Shorts leaves nothing behind.
    if (c.project && c.project.segments.length === 0) await store.deleteProject(c.project);
    Object.assign(c, { step: 1, project: null, media: null, error: '' });
  } else if (action === 'make') {
    state.project = c.project;
    makeShorts(c.media, {
      count: c.count, duration: c.duration, region: c.region, videoType: c.videoType, captionStyle: c.style, language: c.language,
      customStart: c.customStart * 60, customEnd: c.customEnd * 60,
    });
    return;
  }
  renderCreate();
}

// MARK: Settings (Account, Overview, Usage): the website's dashboard, now inside the app. No plans or prices for now.

const SETTINGS_TABS = ['account', 'overview', 'usage'];
const count = new Intl.NumberFormat();
const lengthText = (seconds) => { const s = Math.round(seconds); return s >= 60 ? `${count.format(Math.floor(s / 60))}m ${s % 60}s` : `${s}s`; };

/** Totals over the whole export history, and the latest 50 rows for the table. Row level security returns only this account's. */
async function loadExports() {
  const totals = { exports: 0, shorts: 0, seconds: 0, latest: [] };
  for (let from = 0; from < 100_000; from += 1000) {
    const { data, error } = await db().from('exports').select('id, created_at, short_count, seconds, quality')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + 999);
    if (error) throw error;
    for (const row of data) {
      totals.exports += 1; totals.shorts += row.short_count; totals.seconds += row.seconds;
      if (totals.latest.length < 50) totals.latest.push(row);
    }
    if (data.length < 1000) break;
  }
  return totals;
}

const syncText = (s) => ({
  idle: 'Waiting to sync…', syncing: 'Syncing…', unavailable: s.message, error: `Sync failed: ${s.message}`,
  ok: `Up to date${s.last ? ` · ${s.last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`,
}[s.state]);
onSyncStatus((s) => { const el = $('#sync-text'); if (el) el.textContent = syncText(s); });

async function showSettings(tab = state.settingsTab ?? 'account') {
  // Old addresses: the export history moved into Overview, and plans are switched off for now.
  if (tab === 'exports' || tab === 'plans') tab = 'overview';
  if (!SETTINGS_TABS.includes(tab)) tab = 'account';
  state.settingsTab = tab;
  setScreen('settings');
  setUrl(`/app/settings/${tab}`);
  if (state.session && tab === 'usage') await refreshUsage();
  const u = state.usage;
  const email = state.session?.user?.email;
  const used = u ? `${Math.ceil(u.used)} of ${Math.floor(u.allowance)} min used` : 'Minutes used';
  const NAV = [
    ['account', 'Account', email ?? 'Sign in to track your stats', '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0"/>', 'Your Relio account.'],
    ['overview', 'Overview', 'Stats and exports', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', 'What you have made with Relio, and your exports.'],
    ['usage', 'Usage', used, '<path d="M5 18a8 8 0 1 1 14 0M12 18l4-6"/>', 'Minutes of video you can make Shorts from, and your space for videos in the cloud.'],
  ];
  const nav = NAV.map(([id, title, detail, icon]) => `<button class="settings-item" data-action="settings-tab" data-tab="${id}" ${tab === id ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span><strong>${title}</strong><span class="muted small">${esc(detail)}</span></span></button>`).join('');
  const [, title, , , blurb] = NAV.find(([id]) => id === tab);
  let body;
  if (tab === 'usage') {
    const percent = u ? Math.min(100, u.used / u.allowance * 100) : 0;
    body = `<div class="box">
        <div class="big-number"><b>${u ? Math.ceil(u.used) : '—'}</b><span>${u ? `of ${Math.floor(u.allowance)} minutes used` : state.session ? 'Usage is unavailable. Check your connection and try again.' : 'Sign in to see usage.'}</span></div>
        <div class="meter ${percent >= 85 ? 'warn' : ''}"><div style="width:${percent}%"></div></div>
        ${u ? `<p class="muted small">${Math.max(0, Math.floor(u.allowance - u.used))} minutes left.</p>` : ''}
        <p class="muted small">Every account gets 60 minutes of video to make Shorts from. A video you already used doesn't count again; making Shorts from it again uses half of its length.</p>
      </div>
      ${email ? `<div class="box"><strong>Videos in the cloud</strong><p id="cloud-video-text">Checking…</p><div class="meter"><div id="cloud-video-bar"></div></div>
        <p class="muted small">Videos you add are saved to your account too, so a project opens on any device without choosing the file again. The same video is stored once, however many projects use it. When a new video doesn’t fit, Relio asks before deleting your oldest cloud videos. A video bigger than all your space stays on its device.</p>
        <button class="button ghost" id="retry-upload" data-action="retry-upload" hidden>Try uploading again</button></div>` : ''}
      <form id="promo-form" class="box">
        <label for="promo-code"><strong>Promo code</strong><span class="muted small">Need more minutes? Ask for a promo code, then enter it here.</span></label>
        <div class="row"><input id="promo-code" name="code" placeholder="Enter code" autocomplete="off"><button class="button primary">Redeem</button></div>
        <p id="promo-status" class="muted small" role="status"></p>
      </form>`;
  } else if (tab === 'overview') {
    body = `<div class="stat-row"><div class="stat"><b id="stat-exports">—</b><span>Exports</span></div><div class="stat"><b id="stat-shorts">—</b><span>Shorts made</span></div><div class="stat"><b id="stat-minutes">—</b><span>Minutes of Shorts</span></div></div>
      <h3 class="section-title">Export history</h3>
      <div class="box flush"><div class="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Shorts</th><th scope="col">Length</th><th scope="col">Quality</th></tr></thead><tbody id="export-rows"></tbody></table></div></div>
      <p id="stats-note" class="muted small" role="status">Loading your export history…</p>`;
  } else {
    body = `<div class="box">
        <div class="who"><span class="avatar" aria-hidden="true">${esc((email ?? '?')[0].toUpperCase())}</span><div><strong>${email ? esc(email) : 'Not signed in'}</strong><span class="muted small">${email ? 'Signed in' : 'Sign in to track your stats'}</span></div></div>
        <p class="muted small">Your projects, Shorts and videos are saved to your account, and each export adds its date, number of Shorts, length and quality to your stats under Overview.</p>
        ${email ? '<div class="row"><button class="button ghost" data-action="signout">Sign out</button><button class="button ghost danger" data-action="delete-account">Delete account</button></div><p id="delete-account-note" class="error small" role="alert"></p>' : ''}
      </div>
      ${email ? `<form id="profile-form" class="box stack">
        <strong>Profile</strong>
        <div class="profile-fields">
          <label>Name <input name="name" maxlength="60" autocomplete="name"></label>
          <label>Username <span class="at-input"><span>@</span><input name="username" maxlength="21" spellcheck="false" autocapitalize="none" placeholder="choose one"></span></label>
        </div>
        <div class="row"><button class="button primary" disabled>Save</button><span id="profile-status" class="muted small" role="status"></span></div>
      </form>` : ''}
      ${email ? `<div class="box"><strong>Cloud sync</strong><p id="sync-text">${esc(syncText(syncStatus()))}</p>
        <p class="muted small">Your projects, folders, Shorts and edits are saved to your account, so you can open them on any device you sign in on. Their videos are kept in the cloud too: see Usage.</p>
        <button class="button ghost" data-action="sync-now">Sync now</button></div>` : ''}`;
  }
  $('#app').innerHTML = `<section class="settings-layout">
    <nav class="settings-nav" aria-label="Settings categories">${nav}</nav>
    <div class="settings-content"><header class="set-head"><h2>${title}</h2><p class="muted">${blurb}</p></header>${body}</div></section>`;
  $('#promo-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get('code').trim();
    if (!code) return;
    const { error } = await db().rpc('redeem_promo', { p_code: code });
    $('#promo-status').textContent = error ? error.message : 'Promo code added. Your allowance is updated.';
    if (!error) { await refreshUsage(); showSettings('usage'); }
  });
  if (state.session && tab === 'overview') fillAccountData(tab);
  if (state.session && tab === 'account') fillProfile();
  if (tab === 'usage' && email) fillCloudVideo();
}

/** Name and username (profiles table): filled in, then saved on Save. Usernames are unique; the database has the last word. */
async function fillProfile() {
  const form = $('#profile-form');
  if (!form) return;
  const { data, error } = await db().from('profiles').select('display_name, username').maybeSingle();
  if (!form.isConnected) return;
  const status = $('#profile-status'), save = form.querySelector('button');
  if (error) { status.textContent = 'Your profile couldn’t load. Try again later.'; return; }
  form.elements.name.value = data?.display_name ?? '';
  form.elements.username.value = data?.username ?? '';
  if (data?.display_name) $('.who strong').textContent = data.display_name;
  if (data?.username) $('.who .muted').textContent = `@${data.username} · ${state.session.user.email}`;
  form.addEventListener('input', () => {
    const username = form.elements.username.value.trim().replace(/^@/, '').toLowerCase();
    if (form.elements.username.value !== username) form.elements.username.value = username;
    const valid = /^[a-z0-9_]{3,20}$/.test(username) && form.elements.name.value.trim();
    status.textContent = username && !/^[a-z0-9_]{3,20}$/.test(username) ? '3–20 letters, numbers or _' : '';
    save.disabled = !valid;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = 'Saving…';
    const username = form.elements.username.value, display_name = form.elements.name.value.trim();
    const { error: failed } = await db().from('profiles').update({ display_name, username }).eq('user_id', state.session.user.id);
    status.textContent = !failed ? 'Saved.' : /duplicate|unique/i.test(failed.message) ? `@${username} is taken. Try another.` : 'Couldn’t save. Try again.';
    if (!failed) { $('.who strong').textContent = display_name; $('.who .muted').textContent = `@${username} · ${state.session.user.email}`; }
    else save.disabled = false;
  });
}

/** Loads what the dashboard used to show. Each piece fills in when it arrives, and is dropped if the person has moved to another tab. */
async function fillAccountData(tab) {
  const current = () => state.screen === 'settings' && state.settingsTab === tab;
  const text = (id, value) => { const el = $(id); if (el && current()) el.textContent = value; };
  try {
    const totals = await loadExports();
    if (!current()) return;
    text('#stat-exports', count.format(totals.exports));
    text('#stat-shorts', count.format(totals.shorts));
    text('#stat-minutes', (totals.seconds / 60).toLocaleString(undefined, { maximumFractionDigits: 1 }));
    text('#stats-note', totals.exports === 0 ? 'Your exported Shorts will appear here.'
      : totals.exports > 50 ? 'Showing your latest 50 exports. The numbers above include your full history.' : '');
    const rows = $('#export-rows');
    if (rows) {
      const quality = { full: 'Full', compact: 'Compact', small: 'Small' };
      rows.innerHTML = totals.latest.map((row) => `<tr><td title="${esc(new Date(row.created_at).toLocaleString())}">${esc(new Date(row.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}</td>
        <td class="num">${count.format(row.short_count)}</td><td class="num">${lengthText(row.seconds)}</td><td>${esc(quality[row.quality] ?? row.quality)}</td></tr>`).join('');
    }
  } catch (error) {
    text('#stats-note', `Couldn’t load your stats. ${error?.message || 'Try again in a moment.'}`);
  }
}

// MARK: Projects and media

// Shorter videos rarely hold a whole story worth a Short, and an empty result reads as a broken app.
const MIN_VIDEO_SECONDS = 3 * 60;

async function importMedia(project, file) {
  const source = await openSource(file);
  if (source.duration < MIN_VIDEO_SECONDS) {
    throw new Error(`This video is ${clock(source.duration)} long. Relio needs at least ${MIN_VIDEO_SECONDS / 60} minutes of video to find Shorts in it.`);
  }
  const media = {
    id: uuid(), name: file.name, mime: file.type, size: file.size, lastModified: file.lastModified, duration: source.duration,
    width: source.width, height: source.height, hasAudio: source.hasAudio, contentHash: null, thumbnail: null,
    created: new Date().toISOString(),
  };
  media.thumbnail = await thumbnail(source, Math.min(1, source.duration / 2)).catch(() => null);
  await store.saveFile(media.id, file);
  project.media.push(media);
  state.sources.set(media.id, source);
  return media;
}

async function openProject(id, shortPart = null) {
  try {
    const project = await store.loadProject(id);
    if (!project) return showHome();
    const missing = [];
    for (const media of project.media) if (!(await store.hasFile(media.id))) missing.push(media);
    if (missing.length) return attachVideo(project, missing[0], shortPart);
    state.project = project;
    // An address like .../short-3 opens that Short; otherwise the first one.
    const wanted = /^short-(\d+)$/.exec(shortPart ?? '')?.[1];
    state.selectedId = (wanted && project.segments[Number(wanted) - 1] ? project.segments[Number(wanted) - 1] : project.segments[0])?.id ?? null;
    state.undo = [];
    state.timelineZoom = null;
    for (const media of project.media) await sourceFor(media).catch(() => null);
    renderEditor();
    if (state.selectedId) selectShort(state.selectedId);
  } catch (error) {
    // A click must never end in silence: whatever stopped the project from opening is shown.
    console.error('Opening the project failed:', error);
    showError('Couldn’t open this project', error?.message || 'Something went wrong. Try again, or choose the video file again.');
  }
}

/** A project made on another device has no video here yet: choose the same file again. It is checked against the fingerprint saved with the project. */
async function attachVideo(project, media, shortPart, note = '') {
  // The video is in the account's cloud: fetch it straight from the click, without leaving the screen the person is on.
  if (media.cloud?.uploaded && userId()) return fetchFromCloud(project, media, shortPart);
  await showHome(state.homeView);
  const minutes = Math.round(media.duration / 6) / 10;
  openDialog(`<div class="stack"><h2>Add the video to this device</h2>
    <p>“${esc(project.title)}” was made on another device, and its video isn’t here yet. Choose <strong>${esc(media.name)}</strong> (${minutes} min) again to open it. The video stays on this device only.</p>
    <label class="button primary attach">Choose the video<input id="attach" type="file" accept="video/*" hidden></label>
    <p id="attach-status" class="muted small" role="status">${esc(note)}</p>
    <div class="row end"><button class="button ghost" data-action="close">Cancel</button></div></div>`);
  $('#attach').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const status = $('#attach-status');
    status.textContent = 'Checking the video…';
    try {
      const source = await openSource(file);
      if (!(await sameVideo(media, file))) {
        status.textContent = 'That isn’t the same video this project was made from. Choose the original file.';
        event.target.value = '';
        return;
      }
      await store.saveFile(media.id, file);
      state.sources.set(media.id, source);
      closeDialog();
      openProject(project.id, shortPart);
    } catch (error) {
      status.textContent = 'That file can’t be read as a video. Choose the original file.';
    }
  });
}

let downloadAbort = null, lastDownload = null;
/** The project's video is in the account's cloud storage: download it once, then it is kept on this device and the project opens by itself. */
async function fetchFromCloud(project, media, shortPart) {
  const controller = new AbortController();
  downloadAbort = controller;
  lastDownload = { project, media, shortPart };
  openDialog(`<div class="stack"><h2>Opening “${esc(project.title)}”</h2>
    <p>Downloading <strong>${esc(media.name)}</strong> (${bytes(media.size)}) from your account. It opens as soon as it is here, and stays on this device afterwards.</p>
    <div class="bar"><div id="dl-bar" style="width:0%"></div></div><p id="dl-text" class="muted small" role="status" aria-live="polite">Starting…</p>
    <div class="row end"><button class="button ghost" data-action="close">Cancel</button></div></div>`);
  try {
    const blob = await downloadVideo({
      token: accessToken, mediaId: media.cloud.key ?? media.id, type: media.mime || 'video/mp4', size: media.size, signal: controller.signal,
      onProgress: (fraction, rate) => {
        const bar = $('#dl-bar');
        if (!bar) return;
        bar.style.width = `${Math.round(fraction * 100)}%`;
        const speed = rate?.bytesPerSecond ? ` · ${bytes(rate.bytesPerSecond)}/s` : '';
        const left = rate?.remainingSeconds && Number.isFinite(rate.remainingSeconds) ? ` · about ${Math.max(1, Math.round(rate.remainingSeconds))} s left` : '';
        $('#dl-text').textContent = `${Math.round(fraction * 100)}% of ${bytes(media.size)}${speed}${left}`;
      },
    });
    const file = new File([blob], media.name, { type: blob.type, lastModified: media.lastModified });
    const source = await openSource(file);
    await store.saveFile(media.id, file);
    state.sources.set(media.id, source);
    downloadAbort = null;
    closeDialog();
    openProject(project.id, shortPart);
  } catch (error) {
    if (controller.signal.aborted) return;
    downloadAbort = null;
    // Usually a dropped connection: offer another try first, and the file on this device as the fallback.
    openDialog(`<div class="stack"><h2>The video didn’t download</h2>
      <p>${esc(error.message || 'The connection stopped.')} Check your connection and try again.</p>
      <div class="row end"><button class="button ghost" data-action="choose-instead">Choose the file instead</button>
        <button class="button primary" data-action="retry-download">Try again</button></div></div>`);
  }
}

// MARK: Videos in the cloud (upload after sync, removal, and the sidebar progress)

// uploadProblem: why the last upload stopped, shown in Settings › Usage so a stalled upload isn't invisible.
let uploading = false, videoBlock = null, uploadProblem = null;
function showUpload(text, fraction = 0) {
  const box = $('#upload-status');
  if (!box) return;
  box.hidden = text === null;
  if (text !== null) { $('#upload-text').textContent = `${text} · ${Math.round(fraction * 100)}%`; $('#upload-bar').style.width = `${Math.round(fraction * 100)}%`; }
}

/** Sends each video that is on this device and has never been sent, one at a time. A video is stored once under its fingerprint, so a
 * second project with the same file just links to it. A video that was too big, that the person chose not to make room for, or that
 * was later removed to make room stays on its devices and is not sent again. */
async function uploadPending() {
  if (uploading || videoBlock || !userId()) return;
  uploading = true;
  try {
    await shareDuplicates();
    for (const project of (await store.listProjects()).filter(isMine)) {
      for (const media of project.media) {
        if (media.cloud) continue;
        const file = await store.loadFile(media.id);
        if (!file) continue;
        if (!media.contentHash) await ensureHashes(project);
        const key = media.contentHash ?? media.id;
        const twin = (await store.listProjects()).filter(isMine).flatMap((p) => p.media)
          .find((m) => m.id !== media.id && m.contentHash && m.contentHash === media.contentHash && m.cloud?.uploaded);
        if (twin) { await setCloud(project.id, media.id, { uploaded: true, bytes: file.size, key: twin.cloud.key ?? twin.id }); continue; }
        const label = `Uploading “${media.name}”`;
        showUpload(label, 0);
        try {
          const { evicted } = await uploadVideo({
            token: accessToken, media: { ...media, id: key }, file, onProgress: (fraction) => showUpload(label, fraction),
            askRoom: (evict, cap) => askRoom(media, file, evict, cap),
          });
          await markRemoved(evicted);
          await setCloud(project.id, media.id, { uploaded: true, bytes: file.size, key });
          uploadProblem = null;
        } catch (error) {
          if (!(error instanceof CloudVideoError)) throw error;
          await markRemoved(error.evicted);
          if (error.kind === 'too_big') await setCloud(project.id, media.id, { tooBig: true });
          else if (error.kind === 'declined') await setCloud(project.id, media.id, { declined: true });
          else throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof CloudVideoError && error.kind === 'unavailable') videoBlock = error;
    else { console.warn('Video upload paused:', error); uploadProblem = error?.message || String(error); setTimeout(uploadPending, 60_000); }
  } finally {
    uploading = false;
    showUpload(null);
    if ($('#cloud-video-text')) fillCloudVideo();
  }
}

/** Earlier uploads stored each project's copy separately: projects with the same video now share one stored copy, and the extra
 * copies are removed from the cloud. */
async function shareDuplicates() {
  const byHash = new Map();
  for (const project of (await store.listProjects()).filter(isMine)) {
    for (const media of project.media) {
      if (!media.cloud?.uploaded || !media.contentHash) continue;
      if (!byHash.has(media.contentHash)) byHash.set(media.contentHash, []);
      byHash.get(media.contentHash).push({ project, media });
    }
  }
  let extra = false;
  for (const uses of byHash.values()) {
    const keys = [...new Set(uses.map(({ media }) => media.cloud.key ?? media.id))];
    if (keys.length < 2) continue;
    for (const { project, media } of uses) if ((media.cloud.key ?? media.id) !== keys[0]) await setCloud(project.id, media.id, { ...media.cloud, key: keys[0] });
    for (const key of keys.slice(1)) store.rememberDeletion('videos', `${userId()}/${key}`);
    extra = true;
  }
  if (extra) await removePendingVideos();
}

/** Records what happened to a project's video in the cloud; sync tells the other devices. */
async function setCloud(projectId, mediaId, cloud) {
  const project = await store.loadProject(projectId);
  const entry = project?.media.find((m) => m.id === mediaId);
  if (!entry) return;
  // `at` lets two devices that recorded different outcomes agree on the newest one.
  entry.cloud = { ...cloud, at: new Date().toISOString() };
  await store.saveProject(project, { touch: false });
}

/** Videos removed to make room: their projects remember it, so no device waits for them or sends them again. */
async function markRemoved(keys = []) {
  if (!keys.length) return;
  for (const project of (await store.listProjects()).filter(isMine)) {
    for (const media of project.media) if (media.cloud?.uploaded && keys.includes(media.cloud.key ?? media.id)) await setCloud(project.id, media.id, { removed: true });
  }
}

/** The warning before old videos are deleted from the cloud. Resolves true (delete them), false (keep them) or null (ask later). */
let dialogAnswer = null;
async function askRoom(media, file, evict, cap) {
  if (state.dialog || state.task) return null;
  const names = new Map();
  // Stored copies are named by fingerprint; every project that uses one is listed.
  for (const project of (await store.listProjects()).filter(isMine)) {
    for (const m of project.media) {
      if (!m.cloud?.uploaded) continue;
      const key = m.cloud.key ?? m.id;
      names.set(key, names.has(key) ? `${names.get(key)}, ${project.title}` : `${project.title} · ${m.name}`);
    }
  }
  return new Promise((resolve) => {
    openDialog(`<div class="stack"><h2>Not enough cloud space</h2>
      <p>Your cloud space is ${bytes(cap)}. To keep <strong>${esc(media.name)}</strong> (${bytes(file.size)}) in the cloud, Relio has to delete your oldest videos from it:</p>
      <ul class="evict-list">${evict.map((v) => `<li><span>${esc(names.get(v.mediaId) ?? 'An older video')}</span><span class="muted small">${bytes(v.bytes)}</span></li>`).join('')}</ul>
      <p class="muted small">Only the cloud copies are deleted. Projects stay, and devices that already have these videos keep them; other devices will need the file again.</p>
      <div class="row end"><button class="button ghost" id="room-keep">Keep them</button><button class="button primary" id="room-delete">Delete them and upload</button></div></div>`);
    dialogAnswer = resolve;
    const answer = (value) => { dialogAnswer = null; closeDialog(); resolve(value); };
    $('#room-keep').addEventListener('click', () => answer(false));
    $('#room-delete').addEventListener('click', () => answer(true));
  });
}

async function removePendingVideos() {
  const mine = [...store.pendingDeletes('videos')].filter((entry) => entry.startsWith(`${userId()}/`));
  if (!mine.length) return;
  // A stored video that another project still uses stays.
  const inUse = new Set((await store.listProjects()).filter(isMine).flatMap((p) => p.media).filter((m) => m.cloud?.uploaded).map((m) => m.cloud.key ?? m.id));
  const gone = mine.filter((entry) => !inUse.has(entry.split('/').pop()));
  try {
    if (gone.length) await removeVideos({ token: accessToken, mediaIds: gone.map((entry) => entry.split('/').pop()) });
    store.deletionReached('videos', mine);
  } catch (error) {
    if (error instanceof CloudVideoError && error.kind === 'unavailable') return;
    console.warn('Cloud video removal will retry:', error);
  }
}

/** Settings > Usage: how much cloud video space is used, or why uploads are stopped. */
async function fillCloudVideo() {
  const text = $('#cloud-video-text');
  if (!text) return;
  $('#retry-upload').hidden = !videoBlock;
  if (videoBlock) { text.textContent = videoBlock.message; return; }
  try {
    const { used, cap } = await cloudUsage({ token: accessToken });
    if (!$('#cloud-video-text')) return;
    // Videos that stay on this device only, and why, so a missing upload is never a mystery.
    const media = (await store.listProjects()).filter(isMine).flatMap((p) => p.media);
    const local = media.filter((m) => !m.cloud?.uploaded);
    const why = (m) => m.cloud?.tooBig ? 'bigger than your cloud space' : m.cloud?.declined ? 'you kept older videos instead' : uploading ? 'uploading now' : 'waiting to upload';
    const notes = local.map((m) => `“${m.name}” stays on this device: ${why(m)}.`);
    if (uploadProblem) notes.unshift(`Upload paused: ${uploadProblem} Relio tries again every minute.`);
    text.textContent = `${bytes(used)} of ${bytes(cap)} used${notes.length ? ` · ${notes.join(' ')}` : ''}`;
    $('#cloud-video-bar').style.width = `${Math.min(100, cap ? used / cap * 100 : 0)}%`;
  } catch (error) {
    if ($('#cloud-video-text')) text.textContent = error.message;
  }
}

/** The same file by its fingerprint; files too big to fingerprint (or never fingerprinted) are matched by size. */
async function sameVideo(media, file) {
  if (media.contentHash && file.size <= 1.5e9) return hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())) === media.contentHash;
  return file.size === media.size;
}

/** Gives every video of a project the fingerprint another device will check a re-added file against. */
async function ensureHashes(project) {
  for (const media of project.media) {
    if (media.contentHash || media.size > 1.5e9) continue;
    const file = await store.loadFile(media.id);
    if (!file) continue;
    media.contentHash = hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    await store.patch('projects', project.id, (record) => { const m = record.media.find((x) => x.id === media.id); if (m) m.contentHash = media.contentHash; });
  }
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

/** The video's name on Relio's server: its SHA-256 (the same value as on the Mac), else a hash of its name and length. */
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
/** The allowance fields every Relio AI request carries, for a video that isn't starting a run. */
async function usageFor(media, source) {
  return { video: await serverKey(media), minutes: source.duration / 60, day: localDay() };
}
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

// MARK: Making Shorts

async function makeShorts(media, options) {
  if (state.task) return;
  if (options.region === 'custom' && !(options.customEnd > options.customStart && options.customEnd <= media.duration + 0.5)) {
    return showError('Choose a range inside the video', 'The end of the range must come after its start and fall inside the video.');
  }
  if (!state.session) return renderGate();
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
    return showError('Relio couldn’t check your usage right now', 'Try again in a moment.', 'temporary');
  }
  endTask(task);
  if (check.runs === 0) return runShorts(media, options, key, minutes);
  await refreshUsage();
  const left = Math.max(0, (state.usage?.allowance ?? 0) - (state.usage?.used ?? 0));
  if (check.charge > left) {
    track('limit_reached');
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
    track('reanalysis_started', { length: lengthBucket(usage.minutes) });
    runShorts(media, options, usage.key, usage.minutes);
  });
}

// A Retry reuses the run id, so the server doesn't count it as a new analysis of the video.
async function runShorts(media, options, key, minutes, run = uuid()) {
  if (state.task) return;
  const source = await sourceFor(media);
  const project = state.project;
  const projectId = project.id;
  const task = beginTask('Preparing video analysis…');
  const usedRanges = project.segments.filter((s) => s.mediaId === media.id).map((s) => ({ start: s.start, end: s.start + s.duration }));
  const saved = project.transcripts?.[media.id] ?? null;
  const configuration = {
    accessToken,
    usage: { video: key, minutes, day: localDay(), run },
    onRetry: (message) => setTask(message),
  };
  let missed = 0;
  const retry = (count) => runShorts(media, { ...options, count }, key, minutes, run);
  try {
    // The server refuses an over-limit run too; checking first spares a request that can't succeed.
    const { data: allowed } = await db().rpc('usage_allowed', { p_video: key, p_day: localDay(), p_minutes: minutes });
    if (allowed === false) {
      await refreshUsage();
      const u = state.usage;
      const left = u ? Math.max(0, u.allowance - u.used) : null;
      throw new GeminiError('usageLimit', 429, left === null ? null
        : `This video is ${Math.ceil(minutes)} min long, but you have ${Math.floor(left)} of your ${Math.floor(u.allowance)} beta minutes left. A video you already used doesn't count again. Ask for a promo code to get more, then enter it in Settings › Usage.`);
    }
    track('analysis_started', { length: lengthBucket(minutes) });
    const results = await Shorts.analyze(source, configuration, {
      duration: options.duration, count: options.count, region: options.region, customStart: options.region === 'custom' ? options.customStart : null,
      customEnd: options.region === 'custom' ? options.customEnd : null, excluding: usedRanges, videoType: options.videoType, language: options.language, cachedTranscript: saved,
      signal: task.controller.signal,
      onTranscript: (transcript) => { project.transcripts ??= {}; project.transcripts[media.id] = transcript; },
      onMissed: (n) => { missed = n; },
      progress: (fraction, stage) => setTask(stage, fraction),
    });
    // Every Short flagged as music: sung lyrics, not speech, so there's nothing to caption.
    if (results.length > 0 && results.every((r) => r.warning === Shorts.MUSIC_NOTICE)) throw new GeminiError('musicVideo');
    const podcast = (r) => r.videoType === 'podcast';
    const created = [];
    for (const r of results) {
      const segment = {
        id: uuid(), mediaId: media.id, start: r.start, duration: r.duration, caption: '', isMuted: false, captionStart: 0, captionDuration: null,
        fitToFrame: r.fit, captions: r.captions, cropZoom: r.fit ? 1 : 1.08, cropPosition: 0.5, cropKeyframes: r.cropKeyframes,
        cropTrackingVersion: Framing.VERSION, speechWords: r.speechWords, score: r.score, suggestedTitle: r.title, selectionReason: r.reason,
        suggestedDescription: r.description, captionNotice: r.warning, videoType: r.videoType,
        captionStyle: options.captionStyle === 'none' ? 'auto' : options.captionStyle,
        // Captions whose timing couldn't be checked (often sung or music-heavy audio) stay hidden until the person turns them on.
        captionsHidden: options.captionStyle === 'none' || r.warning === Shorts.MUSIC_NOTICE,
        // A whole-frame Short (a vertical source, a screen) is never split into two halves.
        splitScreen: podcast(r) && !r.fit, captionPosition: podcast(r) && !r.fit ? 'middle' : 'bottom', captionSize: 'medium', captionAnimated: true,
      };
      if (segment.splitScreen) {
        setTask(`Relio AI · finding both speakers · Short ${created.length + 1} of ${results.length}`);
        segment.splitCenters = await Framing.findSplitCenters(source, r.start, r.duration, configuration, task.controller.signal).catch(() => null) ?? undefined;
      }
      created.push(segment);
    }
    if (state.project?.id !== projectId) return;
    project.segments.push(...created);
    await persist();
    track('analysis_finished', { length: lengthBucket(minutes) });
    track('clips_generated', { clips: created.length });
    endTask(task);
    state.selectedId = created[0].id;
    renderEditor();
    selectShort(state.selectedId);
    // The finished Shorts are saved above; the ones Relio AI couldn't make are offered again instead of silently lost.
    if (missed > 0) {
      showError(`${missed} ${missed === 1 ? 'Short' : 'Shorts'} couldn’t be made`,
        `Relio AI couldn’t finish part of the video. Your ${plural(created.length, 'new Short')} ${created.length === 1 ? 'is' : 'are'} saved. Retry to make the rest.`,
        '', () => retry(missed));
    }
    await refreshUsage();
  } catch (error) {
    if (task.controller.signal.aborted) return endTask(task);
    endTask(task);
    reportGenerationError(error, () => retry(options.count));
  }
}

function localDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function reportGenerationError(error, retry) {
  const cause = error instanceof StageFailure ? error.underlying : error;
  if (cause instanceof GeminiError) {
    if (cause.failure === 'noStrongClips' || cause.failure === 'noDistinctClips') return showError('No Shorts found', cause.message);
    if (cause.failure === 'musicVideo') return showError('This is a music video', cause.message);
    if (cause.failure === 'signIn' || cause.status === 401 || cause.status === 403) return showError('Check your sign-in', cause.message);
    if (cause.failure === 'usageLimit') { track('limit_reached'); return showError('You’ve reached your beta limit', cause.message, 'limit'); }
    if (cause.failure === 'request' && [429, 500, 502, 503, 504, 546].includes(cause.status)) return showError('Relio AI is unavailable right now', cause.message, 'temporary', retry);
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
  // Export updates this every frame; rebuilding the card each time would swallow clicks on Cancel.
  if (!host.querySelector('.progress-card')) {
    host.innerHTML = `<div class="card progress-card" role="status">
      <strong></strong>
      <div class="bar"><div></div></div>
      <button class="button ghost" data-action="cancel">Cancel</button>
    </div>`;
  }
  host.querySelector('strong').textContent = task.stage;
  host.querySelector('.bar > div').style.width = `${Math.round((task.progress ?? 0) * 100)}%`;
}

function openDialog(html) {
  state.dialog = html;
  const host = $('#dialog');
  host.hidden = false;
  host.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  host.querySelector('input,select,button')?.focus();
}
function closeDialog() {
  // A question closed without an answer (Esc, the backdrop) is asked again later.
  const pending = dialogAnswer;
  dialogAnswer = null;
  pending?.(null);
  downloadAbort?.abort();
  downloadAbort = null;
  state.dialog = null;
  $('#dialog').hidden = true;
  $('#dialog').innerHTML = '';
}
function showError(title, message, kind = '', retry = null) {
  openDialog(`<div class="stack"><h2>${esc(title)}</h2><p>${esc(message)}</p>
    <div class="row end">${kind === 'limit' ? '<button class="button ghost" data-action="usage">Usage</button>' : ''}${retry
      ? '<button class="button ghost" data-action="close">Not now</button><button class="button primary" id="dialog-retry">Retry</button>'
      : '<button class="button primary" data-action="close">OK</button>'}</div></div>`);
  $('#dialog-retry')?.addEventListener('click', () => { closeDialog(); retry(); });
}

// MARK: Editor

const mmss = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const sortedByScore = () => { try { return localStorage.getItem('prism-sort') === 'score'; } catch { return false; } };
function toggleSort() {
  const on = !sortedByScore();
  try { localStorage.setItem('prism-sort', on ? 'score' : 'clips'); } catch { /* the choice just isn't remembered */ }
  renderBin();
}

function renderEditor() {
  const project = state.project;
  setScreen('editor');
  const shortNumber = project.segments.findIndex((s) => s.id === state.selectedId) + 1;
  // Choosing another Short in the same project rewrites the address instead of adding a history entry.
  setUrl(projectPath(project) + (shortNumber ? `/short-${shortNumber}` : ''), location.pathname.startsWith(projectPath(project)));
  $('#export-button').disabled = project.segments.length === 0;
  $('#app').innerHTML = `
    <section class="editor">
      <div class="panes">
        <aside class="bin" id="bin"></aside>
        <main class="stage" id="stage"></main>
        <aside class="inspector" id="inspector"></aside>
      </div>
    </section>`;
  renderBin();
  renderTask();
  renderInspector();
}

/** The Shorts as cards, as in the desktop app: first frame, score, length, title and where in the video it starts. The star lists them
 * best score first instead of in the order of the video. */
function renderBin() {
  const project = state.project, bin = $('#bin');
  if (!project || !bin) return;
  const byScore = sortedByScore();
  const media = project.media[0];
  const cards = Shorts.orderedShorts(project.segments, byScore).map((s) => {
    const number = project.segments.indexOf(s) + 1;
    const title = s.suggestedTitle || `${project.title} Short ${number}`;
    return `<div class="short-card ${s.id === state.selectedId ? 'on' : ''}">
        <button class="card-main" data-action="select" data-id="${s.id}">
          <span class="card-thumb"><img alt="" data-thumb="${s.id}">${s.score ? `<span class="badge-score">✦ ${s.score}</span>` : ''}
            <span class="card-meta"><span>▶ Short ${number}</span><span>${mmss(s.duration)}</span></span></span>
          <span class="card-title">${esc(title)}</span>
          <span class="card-sub">Starts at ${mmss(s.start)}</span>
        </button>
        <button class="card-remove" data-action="remove" data-id="${s.id}" aria-label="Remove Short ${number}" title="Remove">✕</button>
      </div>`;
  }).join('');
  bin.innerHTML = `
    <div class="shorts-head">
      <h3>Shorts <span class="count">${project.segments.length}</span></h3><span class="spacer"></span>
      <button class="star" data-action="sort" aria-pressed="${byScore}" title="${byScore ? 'Best score first. Click for the order of the video' : 'In the order of the video. Click for best score first'}" aria-label="Sort by score">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8Z"/></svg></button>
      ${media ? `<button class="create-more" data-action="make" data-id="${media.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2 5.5L19.5 10 14 12l-2 5.5L10 12l-5.5-2L10 8.5ZM19 16v4m-2-2h4"/></svg>Create more</button>` : ''}
    </div>
    <p class="source-line">${project.segments.length} ${project.segments.length === 1 ? 'Short' : 'Shorts'} from ${project.media.length === 1 ? esc(media.name) : `${project.media.length} videos`}</p>
    ${cards ? `<div class="short-grid">${cards}</div>` : '<p class="muted small">No Shorts yet. Use Create more to make some.</p>'}`;
  fillThumbs();
}

/** A Short's picture is its first frame, drawn exactly as the preview draws it: the same layoutAt and drawFrame, so crop, Fit and
 * split screen look the same on the card and in the player. The cache key holds the layout itself, so changing it redraws the card.
 * Cards load theirs only when they scroll into view, and keep it. */
const shortThumbs = new Map();
async function shortThumb(segment) {
  const source = await sourceFor(state.project.media.find((m) => m.id === segment.mediaId));
  const bars = await letterbox(source, segment.start, segment.duration);
  const layout = layoutAt(segment, 0, source.width, source.height, bars).map((op) => [op.kind, ...[op.sx, op.sy, op.sw, op.sh, op.dx, op.dy, op.dw, op.dh].map(Math.round)]);
  const key = `${segment.mediaId}|${segment.start}|${JSON.stringify(layout)}`;
  if (shortThumbs.has(key)) return shortThumbs.get(key);
  const image = await frameImage(source, segment.start + 0.05);
  if (!image) return null;
  const canvas = new OffscreenCanvas(180, 320);
  const context = canvas.getContext('2d');
  context.scale(180 / 1080, 320 / 1920);
  drawFrame(context, { draw: (ctx, x, y, w, h) => ctx.drawImage(image, x, y, w, h) }, segment, source.width, source.height, 0, bars);
  const url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }));
  shortThumbs.set(key, url);
  while (shortThumbs.size > 300) {
    const oldest = shortThumbs.keys().next().value;
    URL.revokeObjectURL(shortThumbs.get(oldest));
    shortThumbs.delete(oldest);
  }
  return url;
}

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    thumbObserver.unobserve(img);
    const segment = state.project?.segments.find((s) => s.id === img.dataset.thumb);
    if (segment) shortThumb(segment).then((url) => { if (url && img.isConnected) img.src = url; }).catch((error) => console.warn('Short thumbnail failed:', error));
  }
}, { rootMargin: '300px' });
function fillThumbs() {
  for (const img of document.querySelectorAll('img[data-thumb]')) thumbObserver.observe(img);
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
  unmountPlayer();
  try {
    const source = await sourceFor(media);
    if (token !== state.previewToken) return;
    setStage(`<div id="player-host"></div><p id="track-note" class="muted small"></p>${timelineHtml(segment)}`);
    wireTimeline(segment);
    renderInspector();
    // Plays straight from the source file. When this browser can't play it, fall back to a rendered preview.
    mountPlayer($('#player-host'), segment, source, () => renderedPreview(segment, source, token));
    // Framing is found while it plays; the player reads the Short's framing every frame, so it appears as soon as it is ready.
    if (segment.cropTrackingVersion !== Framing.VERSION || !segment.cropKeyframes) {
      const note = $('#track-note');
      note.textContent = 'Finding the subject…';
      retrack(segment, source).catch(() => {}).finally(() => { if (token === state.previewToken && note) note.textContent = ''; });
    }
  } catch (error) {
    if (token !== state.previewToken) return;
    setStage(`<p class="error">${esc(error.message || 'The Short could not be shown.')}</p>`);
  }
}

async function renderedPreview(segment, source, token) {
  if (token !== state.previewToken) return;
  unmountPlayer();
  setStage('<p class="muted">This browser can’t play the source video directly. Rendering a preview…</p>');
  try {
    const url = await preview(source, segment);
    if (token !== state.previewToken) return;
    setStage(`<video id="player" class="player" controls playsinline src="${url}"></video>${timelineHtml(segment)}`);
    wireTimeline(segment);
  } catch (error) {
    if (token === state.previewToken) setStage(`<p class="error">${esc(error.message || 'The preview could not be rendered.')}</p>`);
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
  const styleOptions = CAPTION_STYLES.map((s) => `<option value="${s}" ${s === (segment.captionStyle ?? 'classic') ? 'selected' : ''}>${STYLE_TITLES[s]}</option>`).join('');
  const choice = (field, values, fallback) => values.map((v) => `<option value="${v}" ${v === (segment[field] ?? fallback) ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('');
  host.innerHTML = `
    <div class="insp">
      <label>Title <input data-field="suggestedTitle" value="${esc(segment.suggestedTitle ?? '')}"></label>
      ${segment.captionNotice ? `<p class="notice small">${esc(segment.captionNotice)}</p>` : ''}
      <section class="insp-section">
        <h3>Captions</h3>
        <label class="check"><input type="checkbox" data-field="captionsHidden" ${segment.captionsHidden ? '' : 'checked'}> Show captions</label>
        <canvas class="style-preview wide" id="inspector-style" aria-label="Caption style preview"></canvas>
        <label>Style <select data-field="captionStyle">${styleOptions}</select></label>
        <div class="insp-pair">
          <label>Position <select data-field="captionPosition">${choice('captionPosition', ['top', 'middle', 'bottom'], 'bottom')}</select></label>
          <label>Size <select data-field="captionSize">${choice('captionSize', ['small', 'medium', 'large'], 'medium')}</select></label>
        </div>
        <label class="check"><input type="checkbox" data-field="captionAnimated" ${segment.captionAnimated ? 'checked' : ''}> Pop in new captions</label>
        <label>Words <textarea data-field="captionTexts" rows="4">${esc((segment.captions ?? []).map((c) => c.text).join('\n'))}</textarea></label>
        <button class="link-button" data-action="regen-captions">Regenerate subtitles</button>
      </section>
      <details class="insp-section">
        <summary><h3>Picture and sound</h3></summary>
        <div class="stack">
        <label class="check"><input type="checkbox" data-field="splitScreen" ${segment.splitScreen ? 'checked' : ''}> Split screen (two speakers)</label>
        <label class="check"><input type="checkbox" data-field="fitToFrame" ${segment.fitToFrame ? 'checked' : ''}> Show the whole frame</label>
        <label class="check"><input type="checkbox" data-field="isMuted" ${segment.isMuted ? 'checked' : ''}> Mute audio</label>
        <label>On-screen text <input data-field="caption" value="${esc(segment.caption ?? '')}"></label>
        <button class="link-button" data-action="retrack">Re-track the subject</button>
        </div>
      </details>
      <div class="insp-actions">
        <button class="button primary" data-action="export-one">Export this Short</button>
        <button class="link-button danger" data-action="remove">Remove Short</button>
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
  // The track spans the whole video but is zoomed to the Short by default: about three times its length, at least a minute.
  // Over a whole long video a 30 s Short was a few pixels wide, a dot. The slider zooms out to the whole video.
  const maxZoom = Math.max(1, total / Math.min(total, Math.max(60, segment.duration * 3)));
  const zoom = clamp(state.timelineZoom ?? maxZoom, 1, maxZoom);
  return `<div class="timeline" data-total="${total}">
      <div class="tl-scroll" id="tl-scroll"><div class="tl-track" id="tl-track" style="width:${(zoom * 100).toFixed(2)}%">${others}
        <div class="tl-clip" id="tl-clip" style="left:${pct(segment.start)};width:${pct(segment.duration)}"><span class="tl-handle l" data-edge="l"></span><span class="tl-handle r" data-edge="r"></span></div>
      </div></div>
      <div class="row between muted small mono"><span>0:00</span><span id="tl-label">${clock(segment.start)}–${clock(segment.start + segment.duration)}</span><span>${clock(total)}</span></div>
      ${maxZoom > 1.01 ? `<label class="tl-zoom muted small">Whole video <input id="tl-zoom" type="range" min="1" max="${maxZoom.toFixed(3)}" step="any" value="${zoom.toFixed(3)}" aria-label="Timeline zoom"> Around the Short</label>` : ''}
      <p class="muted small">Drag the block to move the Short, or its ends to trim it.</p>
    </div>`;
}

function wireTimeline(segment) {
  const track = $('#tl-track'), clip = $('#tl-clip');
  if (!track || !clip) return;
  const total = Number($('.timeline').dataset.total);
  const scroller = $('#tl-scroll');
  // Keeps the Short in the middle of what is visible.
  const centre = () => { scroller.scrollLeft = (segment.start + segment.duration / 2) / total * track.scrollWidth - scroller.clientWidth / 2; };
  centre();
  $('#tl-zoom')?.addEventListener('input', (event) => {
    state.timelineZoom = Number(event.target.value);
    track.style.width = `${state.timelineZoom * 100}%`;
    centre();
  });
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

async function removeShort(id) {
  const index = state.project.segments.findIndex((s) => s.id === id);
  if (index < 0 || !confirm('Remove this Short? You can undo this with Ctrl+Z.')) return;
  state.undo.push({ id, before: JSON.stringify(state.project.segments[index]) });
  state.project.segments.splice(index, 1);
  await persist();
  if (state.selectedId !== id) return renderBin();
  state.selectedId = Shorts.orderedShorts(state.project.segments, sortedByScore())[0]?.id ?? null;
  renderEditor();
  if (state.selectedId) selectShort(state.selectedId);
  else setStage('<p class="muted">Make Shorts from a video to start.</p>');
}

async function undo() {
  const last = state.undo.pop();
  if (!last) return;
  const index = state.project.segments.findIndex((s) => s.id === last.id);
  // An edit goes back to how it was; a removed Short comes back.
  if (index >= 0) state.project.segments[index] = JSON.parse(last.before);
  else { state.project.segments.push(JSON.parse(last.before)); state.selectedId = last.id; }
  await persist();
  renderEditor();
  selectShort(state.selectedId);
}

// MARK: Export

function openExportDialog(onlyId = null) {
  const list = state.project.segments.map((s, i) => `
    <label class="check"><input type="checkbox" name="pick" value="${s.id}" ${!onlyId || s.id === onlyId ? 'checked' : ''}>
      ${esc(s.suggestedTitle || `Short ${i + 1}`)} <span class="muted small">${clock(s.duration)}</span></label>`).join('');
  // shortcut: Safari reports HEVC encoding as hardware but runs it at ~4 frames/s (2.5 min per 20 s Short), so it isn't offered there; drop when Safari's HEVC gets fast.
  const safari = /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg|CriOS|FxiOS/.test(navigator.userAgent);
  const qualities = Object.entries(EXPORT_QUALITIES).filter(([k]) => !(safari && k === 'compact')).map(([k, q]) => `<option value="${k}">${q.title} — ${q.detail}</option>`).join('');
  openDialog(`
    <form id="export-form" class="stack">
      <h2>Export Shorts</h2>
      ${list}
      <label>Quality <select name="quality">${qualities}</select></label>
      <p class="muted small">Each Short downloads as an MP4.</p>
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
    const quality = form.elements.quality.value;
    closeDialog();
    exportShorts(ids, quality, folder);
  });
}

const STALL_MS = 45_000;

async function exportShorts(ids, quality, folder = null) {
  // The project is held from the start: the person may go Home while it exports, which clears the open project.
  const project = state.project;
  const task = beginTask('Exporting…');
  const settings = exportSettings(quality);
  const seconds = [];
  let made = 0;
  try {
    for (const [index, id] of ids.entries()) {
      const segment = project.segments.find((s) => s.id === id);
      const media = project.media.find((m) => m.id === segment.mediaId);
      const source = await sourceFor(media);
      const label = segment.suggestedTitle?.trim() || `${project.title} Short ${project.segments.indexOf(segment) + 1}`;
      setTask(`Exporting ${index + 1} of ${ids.length} · ${label}`, index / ids.length);
      // A browser whose encoder or decoder stops answering would leave the export waiting forever; name the step instead.
      let lastStep = 'opening the video', lastActive = Date.now(), watchdog;
      const active = () => { lastActive = Date.now(); };
      const stalled = new Promise((_, reject) => {
        watchdog = setInterval(() => {
          if (Date.now() - lastActive < STALL_MS) return;
          task.controller.abort();
          reject(new Error(`The export stopped while ${lastStep} and made no progress for ${STALL_MS / 1000} seconds. Try 720p · H.264, or another browser.`));
        }, 1000);
      });
      const blob = await Promise.race([stalled, render(source, segment, {
        ...settings, quality, signal: task.controller.signal,
        metadata: { title: segment.suggestedTitle?.trim() ?? '', description: segment.suggestedDescription?.trim() ?? '' },
        step: (name) => { lastStep = name; active(); },
        progress: (fraction) => { lastStep = 'rendering the video'; active(); setTask(`Exporting ${index + 1} of ${ids.length} · ${label}`, (index + fraction) / ids.length); },
      })]).finally(() => clearInterval(watchdog));
      const base = await uniqueName(folder, safeName(label));
      await saveFile(folder, blob, `${base}.mp4`);
      track('clip_exported', { quality });
      seconds.push(segment.duration);
      made++;
    }
  } catch (error) {
    endTask(task);
    if (task.cancelled) return;
    return showError('Couldn’t export', error.message);
  }
  endTask(task);
  openDialog(`<div class="stack"><h2>Exported</h2>
    <p>${made} ${made === 1 ? 'Short' : 'Shorts'} ${folder ? `saved to the folder “${esc(folder.name)}”` : 'downloaded to your Downloads folder'}.</p>
    <div class="row end"><button class="button primary" data-action="close">OK</button></div></div>`);
  if (made > 0) {
    // Saved by ID, not through the open project, so an export that ends after the person went Home still restarts the 7 days.
    const saved = await store.loadProject(project.id);
    if (saved) {
      saved.exported = (saved.exported ?? 0) + made;
      await store.saveProject(saved);
      if (state.project?.id === project.id) state.project.exported = saved.exported;
    }
    recordExport(made, seconds.reduce((a, b) => a + b, 0), quality);
  }
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

// MARK: Events

document.addEventListener('click', async (event) => {
  const choice = event.target.closest('[data-create],[data-style],[data-type]');
  if (choice && state.create) {
    if (choice.dataset.create) await createAction(choice.dataset.create);
    else { if (choice.dataset.style) state.create.style = choice.dataset.style; else state.create.videoType = choice.dataset.type; renderCreate(); }
    return;
  }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'close') closeDialog();
  else if (action === 'cancel') cancelTask();
  else if (action === 'home') showHome();
  else if (action === 'open') openProject(target.dataset.id);
  else if (action === 'retry-download' && lastDownload) fetchFromCloud(lastDownload.project, lastDownload.media, lastDownload.shortPart);
  else if (action === 'choose-instead' && lastDownload) attachVideo(lastDownload.project, { ...lastDownload.media, cloud: null }, lastDownload.shortPart);
  else if (action === 'project-menu') projectMenu(target.dataset.id, target);
  else if (action === 'folder-menu') folderMenu(target.dataset.id, target);
  else if (action === 'open-folder') showHome({ folderId: target.dataset.id });
  else if (action === 'new-folder') newFolder();
  else if (action === 'select') selectShort(target.dataset.id);
  else if (action === 'make') startCreate({ project: state.project, media: state.project.media.find((m) => m.id === target.dataset.id) });
  else if (action === 'create') startCreate();
  else if (action === 'nav') {
    const screen = target.dataset.screen;
    if (screen === 'home') showHome();
    else if (screen === 'create') startCreate();
    else if (screen === 'settings') showSettings();
  }
  else if (action === 'settings-tab') showSettings(target.dataset.tab);
  else if (action === 'signout') { await db().auth.signOut(); state.session = null; renderGate(); }
  else if (action === 'delete-account') deleteAccount();
  else if (action === 'theme') switchTheme(target.dataset.theme);
  else if (action === 'export-dialog') openExportDialog();
  else if (action === 'export-one') openExportDialog(state.selectedId);
  else if (action === 'sync-now') sync();
  else if (action === 'retry-upload') { videoBlock = null; uploadPending(); showSettings('usage'); }
  else if (action === 'collapse') applyCollapsed(!$('.shell').classList.contains('collapsed'));
  else if (action === 'usage') { closeDialog(); showSettings('usage'); }
  else if (action === 'retrack') edit(async (s) => { s.cropKeyframes = null; await retrack(s, await sourceFor(state.project.media.find((m) => m.id === s.mediaId))); });
  else if (action === 'remove') removeShort(target.dataset.id ?? state.selectedId);
  else if (action === 'sort') toggleSort();
  else if (action === 'regen-captions') regenerateCaptions();
});

document.addEventListener('change', async (event) => {
  if (event.target.id === 'title' && state.project) {
    state.project.title = event.target.value.trim() || state.project.title;
    event.target.value = state.project.title;
    document.title = `${state.project.title} · Relio Clips`;
    await persist();
    setUrl(projectPath(state.project) + (location.pathname.match(/\/short-\d+$/)?.[0] ?? ''), true);
    return;
  }
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
    else if (field === 'captionsHidden') s.captionsHidden = !input.checked;
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
  const task = beginTask('Relio AI · regenerating subtitles…');
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
  if (event.key === 'Escape' && $('#menu')) { closeMenu(); return; }
  if (event.key === 'Escape' && state.dialog) { closeDialog(); return; }
  if (event.target.closest('input,textarea,select') || state.dialog) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
  if (event.key === ' ') { const play = $('[data-play]'); if (play) { event.preventDefault(); play.click(); } }
});

boot();
