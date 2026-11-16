// Offline check of the YouTube link parser and format choice: node UI/api/_youtube.test.js
const assert = require('node:assert/strict');
const { parseVideoId, pickFormats } = require('./youtube');

const id = 'dQw4w9W_-cQ';
for (const link of [`https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=42s`, `https://m.youtube.com/watch?v=${id}`,
  `https://youtu.be/${id}?si=abc`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}`, `  https://youtu.be/${id}  `]) {
  assert.equal(parseVideoId(link), id, link);
}
for (const link of ['', 'not a link', `https://evil.com/watch?v=${id}`, `https://youtube.com.evil.com/watch?v=${id}`, `javascript:alert(1)//youtu.be/${id}`,
  'https://www.youtube.com/watch?v=short', `https://www.youtube.com/channel/${id}`, `ftp://youtu.be/${id}`, `https://www.youtube.com/watch?v=${id}x`]) {
  assert.equal(parseVideoId(link), null, link);
}

const f = (itag, mimeType, height, contentLength, bitrate = 1) => ({ itag, mimeType, height, contentLength: String(contentLength), bitrate, url: 'u' });
const formats = [f(137, 'video/mp4; codecs="avc1"', 1080, 800), f(136, 'video/mp4; codecs="avc1"', 720, 300), f(248, 'video/webm; codecs="vp9"', 1080, 100),
  f(299, 'video/mp4; codecs="avc1"', 1440, 50), f(140, 'audio/mp4; codecs="mp4a"', 0, 50, 128), f(139, 'audio/mp4; codecs="mp4a"', 0, 20, 48)];
assert.equal(pickFormats(formats, 10_000).video.itag, 137);
assert.equal(pickFormats(formats, 10_000).audio.itag, 140);
assert.equal(pickFormats(formats, 400).video.itag, 136, 'steps down to fit');
assert.equal(pickFormats(formats, 100).tooBig, true);
assert.equal(pickFormats(formats.filter((x) => !x.mimeType.startsWith('audio')), 10_000), null);
console.log('youtube: ok');
