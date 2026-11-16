// Vercel function: copies one YouTube video's picture or sound into the signed-in user's cloud storage, so the browser can
// fetch it from there. YouTube's own stream links only work from the computer that asked for them, so the browser can't use them.
// The browser asks twice (part=video, then part=audio, each with its own time limit), joins the two files into one MP4, and
// deletes both parts again. Each call looks the video up itself: stream links never leave the server.
//   POST ?part=video|audio  { url }   { mediaId, bytes, type, title, duration }
const https = require('https');
const { HttpError, send, fail, getUser } = require('./_lib');
const { link, listObjects } = require('./_r2');

const UA = 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)';
const CLIENT = { clientName: 'IOS', clientVersion: '20.11.6', deviceMake: 'Apple', deviceModel: 'iPhone10,4', osName: 'iOS', osVersion: '16.7.7.20H330', hl: 'en', gl: 'US', userAgent: UA };
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHUNK = 8 * 1024 * 1024, PARALLEL = 4, MAX_HEIGHT = 1080;
const BLOCKED = 'YouTube blocked this download. Download the video and upload it instead.';
const capBytes = () => Math.max(1, Number(process.env.R2_CAP_MB) || 1000) * 1_000_000;

/** The 11-character video ID from any usual YouTube link, or null. Only the ID is used afterwards, never the link itself. */
function parseVideoId(text) {
  let url;
  try { url = new URL(String(text || '').trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const id = url.hostname.toLowerCase().endsWith('youtu.be') ? parts[0]
    : parts[0] === 'watch' || parts.length === 0 ? url.searchParams.get('v')
    : ['shorts', 'live', 'embed', 'v'].includes(parts[0]) ? parts[1] : null;
  return VIDEO_ID.test(id || '') ? id : null;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 10_000) throw new HttpError(413, 'Request too large.'); }
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'The request is not valid JSON.'); }
}

async function lookUp(id) {
  let response, body;
  try {
    response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'X-Youtube-Client-Name': '5', 'X-Youtube-Client-Version': CLIENT.clientVersion },
      body: JSON.stringify({ videoId: id, contentCheckOk: true, racyCheckOk: true, context: { client: CLIENT } }),
      signal: AbortSignal.timeout(15000),
    });
    body = await response.json();
  } catch {
    throw new HttpError(502, 'YouTube didn’t respond. Please try again.');
  }
  const status = body?.playabilityStatus?.status;
  if (!response.ok || status !== 'OK') {
    console.error(`YouTube refused ${id}: HTTP ${response.status}, ${status}, ${body?.playabilityStatus?.reason}`);
    // Private, removed or age-restricted videos say why; anything else (the bot check, an unknown status) reads as blocked.
    const reason = body?.playabilityStatus?.reason;
    throw new HttpError(422, status === 'LOGIN_REQUIRED' || !reason ? BLOCKED : `YouTube says: ${reason}`);
  }
  if (body.videoDetails?.isLive || body.videoDetails?.isLiveContent && !body.streamingData?.adaptiveFormats?.some((f) => f.contentLength)) {
    throw new HttpError(422, 'Live streams can’t be used. Try again once the stream has ended.');
  }
  return body;
}

/** The streams to copy: the best H.264 picture up to 1080p whose size, with the sound, fits in `room` bytes. */
function pickFormats(formats, room) {
  const sized = formats.filter((f) => f.url && Number(f.contentLength) > 0);
  const audio = sized.filter((f) => f.mimeType?.startsWith('audio/mp4')).sort((a, b) => b.bitrate - a.bitrate)[0];
  if (!audio) return null;
  const video = sized
    .filter((f) => f.mimeType?.startsWith('video/mp4') && f.mimeType.includes('avc1') && f.height <= MAX_HEIGHT)
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate)
    .find((f) => Number(f.contentLength) + Number(audio.contentLength) <= room);
  return video ? { video, audio } : { tooBig: true };
}

async function fetchRange(url, start, end) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${url}&range=${start}-${end}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
      if (response.status === 403) throw new HttpError(422, BLOCKED);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length !== end - start + 1) throw new Error('short read');
      return buffer;
    } catch (error) {
      if (error instanceof HttpError || attempt >= 3) throw error instanceof HttpError ? error : new HttpError(502, 'The download from YouTube broke off. Please try again.');
    }
  }
}

/** Streams the format into R2 in order, a few pieces ahead at a time, without holding the whole file. */
function copyToR2(format, key) {
  const size = Number(format.contentLength);
  return new Promise((resolve, reject) => {
    const put = https.request(link('PUT', key), { method: 'PUT', headers: { 'Content-Length': size } }, (response) => {
      response.resume();
      response.on('end', () => (response.statusCode === 200 ? resolve() : reject(new HttpError(502, `Cloud storage returned ${response.statusCode}.`))));
    });
    put.on('error', () => reject(new HttpError(502, 'Cloud storage didn’t respond. Please try again.')));
    (async () => {
      const starts = [];
      for (let start = 0; start < size; start += CHUNK) starts.push(start);
      const pending = starts.slice(0, PARALLEL).map((start) => fetchRange(format.url, start, Math.min(size, start + CHUNK) - 1));
      for (let i = 0; i < starts.length; i++) {
        const buffer = await pending[i];
        const next = starts[i + PARALLEL];
        if (next !== undefined) pending.push(fetchRange(format.url, next, Math.min(size, next + CHUNK) - 1));
        if (!put.write(buffer)) await new Promise((done) => put.once('drain', done));
      }
      put.end();
    })().catch((error) => { put.destroy(); reject(error); });
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((name) => !process.env[name]);
    if (missing.length) throw new HttpError(503, 'Cloud video storage isn’t set up on the server yet.');
    const user = await getUser(req);
    const part = new URL(req.url, 'http://localhost').searchParams.get('part');
    if (part !== 'video' && part !== 'audio') throw new HttpError(400, 'Unknown part.');
    const id = parseVideoId((await readJson(req)).url);
    if (!id) throw new HttpError(400, 'Paste a link to a YouTube video, like https://www.youtube.com/watch?v=…');

    // Video IDs can hold "_", which the storage IDs don't allow, so the parts are named after the ID in hex.
    const base = `yt-${Buffer.from(id).toString('hex')}`;
    const mediaId = `${base}-${part === 'video' ? 'v' : 'a'}`;
    // Room left under the cap, not counting this video's own parts from an earlier try.
    const stored = await listObjects(`${user.id}/`);
    const room = capBytes() - stored.filter((o) => !o.key.startsWith(`${user.id}/${base}-`)).reduce((sum, o) => sum + o.bytes, 0);

    const info = await lookUp(id);
    const picked = pickFormats(info.streamingData?.adaptiveFormats || [], room);
    if (!picked) throw new HttpError(422, BLOCKED);
    if (picked.tooBig) throw new HttpError(413, 'This video doesn’t fit in your cloud space. Delete older videos in Settings, or upload a shorter one.');
    const format = picked[part];
    await copyToR2(format, `${user.id}/${mediaId}`);
    send(res, 200, {
      mediaId, bytes: Number(format.contentLength), type: format.mimeType.split(';')[0],
      title: info.videoDetails?.title || 'YouTube video', duration: Number(info.videoDetails?.lengthSeconds) || 0,
    });
  } catch (error) {
    fail(res, error);
  }
};

module.exports.parseVideoId = parseVideoId;
module.exports.pickFormats = pickFormats;
