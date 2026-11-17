// Offline check of the Twitch link and playlist parsing: node UI/app/live/twitch.test.mjs
import assert from 'node:assert/strict';
import { parseLogin, parseMaster, pickVariant, parseMedia } from './twitch.js';

for (const [input, login] of [['https://www.twitch.tv/Some_Streamer', 'some_streamer'], ['twitch.tv/abc123', 'abc123'], ['m.twitch.tv/xqc/clips', 'xqc'],
  ['  ninja  ', 'ninja'], ['https://evil.com/xqc', null], ['https://twitch.tv.evil.com/xqc', null], ['https://www.twitch.tv/directory', null], ['', null], ['a b', null]]) {
  assert.equal(parseLogin(input), login, input);
}

const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8042999,RESOLUTION=1920x1080,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="1080p60",FRAME-RATE=60.000
https://a/1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3322199,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://a/720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1327200,RESOLUTION=852x480,FRAME-RATE=30.000
https://a/480.m3u8`;
const variants = parseMaster(master);
assert.deepEqual(variants.map((v) => v.height), [1080, 720, 480]);
assert.equal(pickVariant(variants).url, 'https://a/720.m3u8');
assert.equal(pickVariant([{ url: 'x', height: 1080 }]).url, 'x');

const media = parseMedia(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="https://a/init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-11-17T07:35:17.000Z
#EXTINF:2.000,live
https://a/100.mp4
#EXT-X-PROGRAM-DATE-TIME:2026-11-17T07:35:19.000Z
#EXTINF:2.000,Amazon|123
https://a/ad.mp4
#EXTINF:2.000,live
https://a/102.mp4`);
assert.equal(media.init, 'https://a/init.mp4');
assert.deepEqual(media.pieces.map((p) => p.sequence), [100, 102], 'ads skipped, numbering kept');
assert.equal(media.pieces[1].at, Date.parse('2026-11-17T07:35:21.000Z'), 'time carried past the ad');
assert.equal(media.ended, false);
console.log('twitch: ok');
