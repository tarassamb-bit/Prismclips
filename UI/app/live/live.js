// The Live screen: the Relio server records Twitch channels (watcher/), and this screen shows one at a time like Twitch does:
// chat on the left, the stream on the right, a graph of the last five minutes underneath (green voice, orange chat, red hype,
// with a marker for every clip), and the finished Shorts the server made from each spike, which play in a window over the page.
import { parseChannel, PLATFORMS } from './twitch.js';

const COLORS = { loud: '#34c759', chat: '#ff9f0a', hype: '#ff453a' };
const ACTIVE = ['starting', 'recording', 'offline'];
const STATE_TEXT = { starting: 'Starting…', recording: 'Recording', offline: 'Offline · waiting for the stream', stopped: 'Stopped', ended: 'Ended', error: 'Stopped' };
let host = null, db = null, polling = null;
let rows = [], clips = [], channels = [], selected = null, shownChannel = null, platform = 'twitch', typing = 0;
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

/** Stops what the recording screen runs in the background (updates, the graph, the typing prefix). */
function unmount() { clearInterval(polling); cancelAnimationFrame(frame); clearTimeout(typing); host = null; }

/** Live's home, like Home for projects: a card to start a recording and the recordings of the last two days, each opening
 * the recording screen through `open(key)` (null for a new one; "name" for Twitch, "kick/name" for Kick). */
export async function mountLiveHome(element, dbGetter, open) {
  unmount();
  const since = new Date(Date.now() - 2 * 86400_000).toISOString();
  const [sessionRows, clipRows, limits] = await Promise.all([
    dbGetter().from('live_sessions').select('id,login,platform,state,created').gte('created', since).order('created', { ascending: false }),
    dbGetter().from('live_clips').select('session_id,at,short').gte('created', since).order('at', { ascending: false }),
    PLANS_ON ? dbGetter().rpc('my_live_limits') : { error: true },
  ]);
  if (!element.isConnected) return;
  const all = sessionRows.data ?? [], ready = (clipRows.data ?? []).filter((c) => c.short?.state === 'ready');
  const key = (r) => (r.platform === 'kick' ? `kick/${r.login}` : r.login);
  // One card per channel: the newest recording's state, and every Short of its recordings.
  const cards = [...new Set(all.map(key))].map((k) => {
    const sessions = all.filter((r) => key(r) === k), ids = new Set(sessions.map((r) => r.id));
    return { key: k, row: sessions[0], shorts: ready.filter((c) => ids.has(c.session_id)) };
  });
  const when = (iso) => {
    const d = new Date(iso), today = new Date().toDateString() === d.toDateString();
    return `${today ? 'today' : 'yesterday'} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };
  const card = ({ key: k, row, shorts }) => {
    const on = ACTIVE.includes(row.state), poster = shorts[0]?.short.poster;
    const badge = row.state === 'recording' ? '<span class="live-badge on">LIVE</span>' : on ? '<span class="live-badge">Waiting</span>' : '';
    return `<div class="project-card live-card"><button class="open" data-live-open="${esc(k)}">
        <div class="poster">${poster ? `<img alt="" src="${esc(poster)}">` : `<span class="live-card-empty">${on ? 'Shorts appear here' : 'No Shorts'}</span>`}${badge}</div>
        <strong class="p-title">${esc(row.login)}${row.platform === 'kick' ? '<span class="live-site">Kick</span>' : ''}</strong>
        <span class="muted small">${shorts.length} ${shorts.length === 1 ? 'Short' : 'Shorts'} · ${on ? 'recording since' : 'started'} ${when(row.created)}</span></button></div>`;
  };
  const hours = !limits.error && limits.data?.[0];
  element.innerHTML = `<section class="dashboard">
    <button class="start-card" data-live-open="">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2"/></svg>
      <span class="start-text"><strong>Start a live recording</strong><span>Paste a Twitch or Kick channel. Relio records it and turns each big moment into a Short.</span></span>
      <span class="start-arrow" aria-hidden="true">→</span></button>
    <div class="row between"><h2>Recordings</h2>${hours ? `<a class="muted small live-home-hours" href="/app/settings/plan">${hours.hours_used.toFixed(1)} of ${Math.round(hours.hours_allowed)} Live hours used this month</a>` : ''}</div>
    ${cards.length ? `<div class="grid">${cards.map(card).join('')}</div>`
      : '<div class="empty"><strong>Your recordings will appear here</strong><span class="muted">Start a live recording, and its Shorts show up here for two days.</span></div>'}
  </section>`;
  for (const button of element.querySelectorAll('[data-live-open]')) button.addEventListener('click', () => open(button.dataset.liveOpen || null));
}

/** Shows the recording screen in `element`; `dbGetter()` gives the Supabase client. `channel` picks the tab to show
 * ("name" or "kick/name"; null for a new recording), and `home()` goes back to Live's home. */
export function mountLive(element, dbGetter, channel = null, home = null) {
  unmount();
  host = element;
  db = dbGetter;
  shownChannel = null;
  selected = channel;
  host.innerHTML = `<section class="live-screen">
    ${home ? '<button class="link back-home" id="live-home">← Live</button>' : ''}
    <div class="live-top">
      <div class="live-start">
        <h2 class="live-hero">Clip a live stream</h2>
        <p class="live-lede">Relio records a Twitch channel on its server, even with this tab closed, and turns each big moment into a Short with captions.</p>
        <form id="live-form" class="live-form">
          <div class="live-field"><button type="button" class="live-prefix" id="live-prefix" title="Switch between Twitch and Kick">twitch.tv/</button>
            <input id="live-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="channel name or link" aria-label="Twitch or Kick channel name or link"></div>
          <button class="button primary" type="submit">Start recording</button></form>
        <p id="live-notice" class="error small" role="alert" hidden></p>
      </div>
      <aside id="live-hours" class="live-hours" hidden></aside>
    </div>
    <div id="live-tabs" class="live-tabs" role="tablist"></div>
    <div id="live-view"></div>
  </section>`;
  host.querySelector('#live-home')?.addEventListener('click', () => home());
  if (!channel) host.querySelector('#live-url').focus();
  // The site in front of the name types itself out and deletes, Twitch then Kick, while the field is empty. Typing keeps
  // the one showing, a pasted link picks its own, and clicking it switches.
  const input = host.querySelector('#live-url'), prefix = host.querySelector('#live-prefix');
  platform = 'twitch';
  const order = Object.keys(PLATFORMS);
  const show = (name) => { platform = name; prefix.textContent = PLATFORMS[name].prefix; };
  const still = () => input.value || document.activeElement === input || matchMedia('(prefers-reduced-motion: reduce)').matches;
  clearTimeout(typing);
  let shown = PLATFORMS.twitch.prefix.length, dir = -1, at = 0;
  const step = () => {
    if (!host?.isConnected) return;
    if (still()) { show(platform); typing = setTimeout(step, 400); return; }
    const text = PLATFORMS[order[at]].prefix;
    shown += dir;
    prefix.textContent = text.slice(0, shown) || '\u200b';
    if (dir < 0 && shown === 0) { at = (at + 1) % order.length; platform = order[at]; dir = 1; typing = setTimeout(step, 250); }
    else if (dir > 0 && shown === PLATFORMS[order[at]].prefix.length) { dir = -1; typing = setTimeout(step, 2200); }
    else typing = setTimeout(step, dir > 0 ? 80 : 45);
  };
  typing = setTimeout(step, 2200);
  prefix.addEventListener('click', () => { show(order[(order.indexOf(platform) + 1) % order.length]); at = order.indexOf(platform); shown = PLATFORMS[platform].prefix.length; dir = -1; input.focus(); });
  // A pasted link becomes just the channel name, since the field already shows the site.
  input.addEventListener('input', () => {
    const channel = /[/.:]/.test(input.value) && parseChannel(input.value, platform);
    if (channel) { input.value = channel.login; show(channel.platform); at = order.indexOf(platform); shown = PLATFORMS[platform].prefix.length; }
  });
  host.querySelector('#live-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = host.querySelector('#live-url');
    if (await start(input.value)) input.value = '';
  });
  // The tour runs by itself the first time someone opens Live on this device.
  tourDone = new Set();
  if (tourStep() === null) setTourStep(0);
  clearInterval(polling);
  refresh();
  polling = setInterval(() => (host?.isConnected ? refresh() : clearInterval(polling)), 2500);
  addEventListener('resize', drawGraph);
  cancelAnimationFrame(frame);
  let last = 0;
  const tick = (time) => {
    if (!host?.isConnected) { tourHint(); return; }
    tourHint();
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

// shortcut: plans and packs show on localhost only (the Paddle sandbox experiment), like the rest of the app.
const PLANS_ON = ['localhost', '127.0.0.1'].includes(location.hostname);
let hoursAt = 0;

/** "3.2 of 100 Live hours used this month", with a way to buy more; read every half minute. */
async function showHours() {
  const line = host?.querySelector('#live-hours');
  if (!PLANS_ON || !line || Date.now() - hoursAt < 30_000) return;
  hoursAt = Date.now();
  const { data, error } = await db().rpc('my_live_limits');
  const limits = !error && data?.[0];
  if (!limits) return;
  const out = limits.hours_used >= limits.hours_allowed;
  const percent = Math.min(100, limits.hours_used / Math.max(limits.hours_allowed, 0.01) * 100);
  line.hidden = false;
  line.innerHTML = `<span class="live-hours-label">Live hours this month</span>
    <span class="live-hours-num"><b>${limits.hours_used.toFixed(1)}</b> of ${Math.round(limits.hours_allowed)} h used</span>
    <div class="meter ${percent >= 85 ? 'warn' : ''}"><div style="width:${percent}%"></div></div>
    <span class="small ${out ? 'error' : 'muted'}">${out ? 'Used up. Buy more hours to keep recording.' : `Record up to ${limits.channels} ${limits.channels === 1 ? 'channel' : 'channels'} at once`}</span>
    <span class="live-hours-actions"><a class="button ${out ? 'primary' : 'ghost'} small" href="/pricing?pack=live" data-pack="live">Buy 10 hours</a><a class="link small" href="/app/settings/plan">Your plan</a></span>`;
}

async function start(text) {
  const channel = parseChannel(text, platform);
  if (!channel) return notice('Paste a Twitch or Kick channel, like twitch.tv/name or kick.com/name.');
  const { login } = channel;
  notice('');
  const { data, error } = await db().from('live_sessions').insert({ login, platform: channel.platform }).select('id').single();
  if (error) {
    hoursAt = 0;
    showHours();
    return notice(/channels? at once|already recording|Live hours/.test(error.message) ? error.message : 'The recording could not be started. Please try again.');
  }
  selected = channel.platform === 'kick' ? `kick/${login}` : login;
  await refresh();
  return true;
}

/** Recordings of the last day and their clips; the graph only for the channel on screen. */
async function refresh() {
  const client = db?.();
  if (!client) return;
  const since = new Date(Date.now() - 86400_000).toISOString();
  const [sessionRows, clipRows] = await Promise.all([
    client.from('live_sessions').select('id,login,platform,state,detail,buffered,chat,created').gte('created', since).order('created', { ascending: false }),
    client.from('live_clips').select('id,session_id,at,why,duration,short,media_id').gte('created', since).order('at', { ascending: false }),
  ]);
  if (sessionRows.error || clipRows.error) return;
  // Everything new is gathered first and swapped in at once: the graph is never drawn from a list that has no graph yet.
  const nextRows = sessionRows.data;
  // One tab per channel: rows come newest first, so the first row of a channel is the one shown.
  // A channel is its site and name ("kick/name"; Twitch ones keep just the name): the same name on both is two channels.
  const key = (r) => (r.platform === 'kick' ? `kick/${r.login}` : r.login);
  const nextChannels = [...new Set(nextRows.map(key))].map((login) => ({ login, row: nextRows.find((r) => key(r) === login), ids: new Set(nextRows.filter((r) => key(r) === login).map((r) => r.id)) }));
  let nextSelected = selected;
  // Nothing chosen is a new recording; a chosen channel that disappeared (deleted elsewhere) gives way to another.
  if (nextSelected && !nextChannels.some((c) => c.login === nextSelected)) nextSelected = (nextChannels.find((c) => ACTIVE.includes(c.row.state)) ?? nextChannels[0])?.login ?? null;
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
  showHours();
  clips = clipRows.data;
  channels = nextChannels;
  selected = nextSelected;
  if (channels.some((c) => ACTIVE.includes(c.row.state))) tourDid(0);
  if (clips.some((c) => c.short?.state === 'ready')) tourDid(2);
  render();
}

/** The empty screen's picture: a calm stretch of stream, one spike in voice, chat and hype, and the Short it becomes. */
function demoGraph() {
  const line = (base, spike, wobble, seed) => Array.from({ length: 61 }, (_, i) => {
    const near = Math.exp(-((i - 40) ** 2) / 18);
    const y = 120 - base - spike * near - wobble * (Math.sin(i * 1.7 + seed) + Math.sin(i * 0.6 + seed * 2)) / 2;
    return `${i * 8},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="live-demo" viewBox="0 0 640 150" role="img" aria-label="A stream graph with one spike that becomes a Short">
    <line class="live-demo-base" x1="0" y1="120" x2="480" y2="120"/>
    <rect class="live-demo-zone" x="290" y="10" width="78" height="110" rx="8"/>
    <polyline points="${line(18, 14, 6, 3)}" style="stroke:${COLORS.chat}"/>
    <polyline points="${line(10, 70, 4, 7)}" style="stroke:${COLORS.hype}"/>
    <polyline points="${line(34, 52, 9, 1)}" style="stroke:${COLORS.loud}"/>
    <circle cx="320" cy="20" r="6" fill="${COLORS.hype}"/>
    <path class="live-demo-arrow" d="M378 64 C 430 64, 450 64, 506 64" marker-end="url(#live-demo-head)"/>
    <defs><marker id="live-demo-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" class="live-demo-head"/></marker></defs>
    <g transform="translate(528 4)"><rect class="live-demo-short" width="80" height="142" rx="12"/>
      <rect class="live-demo-cam" x="8" y="8" width="64" height="40" rx="6"/><rect class="live-demo-game" x="8" y="54" width="64" height="80" rx="6"/>
      <rect x="16" y="104" width="48" height="8" rx="3" fill="#fff"/><rect x="26" y="116" width="28" height="8" rx="3" fill="#ffd60a"/></g>
  </svg>`;
}

function render() {
  if (!host?.isConnected) return;
  host.querySelector('.live-screen')?.classList.toggle('is-empty', !channels.some((c) => c.login === selected));
  const tabs = host.querySelector('#live-tabs');
  if (setHtml(tabs, channels.map((c) => `<button role="tab" aria-selected="${c.login === selected}" class="live-tab ${c.login === selected ? 'on' : ''}" data-live-tab="${esc(c.login)}" title="${esc(STATE_TEXT[c.row.state])} · right-click to delete">
    <span class="dot ${c.row.state === 'recording' ? 'on-air' : ACTIVE.includes(c.row.state) ? 'waiting' : ''}" aria-hidden="true"></span>${esc(c.row.login)}${c.row.platform === 'kick' ? '<span class="live-site">Kick</span>' : ''}</button>`).join(''))) for (const tab of tabs.querySelectorAll('[data-live-tab]')) {
    tab.addEventListener('click', () => { selected = tab.dataset.liveTab; render(); refresh(); });
    tab.addEventListener('contextmenu', (event) => { event.preventDefault(); remove(tab.dataset.liveTab); });
    tab.addEventListener('keydown', (event) => { if (event.key === 'Delete' || event.key === 'Backspace') remove(tab.dataset.liveTab); });
  }
  const view = host.querySelector('#live-view');
  const channel = channels.find((c) => c.login === selected);
  const current = channel?.row;
  if (!current) {
    shownChannel = null;
    view.innerHTML = `<div class="live-empty">${demoGraph()}
      <ol class="live-steps">
        <li><strong>Paste a channel</strong><span>Recording starts as soon as the stream is live, and waits while it's offline.</span></li>
        <li><strong>Relio follows every second</strong><span>Voice, chat and hype are measured as the stream runs.</span></li>
        <li><strong>Shorts appear here</strong><span>Each spike becomes a 9:16 Short with captions, about a minute later.</span></li>
      </ol></div>`;
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
        ${current.platform === 'kick'
          ? `<iframe class="live-chat" title="Kick chat" src="https://kick.com/popout/${encodeURIComponent(current.login)}/chat"></iframe>
        <iframe class="live-player" title="Kick stream" allowfullscreen src="https://player.kick.com/${encodeURIComponent(current.login)}?muted=true&autoplay=true"></iframe>`
          : `<iframe class="live-chat" title="Twitch chat" src="https://www.twitch.tv/embed/${encodeURIComponent(current.login)}/chat?parent=${parent}${dark ? '&darkpopout' : ''}"></iframe>
        <iframe class="live-player" title="Twitch stream" allowfullscreen src="https://player.twitch.tv/?channel=${encodeURIComponent(current.login)}&parent=${parent}&muted=true"></iframe>`}
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
    canvas.addEventListener('pointermove', (event) => { hoverX = event.clientX - canvas.getBoundingClientRect().left; drawGraph(); tourDid(1); });
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
  // Only finished Shorts show: one being made appears once it's ready.
  const own = clips.filter((c) => channel.ids.has(c.session_id) && c.short?.state === 'ready');
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

// The Live tour: a ring around the real thing to use and a bubble next to it. Each step moves on only once it's done.
const TOUR = [
  { target: '#live-form', text: 'Paste a Twitch channel here, like <strong>twitch.tv/name</strong>, and press <strong>Start recording</strong>. Relio records it on its server, even after you close this tab.' },
  { target: '#live-graph', text: 'This graph shows the last five minutes: <span style="color:#34c759">green</span> voice, <span style="color:#ff9f0a">orange</span> chat, <span style="color:#ff453a">red</span> hype. Point at it to see any second.' },
  { target: '#live-clips', text: 'When the stream gets much louder or chat explodes, a finished Short with captions appears here about a minute later. Waiting for a big moment…' },
  { target: '.live-short:not(:disabled)', text: 'Your first Short is ready. Click it to watch it, and download it from there.' },
];
const TOUR_KEY = 'relio-live-tour';
const tourStep = () => { try { return localStorage.getItem(TOUR_KEY); } catch { return 'done'; } };
const setTourStep = (value) => { try { localStorage.setItem(TOUR_KEY, String(value)); } catch { /* storage blocked: the tour ends with this page */ } };
let tourDone = new Set();

/** Marks what the person just did; the tour moves on when it was the current step's task. */
function tourDid(step) {
  tourDone.add(step);
  const now = Number(tourStep());
  if (Number.isInteger(now) && tourDone.has(now)) setTourStep(now + 1 >= TOUR.length ? 'done' : now + 1);
}

/** Draws (or removes) the ring and bubble for the current step. Runs on every animation frame while Live is open. */
function tourHint() {
  let ring = document.getElementById('live-ring'), bubble = document.getElementById('live-bubble');
  const step = Number(tourStep());
  const hint = Number.isInteger(step) && host?.isConnected ? TOUR[step] : null;
  // Steps already done earlier (a channel was already recording) count right away.
  if (hint && tourDone.has(step)) { tourDid(step); return; }
  const target = hint && host.querySelector(hint.target);
  const blockers = [...document.querySelectorAll('.live-block')];
  if (!hint || !target || !target.getBoundingClientRect().width || document.querySelector('dialog[open]')) { ring?.remove(); bubble?.remove(); blockers.forEach((b) => b.remove()); return; }
  if (!bubble) {
    // Four dark panels around the highlighted part: the rest of the page is dimmed and can't be clicked until the step is done.
    document.body.insertAdjacentHTML('beforeend', '<div class="live-block" aria-hidden="true"></div>'.repeat(4)
      + '<div id="live-ring" class="tour-ring live-spot" aria-hidden="true"></div><div id="live-bubble" class="tour-bubble" role="status"></div>');
    ring = document.getElementById('live-ring'); bubble = document.getElementById('live-bubble');
  }
  const html = `<p class="eyebrow">Live clipping · step ${step + 1} of ${TOUR.length}</p><div class="tour-bar" aria-hidden="true"><div style="width:${Math.round(((step + 1) / TOUR.length) * 100)}%"></div></div>
    <p>${hint.text}</p><div class="row between"><button class="link" data-tour-skip>Skip tour</button></div>`;
  if (bubble.dataset.html !== html) {
    bubble.dataset.html = html;
    bubble.innerHTML = html;
    bubble.querySelector('[data-tour-skip]').addEventListener('click', () => { setTourStep('done'); tourHint(); });
    target.scrollIntoView({ block: 'nearest' });
  }
  const rect = target.getBoundingClientRect();
  Object.assign(ring.style, { left: `${rect.left - 6}px`, top: `${rect.top - 6}px`, width: `${rect.width + 12}px`, height: `${rect.height + 12}px` });
  const [top, bottom, left_, right] = document.querySelectorAll('.live-block');
  const hole = { l: rect.left - 6, t: rect.top - 6, r: rect.right + 6, b: rect.bottom + 6 };
  Object.assign(top.style, { left: '0', top: '0', width: '100vw', height: `${Math.max(0, hole.t)}px` });
  Object.assign(bottom.style, { left: '0', top: `${hole.b}px`, width: '100vw', height: `${Math.max(0, innerHeight - hole.b)}px` });
  Object.assign(left_.style, { left: '0', top: `${hole.t}px`, width: `${Math.max(0, hole.l)}px`, height: `${hole.b - hole.t}px` });
  Object.assign(right.style, { left: `${hole.r}px`, top: `${hole.t}px`, width: `${Math.max(0, innerWidth - hole.r)}px`, height: `${hole.b - hole.t}px` });
  // Below the target when there is room, otherwise above it; always inside the window. The arrow points at the target's middle.
  const width = bubble.offsetWidth, height = bubble.offsetHeight, gap = 16;
  const below = rect.bottom + gap + height < innerHeight;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), innerWidth - width - 8);
  bubble.dataset.side = below ? 'below' : 'above';
  bubble.style.setProperty('--arrow-x', `${Math.min(Math.max(18, rect.left + rect.width / 2 - left), width - 18)}px`);
  Object.assign(bubble.style, { left: `${left}px`, top: `${below ? rect.bottom + gap : Math.max(8, rect.top - gap - height)}px` });
}

/** A window over the page that plays the Short, with a download button. Closes with ×, Escape or a click outside. */
function play(clip) {
  tourDid(3);
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
  // null is a stretch the server didn't record (a restart): it stays a gap in every line.
  let level = 0;
  const loud = graph.loud.map((v) => (v === null ? null : v > 0 ? (level = v) : level));
  // Chat comes in bursts: a 3-second average reads as a line, not a comb.
  const chat = graph.chat.map((v, i) => (v === null ? null : (graph.chat[i - 1] ?? v) / 3 + v / 3 + (graph.chat[i + 1] ?? v) / 3));
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  for (const [key, values] of [['loud', loud], ['chat', chat.map((n) => (n === null ? null : n / chatMax))], ['hype', graph.hype]]) {
    ctx.strokeStyle = COLORS[key];
    ctx.lineWidth = key === 'hype' ? 2.5 : 1.5;
    ctx.beginPath();
    // A smooth curve through the midpoints between seconds.
    const points = values.map((v, i) => (v === null ? null : [xOf(graph.start + i * 1000), yOf(v)]));
    points.forEach((point, i) => {
      if (!point) return;
      const previous = points[i - 1];
      if (!previous) { ctx.moveTo(...point); return; }
      ctx.quadraticCurveTo(previous[0], previous[1], (previous[0] + point[0]) / 2, (previous[1] + point[1]) / 2);
      if (!points[i + 1]) ctx.lineTo(...point);
    });
    ctx.stroke();
  }
  ctx.restore();
  // Stretches of 10 s or more with no stream sound: a Twitch ad break (chat goes on) or a server restart (nothing at all).
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  for (let i = 0, run = null; i <= loud.length; i++) {
    if (loud[i] === null && i < loud.length) { run ??= i; continue; }
    if (run !== null && i - run >= 10) {
      const x1 = Math.max(0, xOf(graph.start + run * 1000)), x2 = Math.min(width, xOf(graph.start + (i - 1) * 1000));
      if (x2 > x1) {
        ctx.fillStyle = 'rgba(128,128,128,.12)'; ctx.fillRect(x1, 0, x2 - x1, height);
        ctx.fillStyle = 'rgba(128,128,128,.9)'; if (x2 - x1 > 70) ctx.fillText(graph.chat[run] === null ? 'Not recorded' : 'Twitch ad', x1 + 6, 14);
      }
    }
    run = null;
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
  // Nothing to read over a gap the server didn't record.
  if (x < 0 || x > width || loud[index] === null) return;
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
