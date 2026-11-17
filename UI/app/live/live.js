// The Live screen: the Relio server records Twitch channels (watcher/), and this screen shows one at a time like Twitch does:
// chat on the left, the stream on the right, a graph of the last five minutes underneath (green voice, orange chat, red hype,
// with a marker for every clip), and the clips the server made, each one a click away from Create Shorts.
import { parseLogin } from './twitch.js';
import { downloadVideo } from '../cloudvideo.js';

const COLORS = { loud: '#34c759', chat: '#ff9f0a', hype: '#ff453a' };
const ACTIVE = ['starting', 'recording', 'offline'];
const STATE_TEXT = { starting: 'Starting…', recording: 'Recording', offline: 'Offline · waiting for the stream', stopped: 'Stopped', ended: 'Ended', error: 'Stopped' };
let host = null, onFile = null, token = null, db = null, polling = null;
let rows = [], clips = [], selected = null, shownChannel = null;
const busy = new Set(), errors = new Map();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Shows the Live screen in `element`. `fileHandler(file)` opens a clip in Create Shorts; `tokenGetter()` gives the session
 * token; `dbGetter()` gives the Supabase client. */
export function mountLive(element, fileHandler, tokenGetter, dbGetter) {
  host = element;
  onFile = fileHandler;
  token = tokenGetter;
  db = dbGetter;
  shownChannel = null;
  host.innerHTML = `<section class="live">
    <form id="live-form" class="row live-form"><input id="live-url" type="text" inputmode="url" autocomplete="off" placeholder="Paste a Twitch channel, like twitch.tv/name" aria-label="Twitch channel">
      <button class="button primary" type="submit">Start recording</button></form>
    <p id="live-notice" class="error" role="alert" hidden></p>
    <div id="live-tabs" class="live-tabs" role="tablist"></div>
    <div id="live-view"></div>
  </section>`;
  host.querySelector('#live-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = host.querySelector('#live-url');
    if (await start(input.value)) input.value = '';
  });
  clearInterval(polling);
  refresh();
  polling = setInterval(() => (host?.isConnected ? refresh() : clearInterval(polling)), 2500);
  addEventListener('resize', drawGraph);
}

function notice(text) {
  const element = host?.querySelector('#live-notice');
  if (element) { element.textContent = text; element.hidden = !text; }
  return false;
}

async function start(text) {
  const login = parseLogin(text);
  if (!login) return notice('Paste a Twitch channel link, like twitch.tv/name.');
  notice('');
  const { data, error } = await db().from('live_sessions').insert({ login }).select('id').single();
  if (error) return notice(/two channels|already recording/.test(error.message) ? error.message : 'The recording could not be started. Please try again.');
  selected = data.id;
  await refresh();
  return true;
}

/** Recordings of the last day and their clips; the graph only for the channel on screen. */
async function refresh() {
  const client = db?.();
  if (!client) return;
  const since = new Date(Date.now() - 86400_000).toISOString();
  const [sessionRows, clipRows] = await Promise.all([
    client.from('live_sessions').select('id,login,state,detail,buffered,chat,created').gte('created', since).order('created', { ascending: false }),
    client.from('live_clips').select('id,session_id,at,why,media_id,bytes').gte('created', since).order('at', { ascending: false }),
  ]);
  if (sessionRows.error || clipRows.error) return;
  rows = sessionRows.data;
  clips = clipRows.data;
  if (!rows.some((r) => r.id === selected)) selected = (rows.find((r) => ACTIVE.includes(r.state)) ?? rows[0])?.id ?? null;
  const current = rows.find((r) => r.id === selected);
  if (current && ACTIVE.includes(current.state)) {
    const graph = await client.from('live_sessions').select('graph').eq('id', current.id).single();
    current.graph = graph.data?.graph ?? null;
  }
  render();
}

function render() {
  if (!host?.isConnected) return;
  host.querySelector('#live-tabs').innerHTML = rows.map((r) => `<button role="tab" aria-selected="${r.id === selected}" class="live-tab ${r.id === selected ? 'on' : ''}" data-live-tab="${r.id}">
    <span class="dot ${ACTIVE.includes(r.state) ? 'live' : ''}" aria-hidden="true"></span>${esc(r.login)}</button>`).join('');
  for (const tab of host.querySelectorAll('[data-live-tab]')) tab.addEventListener('click', () => { selected = tab.dataset.liveTab; render(); refresh(); });
  const view = host.querySelector('#live-view');
  const current = rows.find((r) => r.id === selected);
  if (!current) {
    shownChannel = null;
    view.innerHTML = `<div class="panel live-empty"><strong>Nothing recording yet</strong><p class="muted">Paste a Twitch channel above. Relio records it on its server,
      even after you close this tab, and saves a clip whenever the stream gets much louder or chat explodes. Up to two channels at once.</p></div>`;
    return;
  }
  const active = ACTIVE.includes(current.state);
  // The player and chat load once per channel, so a refresh never restarts them.
  if (shownChannel !== current.id) {
    shownChannel = current.id;
    const parent = encodeURIComponent(location.hostname);
    view.innerHTML = `<div class="live-head row between"><span><strong>${esc(current.login)}</strong> <span id="live-state" class="muted small"></span></span>
        <button class="button ghost" id="live-stop">Stop recording</button></div>
      <div class="live-stage">
        <iframe class="live-chat" title="Twitch chat" src="https://www.twitch.tv/embed/${encodeURIComponent(current.login)}/chat?parent=${parent}&darkpopout"></iframe>
        <iframe class="live-player" title="Twitch stream" allowfullscreen src="https://player.twitch.tv/?channel=${encodeURIComponent(current.login)}&parent=${parent}&muted=true"></iframe>
      </div>
      <div class="panel live-graph-panel">
        <div class="row between small"><span class="live-legend"><i style="background:${COLORS.loud}"></i>Voice <i style="background:${COLORS.chat}"></i>Chat messages per second <i style="background:${COLORS.hype}"></i>Hype · clip</span>
          <span class="muted">last 5 minutes</span></div>
        <canvas id="live-graph" height="160" aria-label="Voice, chat and hype over the last five minutes"></canvas>
      </div>
      <h3 class="live-clips-title">Clips</h3><div id="live-clips"></div>`;
    view.querySelector('#live-stop').addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      await db().from('live_sessions').update({ state: 'stopped' }).eq('id', current.id);
      refresh();
    });
  }
  view.querySelector('#live-state').textContent = `· ${STATE_TEXT[current.state]}${current.state === 'recording' ? ` · ${Math.floor(current.buffered / 60)} of 15 min kept${current.chat ? '' : ' · chat not connected'}` : ''}`;
  view.querySelector('#live-stop').hidden = !active;
  const own = clips.filter((c) => c.session_id === current.id);
  const problem = (current.state === 'error' || current.state === 'ended') && current.detail ? `<p class="error">${esc(current.detail)}</p>` : '';
  view.querySelector('#live-clips').innerHTML = problem + (own.length === 0
    ? `<p class="muted small">${active ? 'No clips yet. They appear here about 40 seconds after a spike.' : 'No clips.'}</p>`
    : `<ul class="live-moments">${own.map((c) => `<li class="row between"><span><strong class="mono">${clock(Date.parse(c.at))}</strong> <span class="muted small">${esc(c.why)} · ${Math.round(c.bytes / 1e6)} MB</span>${errors.get(c.id) ? `<span class="error small"> · ${esc(errors.get(c.id))}</span>` : ''}</span>
        <button class="button" data-live-make="${c.id}" ${busy.has(c.id) ? 'disabled' : ''}>${busy.has(c.id) ? 'Downloading…' : 'Make Shorts'}</button></li>`).join('')}</ul>`);
  for (const button of view.querySelectorAll('[data-live-make]')) button.addEventListener('click', () => make(own.find((c) => c.id === button.dataset.liveMake), current.login));
  drawGraph();
}

async function make(clip, login) {
  busy.add(clip.id);
  errors.delete(clip.id);
  render();
  try {
    const blob = await downloadVideo({ token: await token(), mediaId: clip.media_id, type: 'video/mp4', size: clip.bytes });
    onFile(new File([blob], `${login} ${clock(Date.parse(clip.at)).replace(/:/g, '.')}.mp4`, { type: 'video/mp4' }));
  } catch (error) { errors.set(clip.id, error.message); }
  busy.delete(clip.id);
  render();
}

/** Three lines over the last five minutes, each scaled to its own range, plus a red marker at every clip. */
function drawGraph() {
  const canvas = host?.querySelector('#live-graph');
  if (!canvas) return;
  const current = rows.find((r) => r.id === selected);
  const ratio = devicePixelRatio || 1, width = canvas.clientWidth, height = 160;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);
  const graph = current?.graph;
  ctx.strokeStyle = 'rgba(128,128,128,.25)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { const x = Math.round(width * i / 5) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  if (!graph?.loud?.length) {
    ctx.fillStyle = 'rgba(128,128,128,.8)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(ACTIVE.includes(current?.state) ? 'Waiting for the first minute of the stream…' : 'The graph shows while a channel records.', 12, height / 2);
    return;
  }
  const span = 300, end = graph.start + (graph.loud.length - 1) * 1000, from = end - span * 1000;
  const xOf = (ms) => ((ms - from) / (span * 1000)) * width;
  const pad = 8, yOf = (v) => height - pad - v * (height - pad * 2);
  const chatMax = Math.max(3, ...graph.chat);
  for (const [key, values] of [['loud', graph.loud], ['chat', graph.chat.map((n) => n / chatMax)], ['hype', graph.hype]]) {
    ctx.strokeStyle = COLORS[key];
    ctx.lineWidth = key === 'hype' ? 2.5 : 1.5;
    ctx.beginPath();
    values.forEach((v, i) => { const x = xOf(graph.start + i * 1000), y = yOf(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.fillStyle = COLORS.hype;
  for (const clip of clips.filter((c) => c.session_id === current.id)) {
    const x = xOf(Date.parse(clip.at));
    if (x < 0 || x > width) continue;
    ctx.globalAlpha = 0.25; ctx.fillRect(x - 1, 0, 2, height); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, 8, 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(128,128,128,.9)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('−5 min', 4, height - 4);
  ctx.fillText('now', width - 26, height - 4);
  ctx.fillText(`chat max ${chatMax}/s`, width - 110, 14);
}
