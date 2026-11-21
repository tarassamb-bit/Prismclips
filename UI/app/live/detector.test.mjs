// Offline check of live moment detection: node UI/app/live/detector.test.mjs
import assert from 'node:assert/strict';
import { Detector } from './detector.js';

const quiet = new Detector();
for (let s = 0; s < 200; s++) quiet.loudness(s, -30);
for (let s = 0; s < 200; s++) assert.equal(quiet.check(s), null, 'steady sound is never a moment');

const loud = new Detector();
for (let s = 0; s < 200; s++) loud.loudness(s, s >= 194 ? -20 : -30);
const moment = loud.check(200);
assert.ok(moment && /louder/.test(moment.why), 'a 10 dB jump is a moment');
assert.equal(loud.check(210), null, 'cooldown');
assert.equal(new Detector().check(30), null, 'no moments in the first minute');

const chat = new Detector();
for (let s = 0; s < 200; s++) { chat.loudness(s, -30); if (s % 2 === 0) chat.message(s); }
for (let s = 192; s < 200; s++) for (let i = 0; i < 5; i++) chat.message(s);
assert.ok(/chat/.test(chat.check(200)?.why ?? ''), 'a chat burst is a moment');
console.log('detector: ok');
