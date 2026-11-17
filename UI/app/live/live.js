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
// Where the pointer is over the graph (CSS pixels from its left), and what the last drawing mapped, for the hover readout.
let hoverX = null, plotted = null;
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
  host.innerHTML = `<section class="live-screen">
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
  if (current) {
    const graph = await client.from('live_sessions').select('graph').eq('id', current.id).single();
    current.graph = graph.data?.graph ?? null;
  }
  render();
}

function render() {
  if (!host?.isConnected) return;
  host.querySelector('#live-tabs').innerHTML = rows.map((r) => `<button role="tab" aria-selected="${r.id === selected}" class="live-tab ${r.id === selected ? 'on' : ''}" data-live-tab="${r.id}">
    <span class="dot ${ACTIVE.includes(r.state) ? 'on-air' : ''}" aria-hidden="true"></span>${esc(r.login)}</button>`).join('');
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
  const viewKey = `${current.id}:${active}`;
  if (shownChannel !== viewKey) {
    shownChannel = viewKey;
    const parent = encodeURIComponent(location.hostname);
    const dark = (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
    view.innerHTML = `<div class="live-head"><span class="live-title"><strong>${esc(current.login)}</strong><span id="live-state" class="live-pill"></span></span>
        <span id="live-meta" class="muted small"></span>
        <button class="button ghost" id="live-stop">Stop recording</button></div>
      ${active ? `<div class="live-stage">
        <iframe class="live-chat" title="Twitch chat" src="https://www.twitch.tv/embed/${encodeURIComponent(current.login)}/chat?parent=${parent}${dark ? '&darkpopout' : ''}"></iframe>
        <iframe class="live-player" title="Twitch stream" allowfullscreen src="https://player.twitch.tv/?channel=${encodeURIComponent(current.login)}&parent=${parent}&muted=true"></iframe>
      </div>` : ''}
      <div class="panel live-graph-panel">
        <div class="live-legend small"><span><i style="background:${COLORS.loud}"></i>Voice</span><span><i style="background:${COLORS.chat}"></i>Chat messages / s</span><span><i style="background:${COLORS.hype}"></i>Hype</span><span><b class="clip-dot"></b>Clip</span>
          <span class="muted live-span">${active ? 'last 5 minutes' : 'last 5 minutes before it stopped'}</span></div>
        <div class="live-graph-wrap"><canvas id="live-graph" height="160" aria-label="Voice, chat and hype over the last five minutes"></canvas>
          <div id="live-tip" class="live-tip" role="status" hidden></div></div>
      </div>
      <div class="live-clips-head"><h3>Clips</h3><span id="live-count" class="muted small"></span></div><div id="live-clips"></div>`;
    hoverX = null;
    const canvas = view.querySelector('#live-graph');
    canvas.addEventListener('pointermove', (event) => { hoverX = event.clientX - canvas.getBoundingClientRect().left; drawGraph(); });
    canvas.addEventListener('pointerdown', (event) => { hoverX = event.clientX - canvas.getBoundingClientRect().left; drawGraph(); });
    canvas.addEventListener('pointerleave', () => { hoverX = null; drawGraph(); });
    view.querySelector('#live-stop').addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      await db().from('live_sessions').update({ state: 'stopped' }).eq('id', current.id);
      refresh();
    });
  }
  const pill = view.querySelector('#live-state');
  pill.textContent = current.state === 'recording' ? 'LIVE' : STATE_TEXT[current.state];
  pill.className = `live-pill ${current.state === 'recording' ? 'on' : ''}`;
  view.querySelector('#live-meta').textContent = current.state === 'recording' ? `${Math.floor(current.buffered / 60)} of 15 min kept${current.chat ? ' · chat connected' : ' · chat not connected'}` : '';
  view.querySelector('#live-stop').hidden = !active;
  const own = clips.filter((c) => c.session_id === current.id);
  view.querySelector('#live-count').textContent = own.length ? `${own.length} saved · kept for 2 days` : '';
  const problem = current.detail ? `<p class="error">${esc(current.detail)}</p>` : '';
  view.querySelector('#live-clips').innerHTML = problem + (own.length === 0
    ? `<p class="muted small">${active ? 'No clips yet. They appear here about 40 seconds after a spike.' : 'No clips.'}</p>`
    : `<div class="live-clip-grid">${own.map((c) => `<div class="live-clip"><strong class="mono">${clock(Date.parse(c.at))}</strong>
        <span class="small">${esc(c.why)}</span><span class="muted small">90 s · ${Math.round(c.bytes / 1e6)} MB</span>${errors.get(c.id) ? `<span class="error small">${esc(errors.get(c.id))}</span>` : ''}
        <button class="button primary" data-live-make="${c.id}" ${busy.has(c.id) ? 'disabled' : ''}>${busy.has(c.id) ? 'Opening…' : 'Make a Short'}</button></div>`).join('')}</div>`);
  for (const button of view.querySelectorAll('[data-live-make]')) button.addEventListener('click', () => make(own.find((c) => c.id === button.dataset.liveMake), current.login));
  drawGraph();
}

async function make(clip, login) {
  busy.add(clip.id);
  errors.delete(clip.id);
  render();
  try {
    const blob = await downloadVideo({ token, mediaId: clip.media_id, type: 'video/mp4', size: clip.bytes });
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
  const tip = host.querySelector('#live-tip');
  if (tip) tip.hidden = true;
  plotted = null;
  ctx.strokeStyle = 'rgba(128,128,128,.25)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { const x = Math.round(width * i / 5) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  if (!graph?.loud?.length) {
    ctx.fillStyle = 'rgba(128,128,128,.8)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(ACTIVE.includes(current?.state) ? 'Waiting for the first minute of the stream…' : 'No graph for this recording.', 12, height / 2);
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
  plotted = { graph, xOf, yOf, chatMax };
  if (hoverX !== null) readout(ctx, width, height, current);
}

/** The second under the pointer: a guide line, a dot on each line, and its numbers in a small box. */
function readout(ctx, width, height, current) {
  const { graph, xOf, yOf, chatMax } = plotted;
  const step = xOf(graph.start + 1000) - xOf(graph.start);
  const index = Math.max(0, Math.min(graph.loud.length - 1, Math.round((hoverX - xOf(graph.start)) / step)));
  const at = graph.start + index * 1000, x = xOf(at);
  if (x < 0 || x > width) return;
  ctx.strokeStyle = 'rgba(128,128,128,.7)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, height); ctx.stroke();
  ctx.setLineDash([]);
  const values = { loud: graph.loud[index], chat: graph.chat[index] / chatMax, hype: graph.hype[index] };
  for (const key of ['loud', 'chat', 'hype']) {
    ctx.fillStyle = COLORS[key];
    ctx.beginPath(); ctx.arc(x, yOf(values[key]), 4.5, 0, Math.PI * 2); ctx.fill();
  }
  const clip = clips.find((c) => c.session_id === current.id && Math.abs(Date.parse(c.at) - at) <= 2000);
  const tip = host.querySelector('#live-tip');
  tip.innerHTML = `<strong class="mono">${clock(at)}</strong>
    <span><i style="background:${COLORS.loud}"></i>Voice ${Math.round(graph.loud[index] * 100)}%</span>
    <span><i style="background:${COLORS.chat}"></i>Chat ${graph.chat[index]} msg/s</span>
    <span><i style="background:${COLORS.hype}"></i>Hype ${Math.round(graph.hype[index] * 100)}%${graph.hype[index] >= 0.5 ? ' · spike' : ''}</span>
    ${clip ? `<span class="tip-clip">● Clip: ${esc(clip.why)}</span>` : ''}`;
  tip.hidden = false;
  // Beside the guide line, flipped to the left near the right edge.
  const left = x + 14 + tip.offsetWidth > width ? x - 14 - tip.offsetWidth : x + 14;
  tip.style.left = `${Math.max(0, left)}px`;
}
