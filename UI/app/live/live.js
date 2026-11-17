// The Live screen: record Twitch channels while this tab is open, see likely moments as they happen, and turn one into a
// video for the usual Create Shorts steps. Recordings keep going while you use other screens; closing the tab ends them.
import { parseLogin, variantsOf, pickVariant } from './twitch.js';
import * as store from './pieces.js';
import { mediabunny } from '../engine/media.js';

const BEFORE = 60, AFTER = 30;   // seconds of stream around a moment that become the clip
const sessions = [];
let host = null, onFile = null, token = null;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const STATES = { connecting: 'Connecting…', live: 'Recording', offline: 'Offline · waiting for the stream to start', stopped: 'Stopped' };

// Old recordings from a closed tab are useless: they're cleared when the app opens.
store.clear().catch(() => {});
addEventListener('beforeunload', (event) => { if (sessions.some((s) => s.state !== 'stopped')) event.preventDefault(); });

/** Shows the Live screen in `element`. `fileHandler(file)` opens a finished clip in Create Shorts; `tokenGetter()` gives the session token. */
export function mountLive(element, fileHandler, tokenGetter) {
  host = element;
  onFile = fileHandler;
  token = tokenGetter;
  host.innerHTML = `<section class="live stack">
    <p class="muted">Paste a Twitch channel. While it streams, Relio keeps the last 30 minutes in this browser and marks a moment
      whenever the stream gets much louder or chat explodes. Turn any moment into Shorts. <strong>Keep this tab open</strong>; you can use other screens meanwhile.</p>
    <form id="live-form" class="row live-form"><input id="live-url" type="text" inputmode="url" autocomplete="off" placeholder="twitch.tv/channel" aria-label="Twitch channel">
      <button class="button primary" type="submit">Start recording</button></form>
    <p id="live-notice" class="error" role="alert" hidden></p>
    <div id="live-sessions" class="stack"></div>
  </section>`;
  host.querySelector('#live-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = host.querySelector('#live-url');
    if (start(input.value)) input.value = '';
  });
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
  list.innerHTML = sessions.map((s) => `<div class="panel live-session">
      <div class="row between"><strong>${esc(s.login)}</strong>
        <span class="muted small">${STATES[s.state]}${s.state === 'live' ? ` · ${Math.floor(s.buffered / 60)} min kept${s.chat ? ' · chat on' : ''}` : ''}</span>
        ${s.state !== 'stopped' ? `<button class="button ghost" data-live-stop="${s.id}">Stop</button>` : ''}</div>
      ${s.error ? `<p class="error">${esc(s.error)}</p>` : ''}
      ${s.moments.length === 0 ? `<p class="muted small">${s.state === 'stopped' ? 'No moments.' : 'No moments yet. They appear here as they happen.'}</p>` : `<ul class="live-moments">${s.moments.map((m, i) => `<li class="row between">
        <span><strong class="mono">${clock(m.at)}</strong> <span class="muted small">${esc(m.why)}</span>${m.error ? `<span class="error small"> · ${esc(m.error)}</span>` : ''}</span>
        <button class="button" data-live-make="${s.id}:${i}" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Preparing…' : 'Make Shorts'}</button></li>`).join('')}</ul>`}
    </div>`).join('');
  for (const button of list.querySelectorAll('[data-live-stop]')) button.addEventListener('click', () => stop(sessions.find((s) => s.id === button.dataset.liveStop)));
  for (const button of list.querySelectorAll('[data-live-make]')) button.addEventListener('click', () => {
    const [id, index] = button.dataset.liveMake.split(':');
    const session = sessions.find((s) => s.id === id);
    makeShort(session, session.moments[Number(index)]);
  });
}
