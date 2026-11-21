// Relio's live watcher: records the Twitch and Kick channels people asked for (live_sessions), keeps the last 15 minutes of each,
// spots likely moments by loudness and chat (no AI), and turns each one into a finished Short (shorts.mjs) kept on this
// machine's disk, with a live_clips row the Live screen shows. Runs on one always-on machine; needs ffmpeg, Node 22+, and
//   SUPABASE_SECRET_KEY, OPENROUTER_API_KEY, PUBLIC_URL (this machine's public address for port 8080), and the R2_* keys
//   (only to delete clips older versions stored in cloud space).
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMaster, pickVariant, parseMedia } from './lib/twitch.js';
import { Detector } from './lib/detector.js';
import { ffmpeg, makeShort, removeShort, onDisk, serve } from './shorts.mjs';

const { deleteObject } = createRequire(import.meta.url)('./lib/_r2.cjs');
// Shorts per person per day (each costs an AI call), and the disk kept for Shorts on this 6 GB machine.
const DISK_FOR_SHORTS = 3.5e9;
// Used until the account's plan limits are read (and if they can't be): the old fixed limits.
const FALLBACK_LIMITS = { channels: 2, hours_allowed: Infinity, hours_used: 0, max_recording_hours: 8, shorts_per_day: 30 };
const PUBLIC_URL = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
// Accounts with no daily Shorts limit (the owner's), comma-separated user ids.
const UNLIMITED = new Set((process.env.UNLIMITED_USERS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
const SUPABASE = 'https://isdplhahgggundbohmlr.supabase.co/rest/v1';
const KEY = process.env.SUPABASE_SECRET_KEY;
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const KEEP = 15 * 60, BEFORE = 60, AFTER = 30;
const MAX_STREAMS = Number(process.env.MAX_STREAMS) || 5;
const OFFLINE_GIVE_UP = 30 * 60 * 1000, CLIP_DAYS = 2, STOPPED_DAYS = 1;
const DATA = path.join(tmpdir(), 'relio-live');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

async function db(pathAndQuery, init = {}) {
  const response = await fetch(`${SUPABASE}/${pathAndQuery}`, {
    ...init, signal: AbortSignal.timeout(15000),
    headers: { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...init.headers },
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.status === 204 ? null : response.json().catch(() => null);
}
const update = (id, fields) => db(`live_sessions?id=eq.${id}&state=in.(starting,recording,offline)`, { method: 'PATCH', body: JSON.stringify({ ...fields, updated: new Date().toISOString() }) });

async function playlistUrl(login) {
  const response = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST', headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ query: `{ user(login: "${login}") { stream { id } } streamPlaybackAccessToken(channelName: "${login}", params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }` }),
  });
  const data = (await response.json()).data;
  if (!data?.user) throw Object.assign(new Error(`There is no Twitch channel called “${login}”.`), { permanent: true });
  if (!data.user.stream) return null;
  const token = data.streamPlaybackAccessToken;
  const master = await fetch(`https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?sig=${token.signature}&token=${encodeURIComponent(token.value)}&allow_source=true&p=${Math.floor(Math.random() * 1e6)}`, { signal: AbortSignal.timeout(15000) });
  if (master.status === 404) return null;
  if (!master.ok) throw new Error(`Twitch answered ${master.status}.`);
  return pickVariant(parseMaster(await master.text()))?.url ?? null;
}

// shortcut: Kick's unofficial web API (channel info, guest chat pass); Kick can change or block it at any time.
const KICK_HEADERS = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', accept: 'application/json' };
async function kickChannel(login) {
  const response = await fetch(`https://kick.com/api/v2/channels/${login}`, { headers: KICK_HEADERS, signal: AbortSignal.timeout(15000) });
  if (response.status === 404) throw Object.assign(new Error(`There is no Kick channel called “${login}”.`), { permanent: true });
  if (!response.ok) throw new Error(`Kick answered ${response.status}.`);
  return response.json();
}

/** The stream's media playlist on Kick, null while the channel is offline. */
async function kickPlaylistUrl(login) {
  const channel = await kickChannel(login);
  if (!channel.livestream || !channel.playback_url) return null;
  const master = await fetch(channel.playback_url, { signal: AbortSignal.timeout(15000) });
  if (!master.ok) return null;
  return pickVariant(parseMaster(await master.text()))?.url ?? null;
}

class Recorder {
  constructor(row) {
    Object.assign(this, { id: row.id, user: row.user_id, login: row.login, platform: row.platform ?? 'twitch', stopped: false, socket: null, chatOn: false });
    this.dir = path.join(DATA, row.id);
    this.pieces = new Map();    // sequence -> { file, at, duration }
    this.inits = new Map();     // init url -> file
    this.detector = new Detector();
    this.startedAt = null; this.lastSequence = -1; this.offlineSince = null; this.began = Date.now();
    // Recorded time this run (seconds of stream kept), added to what the session had recorded before a restart.
    this.recordedBefore = 0; this.recordedNow = 0; this.limits = FALLBACK_LIMITS; this.limitsAt = 0;
    this.recentTitles = [];
  }

  second(ms) { return Math.floor((ms - this.startedAt) / 1000); }
  buffered() { const ats = [...this.pieces.values()].map((p) => p.at); return ats.length ? Math.round((Math.max(...ats) - Math.min(...ats)) / 1000) : 0; }

  async run() {
    await mkdir(this.dir, { recursive: true });
    // A note from an earlier run (a full day's Shorts, an older version's message) no longer applies.
    await update(this.id, { detail: null }).catch(() => {});
    // After a restart the graph carries on from the saved one instead of starting empty.
    const saved = (await db(`live_sessions?id=eq.${this.id}&select=graph,recorded_seconds`, { headers: { Prefer: '' } }).catch(() => null))?.[0];
    this.saved = saved?.graph ?? null;
    this.recordedBefore = saved?.recorded_seconds ?? 0;
    this.listenToChat();
    while (!this.stopped) {
      if (await this.overLimit()) return;
      let url;
      try { url = await (this.platform === 'kick' ? kickPlaylistUrl : playlistUrl)(this.login); }
      catch (error) {
        if (error.permanent) return this.finish('error', error.message);
        log(this.login, 'lookup failed', error.message);
        await wait(15_000);
        continue;
      }
      if (!url) {
        this.offlineSince ??= Date.now();
        if (Date.now() - this.offlineSince > OFFLINE_GIVE_UP) return this.finish('ended', 'The channel was offline for 30 minutes.');
        await update(this.id, { state: 'offline' }).catch(() => {});
        await wait(30_000);
        continue;
      }
      this.offlineSince = null;
      await this.follow(url);
    }
  }

  async follow(url) {
    for (let failures = 0; !this.stopped && failures < 3;) {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (!response?.ok) { failures++; await wait(2000); continue; }
      failures = 0;
      const playlist = parseMedia(await response.text());
      for (const piece of playlist.pieces.filter((p) => p.sequence > this.lastSequence)) {
        if (this.stopped) return;
        this.lastSequence = piece.sequence;
        await this.record(piece, playlist.init).catch((error) => log(this.login, 'piece failed', error.message));
      }
      await update(this.id, { state: 'recording', buffered: this.buffered(), chat: this.chatOn, graph: this.graph(), recorded_seconds: Math.round(this.recordedBefore + this.recordedNow) }).catch(() => {});
      if (await this.overLimit()) return;
      if (playlist.ended) return;
      await wait(2000);
    }
  }

  async record(piece, initUrl) {
    let init = null;
    if (initUrl) {
      if (!this.inits.has(initUrl)) {
        const file = path.join(this.dir, `init-${this.inits.size}.mp4`);
        await writeFile(file, Buffer.from(await (await fetch(initUrl)).arrayBuffer()));
        this.inits.set(initUrl, file);
      }
      init = this.inits.get(initUrl);
    }
    const response = await fetch(piece.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    const bytes = Buffer.from(await response.arrayBuffer());
    const file = path.join(this.dir, `${piece.sequence}.bin`);
    await writeFile(file, bytes);
    const at = piece.at ?? Date.now();
    this.startedAt ??= at;
    this.pieces.set(piece.sequence, { file, at, duration: piece.duration, init });
    this.recordedNow += piece.duration;
    for (const [sequence, old] of this.pieces) {
      if (old.at >= at - KEEP * 1000) break;
      this.pieces.delete(sequence);
      rm(old.file, { force: true }).catch(() => {});
    }
    await this.measure(init ? Buffer.concat([await readFile(init), bytes]) : bytes, at);
    const moment = this.detector.check(this.second(at + piece.duration * 1000));
    if (moment) {
      const momentAt = this.startedAt + moment.at * 1000;
      log(this.login, 'moment', moment.why);
      // The clip includes 30 s after the moment, so it is cut once those have arrived.
      setTimeout(() => this.clip(momentAt, moment.why).catch((error) => log(this.login, 'clip failed', error.message)), (AFTER + 8) * 1000);
    }
  }

  /** Loudness of each second, from the piece's sound decoded to 8 kHz mono. */
  async measure(input, at) {
    const pcm = await ffmpeg(['-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], input).catch(() => null);
    if (!pcm) return;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    for (let start = 0; start < samples.length; start += 8000) {
      let sum = 0;
      const end = Math.min(samples.length, start + 8000);
      for (let i = start; i < end; i++) sum += (samples[i] / 32768) ** 2;
      this.detector.loudness(this.second(at + start / 8), 10 * Math.log10(Math.max(1e-10, sum / (end - start))));
    }
  }

  async clip(momentAt, why) {
    if (this.stopped) return;
    const chosen = [...this.pieces.values()].filter((p) => p.at + p.duration * 1000 > momentAt - BEFORE * 1000 && p.at < momentAt + AFTER * 1000);
    if (chosen.length < 5) return;
    // fMP4 pieces after a header change can't be joined to earlier ones: keep the run that shares the last header.
    const header = chosen.at(-1).init;
    const run = header ? chosen.slice(chosen.findLastIndex((p) => p.init !== header) + 1) : chosen;
    const id = crypto.randomUUID();
    const joined = path.join(this.dir, `${id}.src`), out = path.join(this.dir, `${id}.mp4`);
    await writeFile(joined, Buffer.concat([...(header ? [await readFile(header)] : []), ...(await Promise.all(run.map((p) => readFile(p.file))))]));
    const rowId = crypto.randomUUID();
    const at = new Date(momentAt).toISOString();
    try {
      const today = new Date(new Date().toISOString().slice(0, 10)).toISOString();
      const perDay = this.limits.shorts_per_day;
      const made = UNLIMITED.has(this.user) ? [] : await db(`live_clips?user_id=eq.${this.user}&created=gte.${today}&select=id`, { headers: { Prefer: '' } });
      if (made.length >= perDay && !UNLIMITED.has(this.user)) {
        await update(this.id, { detail: `You reached today's ${perDay} live Shorts on your plan. Recording goes on; new Shorts start again tomorrow.` }).catch(() => {});
        return;
      }
      await ffmpeg(['-y', '-i', joined, '-c', 'copy', '-movflags', '+faststart', out]);
      const clipSeconds = run.reduce((sum, p) => sum + p.duration, 0);
      // The card shows "Making…" while the AI and ffmpeg work.
      await db('live_clips', { method: 'POST', body: JSON.stringify({ id: rowId, session_id: this.id, user_id: this.user, at, why, media_id: 'short', bytes: 0, duration: clipSeconds, short: { state: 'making' } }) });
      const momentInClip = (momentAt - run[0].at) / 1000;
      const short = await makeShort(out, clipSeconds, momentInClip, `${this.login} · ${why}`, this.recentTitles.slice(-6));
      if (short.skipped) {
        // Not worth a Short (or the same as a recent one): the card goes away again.
        await db(`live_clips?id=eq.${rowId}`, { method: 'DELETE' });
        log(this.login, 'skipped', short.repeat ? 'repeat' : `score ${short.score}`, short.title);
        return;
      }
      this.recentTitles.push(short.title);
      await db(`live_clips?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ bytes: short.bytes, duration: short.duration,
        short: { state: 'ready', id: short.id, title: short.title, video: `${PUBLIC_URL}/${short.id}.mp4`, poster: `${PUBLIC_URL}/${short.id}.jpg` } }) });
      log(this.login, 'short ready', short.title, short.layout, Math.round(short.bytes / 1e6), 'MB', short.duration, 's');
    } catch (error) {
      log(this.login, 'short failed', error.message);
      await db(`live_clips?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ short: { state: 'failed' } }) }).catch(() => {});
    } finally {
      rm(joined, { force: true }).catch(() => {});
      rm(out, { force: true }).catch(() => {});
    }
  }

  /** Anonymous read-only chat (Twitch or Kick): only the number of messages per second is used. */
  listenToChat() {
    if (this.stopped) return;
    if (this.platform === 'kick') return this.listenToKickChat().catch((error) => { log(this.login, 'chat failed', error.message); this.chatAgain(); });
    const socket = this.socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    socket.onopen = () => { socket.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`); socket.send(`JOIN #${this.login}`); this.chatOn = true; };
    socket.onmessage = ({ data }) => {
      for (const line of String(data).split('\r\n')) {
        if (line.startsWith('PING')) socket.send('PONG :tmi.twitch.tv');
        else if (line.includes(' PRIVMSG ') && this.startedAt !== null) this.detector.message(this.second(Date.now()));
      }
    };
    socket.onclose = () => { this.chatOn = false; if (!this.stopped) setTimeout(() => this.listenToChat(), 10_000); };
    socket.onerror = () => {};
  }

  chatAgain() { this.chatOn = false; if (!this.stopped) setTimeout(() => this.listenToChat(), 10_000); }

  /** Kick chat: a guest pass for Kick's realtime server, then the channel's chatroom. The pass lasts 45 minutes; the
   * server then closes the connection and a new pass is fetched. */
  async listenToKickChat() {
    const room = (await kickChannel(this.login)).chatroom?.id;
    const auth = await fetch('https://web.kick.com/api/v1/realtime/auth/connection', {
      method: 'POST', headers: { ...KICK_HEADERS, 'content-type': 'application/json', 'x-app-platform': 'web', referer: 'https://kick.com/' },
      body: JSON.stringify({ client_id: crypto.randomUUID() }), signal: AbortSignal.timeout(15000),
    });
    const token = (await auth.json().catch(() => null))?.data?.token;
    if (!room || !token) throw new Error(`Kick chat pass refused (${auth.status}).`);
    if (this.stopped) return;
    const socket = this.socket = new WebSocket('wss://realtime.us-east-1.platform.kick.com/connection/websocket');
    socket.onopen = () => {
      socket.send(JSON.stringify({ connect: { token, name: 'js' }, id: 1 }));
      socket.send(JSON.stringify({ subscribe: { channel: `chatrooms.${room}.v2` }, id: 2 }));
      this.chatOn = true;
    };
    socket.onmessage = ({ data }) => {
      for (const line of String(data).split('\n')) {
        if (line === '{}') socket.send('{}'); // the server's ping
        else if (line.includes('ChatMessageEvent') && this.startedAt !== null) this.detector.message(this.second(Date.now()));
      }
    };
    socket.onclose = () => this.chatAgain();
    socket.onerror = () => {};
  }

  /** The last five minutes for the Live screen's graph: per second, loudness 0–1, chat messages, and hype 0–1. */
  graph() {
    if (this.startedAt === null) return null;
    const now = this.second(Date.now()) - 1, from = Math.max(0, now - 300);
    const level = this.detector.level, chat = this.detector.chat;
    const mean = (list, a, b, gaps) => { let sum = 0, n = 0; for (let t = Math.max(0, a); t < b; t++) { if (list[t] !== undefined) { sum += list[t]; n++; } else if (gaps) n++; } return n ? sum / n : 0; };
    const loud = [], messages = [], hype = [];
    for (let t = from; t <= now; t++) {
      // A second with no stream sound measured (a Twitch ad break: those pieces are skipped) is null, drawn as a gap.
      const amp = level[t] === undefined ? 0 : mean(level, t - 1, t + 1, false);
      loud.push(amp > 0 ? Math.round(Math.min(1, Math.max(0, (20 * Math.log10(amp) + 60) / 60)) * 100) / 100 : null);
      messages.push(chat[t] ?? 0);
      const loudJump = mean(level, t - 6, t, false) / (mean(level, t - 180, t - 10, false) || Infinity) - 1;
      const chatJump = mean(chat, t - 8, t, true) / Math.max(0.5, mean(chat, t - 180, t - 10, true)) - 1;
      // 1.2 (120% up) is where a moment triggers; it sits at 0.5 on the graph.
      hype.push(Math.round(Math.min(1, Math.max(0, Math.max(loudJump, chatJump)) / 2.4) * 100) / 100);
    }
    return withSaved({ start: this.startedAt + from * 1000, loud, chat: messages, hype }, this.saved);
  }

  /** Reads the account's Live limits (once a minute) and stops the recording when the month's hours or the plan's longest
   * recording are used up. True when it stopped. The owner's accounts (UNLIMITED_USERS) have no limits. */
  async overLimit() {
    if (UNLIMITED.has(this.user)) return false;
    if (Date.now() - this.limitsAt > 60_000) {
      this.limitsAt = Date.now();
      const rows = await db('rpc/prism_live_limits', { method: 'POST', body: JSON.stringify({ p_user: this.user }), headers: { Prefer: '' } }).catch(() => null);
      if (rows?.[0]) this.limits = rows[0];
    }
    const { hours_allowed: allowed, hours_used: used, max_recording_hours: longest } = this.limits;
    if (used >= allowed) { await this.finish('ended', 'You used your Live hours for this month. Buy 10 more hours, or upgrade your plan.'); return true; }
    if (Date.now() - this.began > longest * 3600_000) { await this.finish('ended', `Stopped after ${longest} hours, your plan's longest recording.`); return true; }
    return false;
  }

  stop() { this.stopped = true; this.socket?.close(); rm(this.dir, { recursive: true, force: true }).catch(() => {}); }
  async finish(state, detail) { this.stop(); await update(this.id, { state, detail }).catch(() => {}); log(this.login, state, detail); }
}

/** The graph continued from the one saved before a restart: saved seconds fill the five minutes before this run's own data,
 * and the seconds between them (the restart) are null, drawn as a break. Graphs are { start (ms), loud, chat, hype }, one
 * value per second. */
export function withSaved(current, saved) {
  if (!saved?.loud?.length) return current;
  const savedEnd = saved.start + (saved.loud.length - 1) * 1000;
  const first = Math.max(saved.start, current.start + (current.loud.length - 1) * 1000 - 300_000);
  if (first >= current.start || savedEnd < first) return current;
  const out = { start: first, loud: [], chat: [], hype: [] };
  for (let at = first; at < current.start; at += 1000) {
    const i = Math.round((at - saved.start) / 1000), known = at <= savedEnd;
    out.loud.push(known ? saved.loud[i] : null); out.chat.push(known ? saved.chat[i] : null); out.hype.push(known ? saved.hype[i] : null);
  }
  for (const key of ['loud', 'chat', 'hype']) out[key].push(...current[key]);
  return out;
}

const running = new Map();

async function tick() {
  const rows = await db('live_sessions?state=in.(starting,recording,offline)&select=id,user_id,login,platform&order=created.asc', { headers: { Prefer: '' } });
  const wanted = new Set(rows.map((r) => r.id));
  for (const [id, recorder] of running) if (!wanted.has(id) || recorder.stopped) { recorder.stop(); running.delete(id); log(recorder.login, 'stopped'); }
  for (const row of rows) {
    if (running.has(row.id)) continue;
    if (running.size >= MAX_STREAMS) { await update(row.id, { state: 'error', detail: 'The live server is full right now. Try again later.' }); continue; }
    const recorder = new Recorder(row);
    running.set(row.id, recorder);
    log(row.login, 'starting');
    recorder.run().catch(async (error) => { log(row.login, 'crashed', error.message); await recorder.finish('error', 'Recording stopped unexpectedly.'); });
  }
}

/** Live clips are a starting point, not storage: after two days they and their videos go. */
async function cleanup() {
  // A recording is deleted a day after it stopped, with its Shorts (their rows cascade; the files go below as orphans).
  // `updated` is the watcher's last write, which comes every few seconds while it records: about when it stopped.
  const done = await db(`live_sessions?state=in.(stopped,ended,error)&updated=lt.${new Date(Date.now() - STOPPED_DAYS * 86400_000).toISOString()}&select=id,login&limit=200`, { headers: { Prefer: '' } });
  if (done.length) {
    await db(`live_sessions?id=in.(${done.map((r) => r.id).join(',')})`, { method: 'DELETE' });
    log('cleanup', done.length, 'stopped recordings');
  }
  const old = await db(`live_clips?created=lt.${new Date(Date.now() - CLIP_DAYS * 86400_000).toISOString()}&select=id,user_id,media_id,short&limit=200`, { headers: { Prefer: '' } });
  for (const clip of old) {
    if (clip.short?.id) await removeShort(clip.short.id);
    // Rows from before Shorts were made here point at a raw clip in the person's cloud space.
    else if (clip.media_id?.startsWith('live-')) await deleteObject(`${clip.user_id}/${clip.media_id}`).catch(() => {});
    await db(`live_clips?id=eq.${clip.id}`, { method: 'DELETE' });
  }
  // A Short left "making" by a restart, or one that failed, never shows: its row goes.
  await db(`live_clips?or=(short->>state.eq.failed,and(short->>state.eq.making,created.lt.${new Date(Date.now() - 15 * 60_000).toISOString()}))`, { method: 'DELETE' }).catch(() => {});
  // The disk is small: past the limit, the oldest Shorts go first, even before two days.
  let files = await onDisk();
  // Shorts of a recording the person deleted have no row anymore. Ten minutes' grace: a Short being made has no row id yet.
  const kept = new Set((await db('live_clips?short=not.is.null&select=short&limit=5000', { headers: { Prefer: '' } })).map((c) => c.short?.id));
  for (const file of files.filter((f) => !kept.has(f.id) && Date.now() - f.at > 600_000)) await removeShort(file.id);
  files = files.filter((f) => kept.has(f.id) || Date.now() - f.at <= 600_000);
  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  for (const file of files) {
    if (total <= DISK_FOR_SHORTS) break;
    await removeShort(file.id);
    await db(`live_clips?short->>id=eq.${file.id}`, { method: 'DELETE' }).catch(() => {});
    total -= file.bytes;
  }
  if (old.length) log('cleanup', old.length, 'old clips');
}

for (const name of ['SUPABASE_SECRET_KEY', 'OPENROUTER_API_KEY', 'PUBLIC_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
  if (!process.env[name]) { console.error(`Missing ${name}.`); process.exit(1); }
}
await rm(DATA, { recursive: true, force: true });
serve(8080);
log('watcher up, max', MAX_STREAMS, 'streams');
let lastCleanup = 0;
for (;;) {
  await tick().catch((error) => log('tick failed', error.message));
  if (Date.now() - lastCleanup > 600_000) { lastCleanup = Date.now(); await cleanup().catch((error) => log('cleanup failed', error.message)); }
  await wait(5000);
}
