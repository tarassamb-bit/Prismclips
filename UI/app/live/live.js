// The Live screen: the Relio server records Twitch channels (watcher/), and this screen shows one at a time like Twitch does:
// chat on the left, the stream on the right, a graph of the last five minutes underneath (green voice, orange chat, red hype,
// with a marker for every clip), and the finished Shorts the server made from each spike, which play in a window over the page.
import { parseLogin } from './twitch.js';

const COLORS = { loud: '#34c759', chat: '#ff9f0a', hype: '#ff453a' };
const ACTIVE = ['starting', 'recording', 'offline'];
const STATE_TEXT = { starting: 'Starting…', recording: 'Recording', offline: 'Offline · waiting for the stream', stopped: 'Stopped', ended: 'Ended', error: 'Stopped' };
let host = null, db = null, polling = null;
let rows = [], clips = [], channels = [], selected = null, shownChannel = null;
// Where the pointer is over the graph (CSS pixels from its left), and what the last drawing mapped, for the hover readout.
let hoverX = null, plotted = null;
// The graph slides on smoothly between updates: it shows the time `lag` ms behind now, so new data arrives just as it's needed.
let lag = null, frame = 0, chatScale = null;
// Every second the page has seen for the channel on screen, by whole second: updates only cover the last five minutes,
// so without this the line's left end would drop off a few seconds at a time.
let history = { login: null, seconds: new Map() };

/** Sets `element`'s content only when it changed, so a refresh doesn't rebuild (and flicker) what is already on screen. */
function setHtml(element, html) {
  if (element.dataset.html === html) return false;
  element.dataset.html = html;
  element.innerHTML = html;
  return true;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Shows the Live screen in `element`; `dbGetter()` gives the Supabase client. */
export function mountLive(element, dbGetter) {
  host = element;
  db = dbGetter;
  shownChannel = null;
  host.innerHTML = `<section class="live-screen">
    <form id="live-form" class="row live-form"><input id="live-url" type="text" inputmode="url" autocomplete="off" placeholder="Paste a Twitch channel, like twitch.tv/name" aria-label="Twitch channel">
      <button class="button primary" type="submit">Start recording</button><button class="button ghost" type="button" id="live-guide">How it works</button></form>
    <p id="live-notice" class="error" role="alert" hidden></p>
    <div id="live-tabs" class="live-tabs" role="tablist"></div>
    <div id="live-view"></div>
  </section>`;
  host.querySelector('#live-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = host.querySelector('#live-url');
    if (await start(input.value)) input.value = '';
  });
  host.querySelector('#live-guide').addEventListener('click', guide);
  // The guide opens by itself the first time someone opens Live on this device.
  let seen = true;
  try { seen = localStorage.getItem('relio-live-guide') === 'seen'; localStorage.setItem('relio-live-guide', 'seen'); } catch { /* storage blocked: no automatic guide */ }
  if (!seen) guide();
  clearInterval(polling);
  refresh();
  polling = setInterval(() => (host?.isConnected ? refresh() : clearInterval(polling)), 2500);
  addEventListener('resize', drawGraph);
  cancelAnimationFrame(frame);
  let last = 0;
  const tick = (time) => {
    if (!host?.isConnected) return;
    if (time - last > 33 && ACTIVE.includes(channels.find((c) => c.login === selected)?.row.state)) { last = time; drawGraph(); }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
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
    client.from('live_clips').select('id,session_id,at,why,duration,short,media_id').gte('created', since).order('at', { ascending: false }),
  ]);
  if (sessionRows.error || clipRows.error) return;
  // Everything new is gathered first and swapped in at once: the graph is never drawn from a list that has no graph yet.
  const nextRows = sessionRows.data;
  // One tab per channel: rows come newest first, so the first row of a channel is the one shown.
  const nextChannels = [...new Set(nextRows.map((r) => r.login))].map((login) => ({ login, row: nextRows.find((r) => r.login === login), ids: new Set(nextRows.filter((r) => r.login === login).map((r) => r.id)) }));
  let nextSelected = selected;
  if (!nextChannels.some((c) => c.login === nextSelected)) nextSelected = (nextChannels.find((c) => ACTIVE.includes(c.row.state)) ?? nextChannels[0])?.login ?? null;
  const current = nextChannels.find((c) => c.login === nextSelected)?.row;
  if (current) {
    const graph = await client.from('live_sessions').select('graph').eq('id', current.id).single();
    const raw = graph.data?.graph ?? channels.find((c) => c.row.id === current.id)?.row.graph ?? null;
    // The newest seconds are still filling in on the server and change on the next update: shown only once they are final.
    current.graph = raw?.loud?.length > 3 && !raw.trimmed ? { ...raw, loud: raw.loud.slice(0, -3), chat: raw.chat.slice(0, -3), hype: raw.hype.slice(0, -3), trimmed: true } : raw;
    if (history.login !== current.login) { history = { login: current.login, seconds: new Map() }; chatScale = null; }
    current.graph?.loud?.forEach((loud, i) => history.seconds.set(Math.round(current.graph.start / 1000) + i, { loud, chat: current.graph.chat[i], hype: current.graph.hype[i] }));
    // Only the window on screen and a little margin are kept.
    const oldest = Math.round(Date.now() / 1000) - 400;
    for (const second of history.seconds.keys()) if (second < oldest) history.seconds.delete(second);
    const dataEnd = current.graph?.loud?.length ? current.graph.start + (current.graph.loud.length - 1) * 1000 : null;
    // The graph runs this far behind now: the newest data's age plus room for a late update, so it never catches up with
    // the data (which would stop it, then jump). Eased very gently, so the speed never visibly changes.
    if (dataEnd) { const target = Date.now() - dataEnd + 6000; lag = lag === null || Math.abs(lag - target) > 15_000 ? target : lag * 0.95 + target * 0.05; }
  }
  // Another channel may have been chosen while this refresh waited.
  if (nextSelected !== selected && channels.some((c) => c.login === selected) && nextChannels.some((c) => c.login === selected)) return;
  rows = nextRows;
  clips = clipRows.data;
  channels = nextChannels;
  selected = nextSelected;
  render();
}

function render() {
  if (!host?.isConnected) return;
  const tabs = host.querySelector('#live-tabs');
  if (setHtml(tabs, channels.map((c) => `<button role="tab" aria-selected="${c.login === selected}" class="live-tab ${c.login === selected ? 'on' : ''}" data-live-tab="${esc(c.login)}" title="${esc(STATE_TEXT[c.row.state])} · right-click to delete">
    <span class="dot ${c.row.state === 'recording' ? 'on-air' : ACTIVE.includes(c.row.state) ? 'waiting' : ''}" aria-hidden="true"></span>${esc(c.login)}</button>`).join(''))) for (const tab of tabs.querySelectorAll('[data-live-tab]')) {
    tab.addEventListener('click', () => { selected = tab.dataset.liveTab; render(); refresh(); });
    tab.addEventListener('contextmenu', (event) => { event.preventDefault(); remove(tab.dataset.liveTab); });
    tab.addEventListener('keydown', (event) => { if (event.key === 'Delete' || event.key === 'Backspace') remove(tab.dataset.liveTab); });
  }
  const view = host.querySelector('#live-view');
  const channel = channels.find((c) => c.login === selected);
  const current = channel?.row;
  if (!current) {
    shownChannel = null;
    view.innerHTML = `<div class="panel live-empty"><strong>Nothing recording yet</strong><p class="muted">Paste a Twitch channel above. Relio records it on its server,
      even after you close this tab, and turns every big moment into a finished Short with captions. Up to two channels at once.</p></div>`;
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
      <div class="live-clips-head"><h3>Shorts</h3><span id="live-count" class="muted small"></span></div><div id="live-clips"></div>`;
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
  const own = clips.filter((c) => channel.ids.has(c.session_id) && c.short);
  const ready = own.filter((c) => c.short.state === 'ready');
  view.querySelector('#live-count').textContent = ready.length ? `${ready.length} ready · kept for 2 days` : '';
  const problem = current.detail ? `<p class="error">${esc(current.detail)}</p>` : '';
  const list = view.querySelector('#live-clips');
  const changed = setHtml(list, problem + (own.length === 0
    ? `<p class="muted small">${active ? 'No Shorts yet. Each spike becomes a finished Short with captions about a minute later.' : 'No Shorts.'}</p>`
    : `<div class="live-short-grid">${own.map((c) => {
      const s = c.short;
      const poster = s.state === 'ready' ? `<img src="${esc(s.poster)}" alt="" loading="lazy"><span class="play" aria-hidden="true">▶</span>`
        : `<span class="live-short-wait">${s.state === 'making' ? '<span class="spinner" aria-hidden="true"></span>Making the Short…' : 'This Short couldn’t be made.'}</span>`;
      return `<button class="live-short" data-live-play="${c.id}" ${s.state === 'ready' ? '' : 'disabled'} aria-label="Play ${esc(s.title ?? c.why)}">
        <span class="live-short-poster">${poster}</span>
        <strong>${esc(s.title ?? c.why)}</strong><span class="muted small">${clock(Date.parse(c.at))} · ${esc(c.why)}${s.state === 'ready' ? ` · ${Math.round(c.duration)} s` : ''}</span></button>`;
    }).join('')}</div>`));
  if (changed) for (const button of list.querySelectorAll('[data-live-play]')) button.addEventListener('click', () => play(clips.find((c) => c.id === button.dataset.livePlay)));
  drawGraph();
}

/** Deletes a recording with its Shorts after asking; stops it first if it is still recording. Right-click or Delete on its tab. */
async function remove(login) {
  const channel = channels.find((c) => c.login === login);
  if (!channel) return;
  const row = channel.row;
  const own = clips.filter((c) => channel.ids.has(c.session_id));
  if (!confirm(`Delete ${row.login}${ACTIVE.includes(row.state) ? ' and stop recording it' : ''}? Its ${own.length} ${own.length === 1 ? 'Short' : 'Shorts'} are deleted too. This can't be undone.`)) return;
  const client = db();
  // Clips from before Shorts were made on the server sit in the person's cloud space; those go through Relio's server.
  const stored = own.map((c) => c.media_id).filter((m) => m?.startsWith('live-'));
  if (stored.length) {
    const token = (await client.auth.getSession()).data.session?.access_token;
    await fetch('/api/video?action=delete', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaIds: stored }) }).catch(() => {});
  }
  const { error } = await client.from('live_sessions').delete().in('id', [...channel.ids]);
  if (error) return notice('That recording could not be deleted. Please try again.');
  notice('');
  if (selected === login) { selected = null; shownChannel = null; }
  await refresh();
}

const GUIDE = [
  ['Paste a Twitch channel', 'Copy a link like <strong>twitch.tv/name</strong>, paste it in the box at the top and press <strong>Start recording</strong>. Relio records the stream on its own server, so you can close this tab or your laptop. Up to two channels at once.'],
  ['Watch the moments come in', 'The graph shows the last five minutes: <span style="color:#34c759">green</span> is the voice, <span style="color:#ff9f0a">orange</span> is chat, <span style="color:#ff453a">red</span> is hype. When the stream suddenly gets much louder or chat explodes, that is a big moment. Point at the graph to see any second.'],
  ['Shorts make themselves', 'About a minute after a big moment, a finished Short appears under the graph: the best 15–60 seconds, captions that follow every word, a layout for the stream (camera above the game, or the streamer full screen) and the Relio watermark. Weak moments and repeats are skipped.'],
  ['Watch, download, tidy up', 'Click a Short to play it, then <strong>Download</strong> to post it anywhere. Shorts are kept for two days. Right-click a channel tab to delete it with its Shorts, or press <strong>Stop recording</strong> to stop. A channel that stays offline for 30 minutes stops by itself.'],
];

/** The Live guide: four steps in a window over the page. Opens by itself the first time, and from "How it works". */
function guide() {
  const dialog = document.createElement('dialog');
  dialog.className = 'live-watch live-guide';
  let step = 0;
  const show = () => {
    const [title, text] = GUIDE[step];
    dialog.innerHTML = `<div class="live-watch-head"><span class="eyebrow">Live clipping · ${step + 1} of ${GUIDE.length}</span><button class="link" data-close aria-label="Close">✕</button></div>
      <div class="tour-bar" aria-hidden="true"><div style="width:${Math.round(((step + 1) / GUIDE.length) * 100)}%"></div></div>
      <h2>${title}</h2><p>${text}</p>
      <div class="row between">${step ? '<button class="button ghost" data-back>Back</button>' : '<span></span>'}
        <button class="button primary" data-next>${step === GUIDE.length - 1 ? 'Start' : 'Next'}</button></div>`;
    dialog.querySelector('[data-next]').focus();
  };
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close]')) return dialog.close();
    if (event.target.closest('[data-back]')) { step--; show(); }
    if (event.target.closest('[data-next]')) {
      if (step === GUIDE.length - 1) { dialog.close(); host?.querySelector('#live-url')?.focus(); } else { step++; show(); }
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  show();
  dialog.showModal();
}

/** A window over the page that plays the Short, with a download button. Closes with ×, Escape or a click outside. */
function play(clip) {
  const dialog = document.createElement('dialog');
  dialog.className = 'live-watch';
  dialog.innerHTML = `<div class="live-watch-head"><strong>${esc(clip.short.title)}</strong><button class="link" data-close aria-label="Close">✕</button></div>
    <video src="${esc(clip.short.video)}" poster="${esc(clip.short.poster)}" controls autoplay playsinline></video>
    <div class="row between"><span class="muted small">${clock(Date.parse(clip.at))} · ${esc(clip.why)} · ${Math.round(clip.duration)} s</span>
      <button class="button primary" data-download>Download</button></div>`;
  document.body.append(dialog);
  // The video lives on another site, where a plain download link only opens it: fetch it and save it under its title.
  dialog.querySelector('[data-download]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Downloading…';
    try {
      const blob = await (await fetch(clip.short.video)).blob();
      const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${clip.short.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Relio Short'}.mp4` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      button.textContent = 'Downloaded';
    } catch {
      button.textContent = 'Download failed · try again';
      button.disabled = false;
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target.closest('[data-close]')) dialog.close(); });
  dialog.showModal();
}

/** Three lines over the last five minutes, each scaled to its own range, plus a red marker at every clip. */
function drawGraph() {
  const canvas = host?.querySelector('#live-graph');
  if (!canvas) return;
  const current = channels.find((c) => c.login === selected)?.row;
  const ratio = devicePixelRatio || 1, width = canvas.clientWidth, height = 160;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);
  // The drawn graph comes from the page's history of seconds, continuous from oldest to newest.
  let graph = current?.graph;
  if (graph?.loud?.length && history.login === current.login && history.seconds.size) {
    const keys = [...history.seconds.keys()];
    const first = Math.min(...keys), last = Math.max(...keys);
    const loud = [], chatList = [], hype = [];
    for (let second = first, previous = null; second <= last; second++) {
      const value = history.seconds.get(second) ?? previous ?? { loud: 0, chat: 0, hype: 0 };
      loud.push(value.loud); chatList.push(value.chat); hype.push(value.hype);
      previous = value;
    }
    graph = { start: first * 1000, loud, chat: chatList, hype };
  }
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
  const dataEnd = graph.start + (graph.loud.length - 1) * 1000;
  const live = ACTIVE.includes(current?.state) && lag !== null;
  const span = 300, end = live ? Math.min(dataEnd, Date.now() - lag) : dataEnd, from = end - span * 1000;
  const xOf = (ms) => ((ms - from) / (span * 1000)) * width;
  const pad = 8, yOf = (v) => height - pad - v * (height - pad * 2);
  // The chat scale follows the busiest second on screen, eased, so the orange line never jumps when a peak scrolls away.
  const visible = graph.chat.filter((_, i) => graph.start + i * 1000 >= from);
  chatScale = chatScale === null ? Math.max(3, ...visible) : chatScale * 0.95 + Math.max(3, ...visible) * 0.05;
  const chatMax = chatScale;
  // A second with no measured sound (a late piece, a skipped ad) comes as 0: it keeps the last real level instead of dipping.
  let level = 0;
  const loud = graph.loud.map((v) => (v > 0 ? (level = v) : level));
  // Chat comes in bursts: a 3-second average reads as a line, not a comb.
  const chat = graph.chat.map((_, i) => (graph.chat[i - 1] ?? graph.chat[i]) / 3 + graph.chat[i] / 3 + (graph.chat[i + 1] ?? graph.chat[i]) / 3);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  for (const [key, values] of [['loud', loud], ['chat', chat.map((n) => n / chatMax)], ['hype', graph.hype]]) {
    ctx.strokeStyle = COLORS[key];
    ctx.lineWidth = key === 'hype' ? 2.5 : 1.5;
    ctx.beginPath();
    // A smooth curve through the midpoints between seconds.
    const points = values.map((v, i) => [xOf(graph.start + i * 1000), yOf(v)]);
    ctx.moveTo(...points[0]);
    for (let i = 1; i < points.length; i++) {
      const [px, py] = points[i - 1], [x, y] = points[i];
      ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
    }
    ctx.lineTo(...points.at(-1));
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = COLORS.hype;
  const ids = channels.find((c) => c.login === selected)?.ids ?? new Set();
  for (const clip of clips.filter((c) => ids.has(c.session_id))) {
    const x = xOf(Date.parse(clip.at));
    if (x < 0 || x > width) continue;
    ctx.globalAlpha = 0.25; ctx.fillRect(x - 1, 0, 2, height); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, 8, 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(128,128,128,.9)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('−5 min', 4, height - 4);
  ctx.fillText('now', width - 26, height - 4);
  ctx.fillText(`chat max ${Math.round(chatMax)}/s`, width - 110, 14);
  plotted = { graph, xOf, yOf, chatMax, loud, chat };
  if (hoverX !== null) readout(ctx, width, height, current);
}

/** The second under the pointer: a guide line, a dot on each line, and its numbers in a small box. */
function readout(ctx, width, height, current) {
  const { graph, xOf, yOf, chatMax, loud, chat } = plotted;
  const step = xOf(graph.start + 1000) - xOf(graph.start);
  const index = Math.max(0, Math.min(graph.loud.length - 1, Math.round((hoverX - xOf(graph.start)) / step)));
  const at = graph.start + index * 1000, x = xOf(at);
  if (x < 0 || x > width) return;
  ctx.strokeStyle = 'rgba(128,128,128,.7)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, height); ctx.stroke();
  ctx.setLineDash([]);
  const values = { loud: loud[index], chat: chat[index] / chatMax, hype: graph.hype[index] };
  for (const key of ['loud', 'chat', 'hype']) {
    ctx.fillStyle = COLORS[key];
    ctx.beginPath(); ctx.arc(x, yOf(values[key]), 4.5, 0, Math.PI * 2); ctx.fill();
  }
  const ids = channels.find((c) => c.login === selected)?.ids ?? new Set();
  const clip = clips.find((c) => ids.has(c.session_id) && Math.abs(Date.parse(c.at) - at) <= 2000);
  const tip = host.querySelector('#live-tip');
  tip.innerHTML = `<strong class="mono">${clock(at)}</strong>
    <span><i style="background:${COLORS.loud}"></i>Voice ${Math.round(loud[index] * 100)}%</span>
    <span><i style="background:${COLORS.chat}"></i>Chat ${graph.chat[index]} msg/s</span>
    <span><i style="background:${COLORS.hype}"></i>Hype ${Math.round(graph.hype[index] * 100)}%${graph.hype[index] >= 0.5 ? ' · spike' : ''}</span>
    ${clip ? `<span class="tip-clip">● Clip: ${esc(clip.why)}</span>` : ''}`;
  tip.hidden = false;
  // Beside the guide line, flipped to the left near the right edge.
  const left = x + 14 + tip.offsetWidth > width ? x - 14 - tip.offsetWidth : x + 14;
  tip.style.left = `${Math.max(0, left)}px`;
}
