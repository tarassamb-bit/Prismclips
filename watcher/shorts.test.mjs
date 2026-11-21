// Offline check of the Short's span, layout and captions: node watcher/shorts.test.mjs
import assert from 'node:assert/strict';
import { bounds, captionsFile, cropAround, webcamBox, layout, wordsFrom, groupWords } from './shorts.mjs';

assert.deepEqual(bounds({ start: 20, end: 70 }, 90, 60), { start: 20, end: 70 });
assert.deepEqual(bounds({ start: 10, end: 89 }, 90, 60), { start: 10, end: 70 }, 'at most 60 s');
assert.deepEqual(bounds({ start: 50, end: 52 }, 90, 60), { start: 40, end: 80 }, 'too short: around the moment');
assert.deepEqual(bounds(null, 90, 85), { start: 65, end: 90 }, 'no answer, moment near the end');
assert.deepEqual(bounds({ start: 100, end: 120 }, 90, 60), { start: 40, end: 80 }, 'AI range after source falls back to the moment');
assert.deepEqual(bounds({ start: -30, end: -10 }, 90, 3), { start: 0, end: 23 }, 'AI range before source falls back safely');
assert.deepEqual(bounds({ start: 88, end: 120 }, 90, 85), { start: 65, end: 90 }, 'a range cut too short by the source falls back');

// A 320×216 camera box in the top-left corner of a 1280×720 frame: the crop has the top section's shape and stays inside it.
const cam = cropAround({ x: 0, y: 0, w: 0.25, h: 0.3 }, 1280, 720, 1080 / 700);
assert.ok(Math.abs(cam.w / cam.h - 1080 / 700) < 0.02 && cam.w % 2 === 0);
assert.ok(cam.x >= 0 && cam.y >= 0 && cam.x + cam.w <= 320 && cam.y + cam.h <= 216, JSON.stringify(cam));
const tall = cropAround({ x: 0.5, y: 0, w: 0.2, h: 0.5 }, 1280, 720, 1080 / 700);
assert.ok(tall.w === 256 && tall.y < (360 - tall.h) / 2, 'a tall box keeps its full width and leans to the top');
assert.equal(webcamBox({ x: 0.7, y: 0.6, w: 0.28, h: 0.35 }).w, 0.28);
assert.equal(webcamBox({ x: 0, y: 0, w: 0.9, h: 0.9 }), null, 'most of the frame is not a camera box');
assert.equal(webcamBox(null), null);
assert.match(layout('webcam', { x: 0, y: 0, w: 0.25, h: 0.3 }, 1280, 720).filter, /vstack\[frame\]$/);
assert.match(layout('person', null, 1280, 720).filter, /crop=404:720:438:0/);
assert.match(layout('screen', null, 1280, 720).filter, /boxblur/);

const ass = captionsFile([{ text: 'no way', start: 21, end: 22.5 }, { text: '{bad}', start: 80, end: 81 }, { text: 'gone', start: 5, end: 6 }], 20, 70, 'He did it', { captionY: 760, titleY: 90 });
assert.match(ass, /Dialogue: 1,0:00:01.00,0:00:01.\d\d,Caption,,0,0,0,,\{[^}]*\}NO\{[^}]*\} WAY/, 'first word highlighted');
assert.match(ass, /Caption,,0,0,0,,NO \{[^}]*\}WAY/, 'then the second');
assert.match(ass, /Dialogue: 2,0:00:00.00,0:00:03.00,Title,.*He did it/);
assert.ok(!ass.includes('BAD') && !ass.includes('GONE'), 'captions outside the Short are dropped');
// whisper.cpp's JSON, one segment per word, offset by where the Short starts in the clip.
const heard = wordsFrom({ transcription: [
  { offsets: { from: 0, to: 300 }, text: ' No' }, { offsets: { from: 300, to: 700 }, text: ' way!' },
  { offsets: { from: 1500, to: 1900 }, text: ' He' }, { offsets: { from: 1900, to: 2200 }, text: ' did' }, { offsets: { from: 2200, to: 2600 }, text: ' it' },
  { offsets: { from: 2600, to: 2900 }, text: ' again' }, { offsets: { from: 3000, to: 3500 }, text: ' [BLANK_AUDIO]' }] }, 20);
assert.deepEqual(heard.map((w) => w.text), ['No', 'way!', 'He', 'did', 'it', 'again'], 'blank markers dropped');
assert.equal(heard[0].start, 20);
const groups = groupWords(heard);
assert.deepEqual(groups.map((g) => g.text), ['No way!', 'He did it', 'again'], 'broken at the sentence end and every 3 words');
const timedAss = captionsFile(groups, 20, 30, '', { captionY: 760, titleY: 90 });
assert.match(timedAss, /Dialogue: 1,0:00:01.50,0:00:01.90,Caption,,0,0,0,,\{[^}]*\}HE\{/, 'each word lights up exactly while it is spoken');
console.log('shorts: ok');
