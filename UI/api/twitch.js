// Vercel function: fetches one Twitch channel's master playlist for live clipping. Twitch serves that one file only to
// twitch.tv pages; everything after it (stream playlists, video pieces) the browser loads from Twitch directly.
// The playback token comes from the browser, so it carries the viewer's own access. Signed-in users only: not an open proxy.
//   POST { login, sig, token }   the master playlist text (application/vnd.apple.mpegurl) | 404 offline
const { HttpError, fail, getUser } = require('./_lib');

const LOGIN = /^[a-z0-9_]{3,25}$/, SIG = /^[0-9a-f]{20,128}$/;

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 20_000) throw new HttpError(413, 'Request too large.'); }
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'The request is not valid JSON.'); }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    await getUser(req);
    const { login, sig, token } = await readJson(req);
    if (!LOGIN.test(login || '') || !SIG.test(sig || '') || typeof token !== 'string' || token.length > 8000) throw new HttpError(400, 'Invalid channel.');
    try { JSON.parse(token); } catch { throw new HttpError(400, 'Invalid channel.'); }
    const url = `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?sig=${sig}&token=${encodeURIComponent(token)}&allow_source=true&p=${Math.floor(Math.random() * 1e6)}`;
    let response, text;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      text = await response.text();
    } catch {
      throw new HttpError(502, 'Twitch didn’t respond. Please try again.');
    }
    if (response.status === 404) throw new HttpError(404, 'offline');
    if (!response.ok || !text.startsWith('#EXTM3U')) throw new HttpError(502, `Twitch answered ${response.status}.`);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(text);
  } catch (error) {
    fail(res, error);
  }
};
