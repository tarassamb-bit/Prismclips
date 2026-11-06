// Vercel function: the signed-in user's videos in Cloudflare R2. The R2 keys stay on the server; the browser only gets short-lived
// links for its own videos, stored at <account id>/<video id>; the app uses the file's fingerprint as the id, so the same video is
// stored once however many projects use it. Each account has a hard cap (R2_CAP_MB, 1000 MB by default). When a
// new video doesn't fit, the answer names the oldest videos that would have to go; only when the person agrees are they deleted.
//   POST ?action=usage                                     { used, cap, videos: [{ mediaId, bytes, at }] }
//   POST ?action=upload   { mediaId, bytes, confirm, evict } { url, evicted } | { already } | 409 { needsRoom, evict } | 413 too big
//   POST ?action=finish   { mediaId }                       checks what arrived against the cap; removes it if over
//   POST ?action=download { mediaId }                       { url }
//   POST ?action=delete   { mediaIds }                      removes those videos
//   POST ?action=purge                                     removes every video of the account (before the account is deleted)
const { HttpError, send, fail, getUser } = require('./_lib');
const { link, listObjects, headObject, deleteObject } = require('./_r2');

const ID = /^[A-Za-z0-9-]{1,64}$/;
const capBytes = () => Math.max(1, Number(process.env.R2_CAP_MB) || 1000) * 1_000_000;
const sizeText = (bytes) => (bytes >= 1e9 ? `${Number((bytes / 1e9).toFixed(1))} GB` : `${Math.round(bytes / 1e6)} MB`);

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 100_000) throw new HttpError(413, 'Request too large.'); }
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'The request is not valid JSON.'); }
}

function videoId(value) {
  if (!ID.test(value || '')) throw new HttpError(400, 'Invalid video.');
  return value;
}

async function videosOf(userId) {
  return (await listObjects(`${userId}/`)).map((o) => ({ mediaId: o.key.slice(userId.length + 1), bytes: o.bytes, at: o.at }));
}

/** Oldest first, the videos that must go so `bytes` more fit under the cap. */
function toEvict(videos, bytes, cap) {
  let free = cap - videos.reduce((sum, v) => sum + v.bytes, 0);
  const evict = [];
  for (const video of [...videos].sort((a, b) => a.at.localeCompare(b.at))) {
    if (free >= bytes) break;
    evict.push(video);
    free += video.bytes;
  }
  return evict;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((name) => !process.env[name]);
    if (missing.length) throw new HttpError(503, 'Cloud video storage isn’t set up on the server yet.');
    const user = await getUser(req);
    const body = await readJson(req);
    const cap = capBytes();
    const key = (mediaId) => `${user.id}/${videoId(mediaId)}`;

    switch (new URL(req.url, 'http://localhost').searchParams.get('action')) {
      case 'usage': {
        const videos = await videosOf(user.id);
        return send(res, 200, { used: videos.reduce((sum, v) => sum + v.bytes, 0), cap, videos });
      }
      case 'upload': {
        const bytes = Number(body.bytes);
        if (!Number.isFinite(bytes) || bytes <= 0) throw new HttpError(400, 'Invalid size.');
        if (bytes > cap) return send(res, 413, { tooBig: true, error: `This video is bigger than your ${sizeText(cap)} of cloud space, so it stays on this device only.` });
        const mediaId = videoId(body.mediaId);
        const videos = await videosOf(user.id);
        // Already stored (the same file from another project): nothing to send.
        if (videos.some((v) => v.mediaId === mediaId && v.bytes === bytes)) return send(res, 200, { already: true, evicted: [] });
        // A video sent again replaces itself, so it doesn't count against its own room.
        const others = videos.filter((v) => v.mediaId !== mediaId);
        const evict = toEvict(others, bytes, cap);
        if (evict.length) {
          // Delete only what the person agreed to: if the list changed since they saw it, ask again.
          const agreed = new Set(Array.isArray(body.evict) ? body.evict : []);
          if (!body.confirm || !evict.every((v) => agreed.has(v.mediaId))) return send(res, 409, { needsRoom: true, evict, cap });
          for (const video of evict) await deleteObject(key(video.mediaId));
        }
        return send(res, 200, { url: link('PUT', key(mediaId)), evicted: evict.map((v) => v.mediaId) });
      }
      case 'finish': {
        // The link can't limit the size by itself, so what arrived is checked here: over the cap, it is removed again.
        const objectKey = key(body.mediaId);
        const bytes = await headObject(objectKey);
        if (bytes === null) throw new HttpError(404, 'The upload didn’t arrive.');
        const used = (await videosOf(user.id)).reduce((sum, v) => sum + v.bytes, 0);
        if (bytes > cap || used > cap) {
          await deleteObject(objectKey);
          return send(res, 413, { tooBig: true, error: 'That would go over your cloud space, so it was removed again.' });
        }
        return send(res, 200, { bytes });
      }
      case 'download': {
        const objectKey = key(body.mediaId);
        if ((await headObject(objectKey)) === null) throw new HttpError(404, 'This video isn’t in the cloud anymore.');
        return send(res, 200, { url: link('GET', objectKey) });
      }
      case 'delete': {
        const ids = Array.isArray(body.mediaIds) ? body.mediaIds.slice(0, 200) : [];
        for (const mediaId of ids) await deleteObject(key(mediaId));
        return send(res, 200, { deleted: ids.length });
      }
      case 'purge': {
        const videos = await videosOf(user.id);
        for (const video of videos) await deleteObject(key(video.mediaId));
        return send(res, 200, { deleted: videos.length });
      }
      default:
        throw new HttpError(400, 'Unknown action.');
    }
  } catch (error) {
    fail(res, error.status && !(error instanceof HttpError) ? new HttpError(error.status, error.message) : error);
  }
};

module.exports.toEvict = toEvict;
