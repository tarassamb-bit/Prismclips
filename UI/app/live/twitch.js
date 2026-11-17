// Twitch links and HLS playlists: shared by the Live screen (channel links) and the watcher server (recording).
// shortcut: uses Twitch's own web client id and unofficial playback API; Twitch can change or block it at any time.
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const LOGIN = /^[a-z0-9_]{3,25}$/;

/** The channel name from "twitch.tv/name", "https://www.twitch.tv/name/..." or just "name"; null when it isn't one. */
export function parseLogin(text) {
  const value = String(text || '').trim();
  if (LOGIN.test(value.toLowerCase())) return value.toLowerCase();
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`); } catch { return null; }
  if (!/^(www\.|m\.)?twitch\.tv$/i.test(url.hostname)) return null;
  const name = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
  return LOGIN.test(name) && !['videos', 'directory', 'settings', 'p', 'search'].includes(name) ? name : null;
}

/** The variants of a master playlist as { url, height, fps, bandwidth }, best first. */
export function parseMaster(text) {
  const lines = text.split('\n');
  const variants = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) return;
    const url = lines.slice(i + 1).find((l) => l.startsWith('http'));
    const height = Number(line.match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? 0);
    if (url) variants.push({ url, height, fps: Number(line.match(/FRAME-RATE=([\d.]+)/)?.[1] ?? 30), bandwidth: Number(line.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0) });
  });
  return variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

/** The variant to record: the best up to 720p (small enough to keep 30 minutes), or the smallest when all are bigger. */
export function pickVariant(variants) {
  return variants.find((v) => v.height > 0 && v.height <= 720) ?? variants.at(-1) ?? null;
}

/** A media playlist's header file (fMP4 streams only) and its stream pieces as { sequence, url, duration, at }.
 * Only pieces labeled "live" are kept: Twitch labels the ads it stitches in differently, and those never become clips. */
export function parseMedia(text) {
  const lines = text.split('\n').map((l) => l.trim());
  let sequence = Number(lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.split(':')[1] ?? 0);
  const init = lines.find((l) => l.startsWith('#EXT-X-MAP:'))?.match(/URI="([^"]+)"/)?.[1] ?? null;
  const pieces = [];
  let at = null, duration = 0, title = '';
  for (const line of lines) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) at = Date.parse(line.slice(25));
    else if (line.startsWith('#EXTINF:')) { const [d, ...t] = line.slice(8).split(','); duration = Number(d); title = t.join(','); }
    else if (line.startsWith('http')) {
      if (title === 'live' && duration > 0) pieces.push({ sequence, url: line, duration, at });
      sequence += 1;
      at = at === null ? null : at + duration * 1000;
    }
  }
  return { init, pieces, ended: lines.includes('#EXT-X-ENDLIST') };
}
