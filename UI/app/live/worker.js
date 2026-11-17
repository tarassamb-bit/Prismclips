// Records one live Twitch channel while the tab stays open: fetches each new stream piece, keeps the last 30 minutes,
// measures loudness, counts chat, and reports likely moments. Runs in a worker so a background tab keeps recording.
// The page looks up the stream's playlist address (that needs the signed-in session) and hands it over.
//   in:  { type: 'start', session, login }  |  { type: 'playlist', url }  |  { type: 'offline' }  |  { type: 'stop' }
//   out: { type: 'need-playlist' }  (at start, and whenever the address stops working or the stream ends)
//        { type: 'status', state: 'connecting'|'live'|'offline'|'stopped', buffered (s), chat (bool) }
//        { type: 'moment', at (ms), why }  |  { type: 'error', message }
import { parseMedia } from './twitch.js';
import { Detector } from './detector.js';
import * as store from './pieces.js';

const lib = import('../../vendor/mediabunny-1.61.5.min.mjs');
let session = null, login = null, stopped = false, socket = null;
const detector = new Detector();
let startedAt = null, lastSequence = -1, oldest = null, chatOn = false;
const second = (ms) => Math.floor((ms - startedAt) / 1000);
const status = (state) => postMessage({ type: 'status', state, buffered: oldest === null ? 0 : Math.round((Date.now() - oldest) / 1000), chat: chatOn });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let playlistUrl = null;
self.onmessage = ({ data }) => {
  if (data.type === 'start' && !session) { session = data.session; login = data.login; status('connecting'); postMessage({ type: 'need-playlist' }); listenToChat(); }
  if (data.type === 'playlist' && !stopped) { const first = playlistUrl === null; playlistUrl = data.url; if (first) follow().catch((e) => postMessage({ type: 'error', message: e.message })); }
  if (data.type === 'offline') status('offline');
  if (data.type === 'stop') { stopped = true; socket?.close(); status('stopped'); }
};

/** Follows the current playlist address; asks the page for a new one when it stops working or the stream ends. */
async function follow() {
  const inits = new Map();
  let failures = 0;
  while (!stopped) {
    const url = playlistUrl;
    const response = await fetch(url).catch(() => null);
    if (!response?.ok) {
      if (++failures === 3) postMessage({ type: 'need-playlist' });
      // Wait for a fresh address before trying again.
      while (!stopped && failures >= 3 && playlistUrl === url) await wait(1000);
      if (playlistUrl !== url) failures = 0;
      else await wait(2000);
      continue;
    }
    failures = 0;
    const playlist = parseMedia(await response.text());
    for (const piece of playlist.pieces.filter((p) => p.sequence > lastSequence)) {
      if (stopped) break;
      lastSequence = piece.sequence;
      await record(piece, playlist.init, inits).catch(() => {});
    }
    status('live');
    if (playlist.ended) { failures = 3; postMessage({ type: 'need-playlist' }); }
    await wait(2000);
  }
}

async function record(piece, initUrl, inits) {
  if (initUrl && !inits.has(initUrl)) inits.set(initUrl, await (await fetch(initUrl)).arrayBuffer());
  const init = initUrl ? inits.get(initUrl) : null;
  const response = await fetch(piece.url);
  if (!response.ok) return;
  const bytes = await response.arrayBuffer();
  const at = piece.at ?? Date.now();
  startedAt ??= at;
  oldest ??= at;
  await store.put({ session, sequence: piece.sequence, at, duration: piece.duration, init, bytes });
  // Keep 30 minutes: everything older than that many pieces back goes.
  const keep = Math.ceil(store.KEEP_SECONDS / piece.duration);
  if (piece.sequence % 15 === 0) {
    await store.dropBefore(session, piece.sequence - keep);
    oldest = Math.max(oldest, at - store.KEEP_SECONDS * 1000);
  }
  await measure(init, bytes, at);
  const moment = detector.check(second(at + piece.duration * 1000));
  if (moment) postMessage({ type: 'moment', at: startedAt + moment.at * 1000, why: moment.why });
}

/** Loudness of each second of the piece, from its decoded sound. */
async function measure(init, bytes, at) {
  const { Input, ALL_FORMATS, BlobSource, AudioSampleSink } = await lib;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob(init ? [init, bytes] : [bytes])) });
  const track = await input.getPrimaryAudioTrack();
  if (!track) return;
  const sums = new Map();
  let first = null;
  for await (const sample of new AudioSampleSink(track).samples()) {
    try {
      first ??= sample.timestamp;
      const data = new Float32Array(sample.numberOfFrames);
      sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
      for (let i = 0; i < data.length; i += 4) {
        const s = second(at + (sample.timestamp - first + i / sample.sampleRate) * 1000);
        const entry = sums.get(s) ?? [0, 0];
        entry[0] += data[i] * data[i]; entry[1]++;
        sums.set(s, entry);
      }
    } finally { sample.close(); }
  }
  for (const [s, [sum, n]] of sums) detector.loudness(s, 10 * Math.log10(Math.max(1e-10, sum / n)));
}

/** Anonymous read-only Twitch chat: only the number of messages per second is used. */
function listenToChat() {
  if (stopped) return;
  socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  socket.onopen = () => { socket.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`); socket.send(`JOIN #${login}`); chatOn = true; };
  socket.onmessage = ({ data }) => {
    for (const line of String(data).split('\r\n')) {
      if (line.startsWith('PING')) socket.send('PONG :tmi.twitch.tv');
      else if (line.includes(' PRIVMSG ') && startedAt !== null) detector.message(second(Date.now()));
    }
  };
  socket.onclose = () => { chatOn = false; if (!stopped) setTimeout(listenToChat, 10_000); };
}
