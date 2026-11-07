// Videos in the account's cloud storage (Cloudflare R2, through the site's /api/video). The server keeps the keys and the per-account
// cap; the browser only gets short-lived links for its own videos. When a video doesn't fit, the server names the oldest videos that
// would have to go, and nothing is removed unless the person agrees.

/** kind: 'unavailable' (not set up on the server), 'too_big' (bigger than the whole cap), 'declined' (the person kept the older
 * videos), 'later' (couldn't ask, or the list changed: try again later), or 'failed'. `evicted` lists videos already removed. */
export class CloudVideoError extends Error {
  constructor(kind, message, evicted = []) { super(message); this.kind = kind; this.evicted = evicted; }
}

async function api(action, body, token, signal) {
  let response;
  try {
    response = await fetch(`/api/video?action=${action}`, {
      method: 'POST', signal, body: JSON.stringify(body ?? {}),
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CloudVideoError('failed', 'Cloud storage can’t be reached right now.');
  }
  const data = await response.json().catch(() => ({}));
  // No keys on the server (503), or no such function at all (a plain 404 page): nothing to retry until it is set up.
  if (response.status === 503 || (response.status === 404 && !data.error)) {
    throw new CloudVideoError('unavailable', data.error || 'Cloud video storage isn’t set up on the server yet.');
  }
  return { status: response.status, data };
}

/** Sends the file to a signed link with upload progress (fetch can't report it). */
function put(url, file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new CloudVideoError('failed', `The upload failed (HTTP ${request.status}).`)));
    request.onerror = () => reject(new CloudVideoError('failed', 'The upload was interrupted.'));
    signal?.addEventListener('abort', () => { request.abort(); reject(signal.reason); }, { once: true });
    request.send(file);
  });
}

/**
 * Stores `file` as `media`'s video. When there isn't room, `askRoom(evict, cap)` is asked: true deletes those oldest videos and
 * goes on, false keeps them (the video stays on this device), null means it can't ask now. Resolves with { bytes, evicted }.
 */
export async function uploadVideo({ token, media, file, askRoom, onProgress, signal }) {
  let { status, data } = await api('upload', { mediaId: media.id, bytes: file.size }, token, signal);
  if (status === 413) throw new CloudVideoError('too_big', data.error);
  if (status === 200 && data.already) return { bytes: file.size, evicted: [], already: true };
  if (status === 409 && data.needsRoom) {
    const answer = await askRoom(data.evict, data.cap);
    if (answer === null) throw new CloudVideoError('later', 'Waiting to ask about cloud space.');
    if (!answer) throw new CloudVideoError('declined', 'Kept the older videos; this one stays on this device.');
    ({ status, data } = await api('upload', { mediaId: media.id, bytes: file.size, confirm: true, evict: data.evict.map((v) => v.mediaId) }, token, signal));
    if (status === 409) throw new CloudVideoError('later', 'Your cloud videos changed meanwhile; asking again shortly.');
  }
  if (status !== 200) throw new CloudVideoError('failed', data.error || `Cloud storage answered ${status}.`);
  const evicted = data.evicted ?? [];
  try {
    await put(data.url, file, onProgress, signal);
  } catch (error) {
    if (error instanceof CloudVideoError) error.evicted = evicted;
    throw error;
  }
  const done = await api('finish', { mediaId: media.id }, token, signal);
  if (done.status === 413) throw new CloudVideoError('too_big', done.data.error, evicted);
  if (done.status !== 200) throw new CloudVideoError('failed', done.data.error || `Cloud storage answered ${done.status}.`, evicted);
  return { bytes: done.data.bytes, evicted };
}

const CHUNK = 8 * 1024 * 1024, PARALLEL = 6, PIECE_ATTEMPTS = 3;
/** A reply that retrying can't fix (not a partial-content answer, or a 403 for an expired link). */
const isPermanent = (error) => /HTTP (401|403|404)/.test(error.message);

/** Byte ranges that cover `size` bytes, each at most CHUNK long. */
export function chunkRanges(size, chunk = CHUNK) {
  const ranges = [];
  for (let start = 0; start < size; start += chunk) ranges.push({ start, end: Math.min(size, start + chunk) - 1 });
  return ranges;
}

/** The stored video as a Blob. Large videos come in parallel byte ranges (several connections at once), which is much faster than
 * one stream; anything unexpected falls back to a single download. Progress covers the bytes received so far. */
export async function downloadVideo({ token, mediaId, type, size, onProgress, signal }) {
  const { status, data } = await api('download', { mediaId }, token, signal);
  if (status !== 200) throw new CloudVideoError('failed', data.error || `Cloud storage answered ${status}.`);
  const ranges = size > CHUNK ? chunkRanges(size) : [];
  if (ranges.length > 1) {
    const parts = new Array(ranges.length);
    const started = Date.now();
    let received = 0;
    // One piece at a time, each retried on its own: a dropped connection repeats only that piece, never the whole video.
    const fetchPart = async (index) => {
      const { start, end } = ranges[index];
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await fetch(data.url, { headers: { Range: `bytes=${start}-${end}` }, signal });
          if (response.status !== 206) throw new CloudVideoError('failed', `The video could not be downloaded (HTTP ${response.status}).`);
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength !== end - start + 1) throw new CloudVideoError('failed', 'The download was cut short.');
          parts[index] = buffer;
          received += buffer.byteLength;
          const seconds = (Date.now() - started) / 1000 || 1;
          onProgress?.(received / size, { bytesPerSecond: received / seconds, remainingSeconds: (size - received) / (received / seconds) });
          return;
        } catch (error) {
          if (signal?.aborted || attempt >= PIECE_ATTEMPTS || (error instanceof CloudVideoError && isPermanent(error))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
        }
      }
    };
    let next = 0;
    const worker = async () => { while (next < ranges.length) await fetchPart(next++); };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, ranges.length) }, worker));
    return new Blob(parts, { type });
  }
  const response = await fetch(data.url, { signal });
  if (!response.ok) throw new CloudVideoError('failed', `The video could not be downloaded (HTTP ${response.status}).`);
  const total = Number(response.headers.get('Content-Length')) || 0;
  const reader = response.body.getReader(), pieces = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push(value);
    received += value.length;
    onProgress?.(total ? Math.min(1, received / total) : 0);
  }
  return new Blob(pieces, { type });
}

export async function removeVideos({ token, mediaIds }) {
  if (!mediaIds.length) return;
  const { status, data } = await api('delete', { mediaIds }, token);
  if (status !== 200) throw new CloudVideoError('failed', data.error || `Cloud storage answered ${status}.`);
}

/** Removes every video of the account, before the account itself is deleted. */
export async function removeAllVideos({ token }) {
  const { status, data } = await api('purge', {}, token);
  if (status !== 200) throw new CloudVideoError('failed', data.error || `Cloud storage answered ${status}.`);
}

/** { used, cap, videos } for Settings. */
export async function cloudUsage({ token }) {
  const { status, data } = await api('usage', {}, token);
  if (status !== 200) throw new CloudVideoError('failed', data.error || `Cloud storage answered ${status}.`);
  return data;
}
