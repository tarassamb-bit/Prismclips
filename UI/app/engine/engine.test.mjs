// Offline checks for the engine's pure logic: run `node UI/app/engine/engine.test.mjs` with Node 24. No browser, network or keys.
import assert from 'node:assert/strict';
import * as T from './transcript.js';
import * as Framing from './framing.js';
import * as S from './selection.js';
import * as Shorts from './shortmaker.js';
import { pages, elements, estimatedWords } from './captions.js';
import { cropPositionAt, layoutAt } from './render.js';
import { regionInterval } from './models.js';
import { retryDelay } from './gemini.js';

const cue = (text, start, duration) => ({ text, start, duration });

// Windows cover every sentence, including the tail; batches are near-equal.
const cues = Array.from({ length: 12 }, (_, i) => cue(`Sentence number ${i}.`, i * 10, 9));
const windows = T.windows(cues, { start: 0, end: 120 }, 40, 10);
assert.ok(windows.length >= 3);
assert.equal(windows[0].start, 0);
assert.equal(windows.at(-1).end, 119);
assert.deepEqual(T.batches([1, 2, 3, 4, 5], 4).map((b) => b.length), [3, 2]);

// Sentences: an edge in the middle of a sentence moves to its boundary.
const sentences = [cue('One.', 0, 5), cue('Two.', 5, 5), cue('Three.', 10, 5)];
const whole = T.completeSentences(1, 8, sentences, { start: 0, end: 15 }, 3, 30);
assert.equal(whole.start, 0);
assert.ok(Math.abs(whole.start + whole.duration - 10) < 1e-9 || Math.abs(whole.start + whole.duration - 5) < 1e-9);
// Filler at the edges goes, as long as the minimum length stays.
const filler = T.trimmedFiller(0, 20, [cue('Okay so', 0, 1), cue('The real point is here.', 1, 10), cue('Thanks for watching', 11, 2)], 5);
assert.equal(filler.start, 1);
assert.equal(filler.start + filler.duration, 11);

// Alignment: matching words pass; a different text fails; reversed times fail.
const reference = [cue('hello brave new world', 0, 4)];
const words = ['hello', 'brave', 'new', 'world'].map((text, i) => cue(text, i, 0.9));
assert.equal(T.alignmentIsReliable(words, reference), true);
assert.equal(T.alignmentIsReliable(words.map((w) => ({ ...w, text: 'nothing' })), reference), false);
assert.equal(T.alignmentIsReliable([...words].reverse(), reference), false);

// Overlap rule and sentence-timing fallback.
assert.equal(T.overlaps(0, 10, 9, 10), false);
assert.equal(T.overlaps(0, 10, 5, 10), true);
const groups = T.sentenceCaptionGroups([cue('a b c d e f g h', 0, 8)]);
assert.deepEqual(groups.map((g) => g.text), ['a b c d e f', 'g h']);

// Clip validation: scores, length, layout and overlap with used ranges.
const clip = (start, end, score, layout = 'track') => ({ start, end, score, layout });
const picked = S.validate([clip(0, 30, 9), clip(10, 40, 8), clip(60, 90, 7.5), clip(100, 105, 9)], { start: 0, end: 200 }, 30, 5);
assert.deepEqual(picked.map((c) => c.start), [0, 60]);
assert.throws(() => S.validate([clip(0, 30, 3)], { start: 0, end: 200 }, 30, 1), { failure: 'noStrongClips' });
assert.equal(S.strongestOrBest([clip(0, 30, 6)], { start: 0, end: 200 }, 30, 1, [])[0].reason.startsWith('Weaker pick'), true);
assert.throws(() => S.validate([clip(0, 30, 9)], { start: 0, end: 200 }, 30, 1, [{ start: 0, end: 30 }]), { failure: 'noStrongClips' });
assert.throws(() => S.validate([{ start: 0, end: 30, score: Number.NaN, layout: 'track' }], { start: 0, end: 200 }, 30, 1), { failure: 'invalidResponse' });

// Window scoring: five criteria, with the standalone/payoff penalty.
assert.equal(S.parseWindowScore({ id: 1, hook: 10, payoff: 10, standalone: 10, emotion: 10, novelty: 10 }).score, 100);
assert.ok(S.parseWindowScore({ id: 1, hook: 10, payoff: 10, standalone: 2, emotion: 10, novelty: 10 }).score < 80);
assert.throws(() => S.parseWindowScore({ id: 1, hook: 11, payoff: 1, standalone: 1, emotion: 1, novelty: 1 }), { failure: 'invalidResponse' });
assert.deepEqual(S.rankedWindowIds([{ id: 0, score: 5 }, { id: 1, score: 9 }], [0, 1]), [1, 0]);

// Transcription answers: JSON, subtitle lines, long pieces split at sentences, bad timing rejected.
assert.equal(S.transcriptAnswer('{"words":[{"text":"hi","start":0,"end":1}]}')[0].text, 'hi');
assert.equal(S.transcriptAnswer('0.03-4.50 | SPEAKER_00: hello there\n4.50-9.00 | SPEAKER_01: yes')[1].text, 'yes');
assert.equal(S.transcriptAnswer('not a transcript'), null);
const split = S.splitSentences([{ text: 'First sentence here. Second one follows.', start: 0, end: 20 }]);
assert.equal(split.length, 2);
assert.equal(split[1].end, 20);
assert.throws(() => S.validatedWords([{ text: 'x', start: 5, end: 4 }], 0, 10), { failure: 'invalidTiming' });
const timed = S.validatedWords([{ text: 'a', start: 0, end: 1.1 }, { text: 'b', start: 1, end: 2 }], 10, 5);
assert.ok(timed[0].start + timed[0].duration <= timed[1].start + 1e-9);
assert.equal(S.captionCues(Array.from({ length: 7 }, (_, i) => cue(`w${i}`, i * 0.3, 0.2))).length, 2);

// Shorts: nearest-pause snapping stays out of words; openings drop "um"; ranges stay inside the interval.
const levels = new Float32Array(300).fill(0.2);
for (let i = 40; i < 60; i++) levels[i] = 0; // quiet 0.40–0.60 s after `from`
const snapped = Shorts.snapToQuiet(levels, 10, 10.55, 1.5, { start: 0, end: 100 });
assert.ok(snapped.start >= 10.4 && snapped.start <= 10.6);
assert.deepEqual(Shorts.strongOpening(0, 10, [cue('Um', 0, 0.3), cue('Real', 0.4, 0.5)], 5), { start: 0.32, duration: 9.68 });
assert.deepEqual(Shorts.speechSafeRange(1, 5, [cue('cut', 0.5, 1.5)], { start: 0, end: 100 }).start, 0.475);
assert.deepEqual(Shorts.clipCaptions([cue('x', 9, 3)], 10, 5), [{ text: 'x', start: 0, duration: 2 }]);
assert.equal(Shorts.autoCount(185), 3);
assert.equal(Shorts.autoCount(10), 1);

// Regions.
assert.deepEqual(regionInterval('lastHalf', 100), { start: 50, end: 100 });
assert.throws(() => regionInterval('custom', 100, 60, 50), { failure: 'invalidRange' });

// Framing: smooth path, hard change on a scene cut, ends covered, positions in range.
const samples = Array.from({ length: 10 }, (_, i) => ({ time: i, subject: { x: i < 5 ? 0.1 : 0.7, width: 0.2 }, cutTime: i === 5 ? 5 : null, preserveWholeFrame: false }));
const path = Framing.plan(samples, 10, 1920, 1080, 1.08);
assert.equal(path[0].time, 0);
assert.equal(path.at(-1).time, 10);
assert.ok(path.every((p) => p.position >= 0 && p.position <= 1));
assert.ok(path.some((p) => p.isSceneCut));
const easedPath = Framing.eased(path);
assert.ok(easedPath.length >= path.length);
assert.ok(easedPath.every((p) => p.position >= 0 && p.position <= 1));
// Cut detection: identical grids are no cut; a very different grid is.
const dark = new Uint8Array(576).fill(10), light = new Uint8Array(576).fill(240);
assert.deepEqual(Framing.detectCuts([0, 0.1, 0.2], [dark, dark, light]).map((c) => c !== null), [false, false, true]);
// Two speakers: need two clear face groups.
assert.equal(Framing.splitCenters([0.5, 0.55]), null);
assert.deepEqual(Framing.splitCenters([0.2, 0.22, 0.8, 0.78]).map((x) => Math.round(x * 100)), [21, 79]);

// Camera position over time: linear within a move, holds at a scene cut.
assert.equal(cropPositionAt([{ time: 0, position: 0 }, { time: 2, position: 1 }], 1, 0), 0.5);
assert.equal(cropPositionAt([{ time: 0, position: 0 }, { time: 2, position: 1, isSceneCut: true }], 1, 0), 0);
assert.equal(cropPositionAt([{ time: 0, position: 0.9 }, { time: 2, position: 1 }], 0, 0.3), 1);

// Layout: crop is 9:16 inside the source; Fit centers; split uses two halves.
const [crop] = layoutAt({ cropKeyframes: [], cropPosition: 0.5 }, 0, 1920, 1080);
assert.ok(Math.abs(crop.sw / crop.sh - 1080 / 1920) < 1e-6);
assert.ok(crop.sx >= 0 && crop.sx + crop.sw <= 1920 + 1e-6);
assert.equal(layoutAt({ fitToFrame: true }, 0, 1920, 1080)[0].kind, 'fit');
assert.equal(layoutAt({ splitScreen: true, splitCenters: [0.25, 0.75] }, 0, 1920, 1080).length, 2);
assert.equal(layoutAt({ cropKeyframes: [{ time: 0, position: 0.5, preserveWholeFrame: true }] }, 0, 1920, 1080)[0].kind, 'fit');

// Captions: pages respect style limits; highlight layers follow words; overlay is added; hold time is bounded by the next page.
const spoken = [cue('Hello brave new world today friends.', 0, 3)];
const oneWord = pages(spoken, [], 'oneWord');
assert.ok(oneWord.every((p) => p.words.length === 1));
assert.ok(pages(spoken, [], 'viral').every((p) => p.words.length <= 3));
const segment = { duration: 5, captions: spoken, speechWords: [], captionStyle: 'viral', caption: 'Overlay' };
const layers = elements(segment);
assert.ok(layers.some((l) => l.text === 'Overlay'));
assert.ok(layers.some((l) => l.highlighted === 1));
assert.ok(layers.every((l) => l.start >= 0 && l.start + l.duration <= 5 + 1e-9));
assert.equal(elements({ duration: 5, captions: [], caption: '' }).length, 0);
assert.ok(Math.abs(estimatedWords(cue('aa bbbb', 0, 6)).reduce((s, w) => s + w.duration, 0) - 6) < 1e-9);

// Retry-After handling.
assert.equal(retryDelay(new Response('', { headers: { 'Retry-After': '12' } }), ''), 12);
assert.equal(retryDelay(new Response(''), '{"error":{"details":[{"retryDelay":"37s"}]}}'), 37);
assert.equal(retryDelay(new Response(''), 'nope'), null);

console.log('engine checks passed');
