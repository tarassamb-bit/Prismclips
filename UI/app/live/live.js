// The Live screen: record Twitch channels, see likely moments as they happen, and turn one into a video for the usual
// Create Shorts steps. Two ways to record: on the Relio server (keeps going when the tab closes; see watcher/), or in this
// browser (keeps going while you use other screens; closing the tab ends it).
import { parseLogin, variantsOf, pickVariant } from './twitch.js';
import * as store from './pieces.js';
import { mediabunny } from '../engine/media.js';
import { downloadVideo } from '../cloudvideo.js';

const BEFORE = 60, AFTER = 30;   // seconds of stream around a moment that become the clip
const sessions = [];
let host = null, onFile = null, token = null, db = null;
// The server's recordings and their clips, refreshed every few seconds while the screen is open.
let serverRows = [], serverClips = [], polling = null;
const busyClips = new Set(), clipErrors = new Map();
const SERVER_STATE = { starting: 'connecting', recording: 'live', offline: 'offline', stopped: 'stopped', ended: 'stopped', error: 'stopped' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const STATES = { connecting: 'Connecting…', live: 'Recording', offline: 'Offline · waiting for the stream to start', stopped: 'Stopped' };

// Old recordings from a closed tab are useless: they're cleared when the app opens.
store.clear().catch(() => {});
addEventListener('beforeunload', (event) => { if (sessions.some((s) => s.state !== 'stopped')) event.preventDefault(); });

/** Shows the Live screen in `element`. `fileHandler(file)` opens a finished clip in Create Shorts; `tokenGetter()` gives the
 * session token; `dbGetter()` gives the Supabase client. */
export function mountLive(element, fileHandler, tokenGetter, dbGetter) {
  host = element;
  onFile = fileHandler;
  token = tokenGetter;
  db = dbGetter;
  host.innerHTML = `<section class="live stack">
    <p class="muted">Paste a Twitch channel. While it streams, Relio marks a moment whenever the stream gets much louder or chat
      explodes. Turn any moment into Shorts.</p>
    <form id="live-form" class="stack"><div class="row live-form"><input id="live-url" type="text" inputmode="url" autocomplete="off" placeholder="twitch.tv/channel" aria-label="Twitch channel">
      <button class="button primary" type="submit">Start recording</button></div>
      <label class="row small"><input id="live-server" type="checkbox" checked> Keep recording when I close this tab (on the Relio server, last 15 minutes, up to 2 channels)</label></form>
    <p id="live-notice" class="error" role="alert" hidden></p>
    <div id="live-sessions" class="stack"></div>
  </section>`;
  host.querySelector('#live-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = host.querySelector('#live-url');
    const run = host.querySelector('#live-server').checked ? startOnServer : start;
    Promise.resolve(run(input.value)).then((ok) => { if (ok) input.value = ''; });
  });
  render();
  clearInterval(polling);
  refresh();
  polling = setInterval(() => (host?.isConnected ? refresh() : clearInterval(polling)), 5000);
}

/** The server's recordings of the last day, and their clips. */
async function refresh() {
  const client = db?.();
  if (!client) return;
  const since = new Date(Date.now() - 86400_000).toISOString();
  const [rows, clips] = await Promise.all([
    client.from('live_sessions').select('id,login,state,detail,buffered,chat,created').gte('created', since).order('created', { ascending: false }),
    client.from('live_clips').select('id,session_id,at,why,media_id,bytes').gte('created', since).order('at', { ascending: false }),
  ]);
  if (rows.error || clips.error) return;
  serverRows = rows.data;
  serverClips = clips.data;
  render();
}

async function startOnServer(text) {
  const login = parseLogin(text);
  if (!login) return notice('Paste a Twitch channel link, like twitch.tv/name.');
  notice('');
  const { error } = await db().from('live_sessions').insert({ login });
  if (error) return notice(/two channels|already recording/.test(error.message) ? error.message : 'The recording could not be started. Please try again.');
  await refresh();
  return true;
}

async function makeFromServer(clip, login) {
  busyClips.add(clip.id);
  clipErrors.delete(clip.id);
  render();
  try {
    const blob = await downloadVideo({ token: await token(), mediaId: clip.media_id, type: 'video/mp4', size: clip.bytes });
    onFile(new File([blob], `${login} ${clock(Date.parse(clip.at)).replace(/:/g, '.')}.mp4`, { type: 'video/mp4' }));
  } catch (error) { clipErrors.set(clip.id, error.message); }
  busyClips.delete(clip.id);
  render();
}

function start(text) {
  const login = parseLogin(text);
  if (!login) return notice('Paste a Twitch channel link, like twitch.tv/name.');
  if (sessions.some((s) => s.login === login && s.state !== 'stopped')) return notice(`${login} is already recording.`);
  notice('');
  const session = { id: crypto.randomUUID(), login, state: 'connecting', buffered: 0, chat: false, moments: [], error: '' };
  session.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  session.worker.onmessage = ({ data }) => {
    if (data.type === 'need-playlist') lookUp(session);
    if (data.type === 'status') Object.assign(session, { state: data.state, buffered: data.buffered, chat: data.chat });
    if (data.type === 'moment') session.moments.unshift({ at: data.at, why: data.why, busy: false });
    if (data.type === 'error') Object.assign(session, { error: data.message, state: 'stopped' });
    render();
  };
  session.worker.postMessage({ type: 'start', session: session.id, login });
  sessions.unshift(session);
  render();
  return true;
}

function notice(text) {
  const element = host?.querySelector('#live-notice');
  if (element) { element.textContent = text; element.hidden = !text; }
  return false;
}

/** Finds the stream's playlist for the worker; while the channel is offline, checks again every 30 seconds. */
async function lookUp(session) {
  if (session.state === 'stopped') return;
  try {
    const variant = pickVariant(await variantsOf(session.login, token));
    if (!variant) throw new Error('Twitch sent no playable stream.');
    session.worker.postMessage({ type: 'playlist', url: variant.url });
  } catch (error) {
    if (session.state === 'stopped') return;
    if (error.message !== 'offline') { session.error = error.message; render(); }
    else session.worker.postMessage({ type: 'offline' });
    setTimeout(() => lookUp(session), 30_000);
  }
}

function stop(session) {
  session.worker.postMessage({ type: 'stop' });
  setTimeout(() => session.worker.terminate(), 1000);
  session.state = 'stopped';
  render();
}

/** The moment as an MP4 file: the stream's own pieces around it, joined without re-encoding. */
async function clipFile(session, moment) {
  const pieces = await store.between(session.id, moment.at - BEFORE * 1000, moment.at + AFTER * 1000);
  if (pieces.length === 0) throw new Error('This moment is older than 30 minutes, so it is no longer recorded.');
  // fMP4 pieces need their header; if Twitch switched headers mid-moment, keep the part after the switch.
  const header = pieces.at(-1).init;
  const run = header ? pieces.slice(pieces.findLastIndex((p) => p.init?.byteLength !== header.byteLength) + 1) : pieces;
  const { Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, BufferTarget, Conversion } = await mediabunny();
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([...(header ? [header] : []), ...run.map((p) => p.bytes)])) });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const conversion = await Conversion.init({ input, output });
  if (!conversion.isValid) throw new Error('This part of the stream could not be read.');
  await conversion.execute();
  return new File([output.target.buffer], `${session.login} ${clock(moment.at).replace(/:/g, '.')}.mp4`, { type: 'video/mp4' });
}

async function makeShort(session, moment) {
  moment.busy = true;
  moment.error = '';
  render();
  try { onFile(await clipFile(session, moment)); }
  catch (error) { moment.error = error.message; }
  moment.busy = false;
  render();
}

function render() {
  const list = host?.isConnected && host.querySelector('#live-sessions');
  if (!list) return;
  const server = serverRows.map((r) => ({
    id: r.id, login: r.login, server: true, state: SERVER_STATE[r.state] ?? 'stopped', buffered: r.buffered, chat: r.chat,
    error: r.state === 'error' || r.state === 'ended' ? r.detail ?? '' : '',
    moments: serverClips.filter((c) => c.session_id === r.id).map((c) => ({ at: Date.parse(c.at), why: c.why, clip: c, busy: busyClips.has(c.id), error: clipErrors.get(c.id) })),
  }));
  const all = [...server, ...sessions];
  list.innerHTML = all.map((s) => `<div class="panel live-session">
      <div class="row between"><strong>${esc(s.login)}</strong>
        <span class="muted small">${s.server ? 'Relio server · ' : 'This browser · '}${STATES[s.state]}${s.state === 'live' ? ` · ${Math.floor(s.buffered / 60)} min kept${s.chat ? ' · chat on' : ''}` : ''}</span>
        ${s.state !== 'stopped' ? `<button class="button ghost" data-live-stop="${s.id}">Stop</button>` : ''}</div>
      ${s.error ? `<p class="error">${esc(s.error)}</p>` : ''}
      ${s.moments.length === 0 ? `<p class="muted small">${s.state === 'stopped' ? 'No moments.' : 'No moments yet. They appear here as they happen.'}</p>` : `<ul class="live-moments">${s.moments.map((m, i) => `<li class="row between">
        <span><strong class="mono">${clock(m.at)}</strong> <span class="muted small">${esc(m.why)}</span>${m.error ? `<span class="error small"> · ${esc(m.error)}</span>` : ''}</span>
        <button class="button" data-live-make="${s.id}:${i}" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Preparing…' : 'Make Shorts'}</button></li>`).join('')}</ul>`}
    </div>`).join('');
  const find = (id) => all.find((s) => s.id === id);
  for (const button of list.querySelectorAll('[data-live-stop]')) button.addEventListener('click', async () => {
    const session = find(button.dataset.liveStop);
    if (!session.server) return stop(sessions.find((s) => s.id === session.id));
    button.disabled = true;
    await db().from('live_sessions').update({ state: 'stopped' }).eq('id', session.id);
    refresh();
  });
  for (const button of list.querySelectorAll('[data-live-make]')) button.addEventListener('click', () => {
    const [id, index] = button.dataset.liveMake.split(':');
    const session = find(id), moment = session.moments[Number(index)];
    if (session.server) makeFromServer(moment.clip, session.login);
    else makeShort(sessions.find((s) => s.id === id), moment);
  });
}
