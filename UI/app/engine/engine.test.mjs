// Offline checks for the engine's pure logic: run `node UI/app/engine/engine.test.mjs` with Node 24. No browser, network or keys.
import assert from 'node:assert/strict';
import * as T from './transcript.js';
import * as Framing from './framing.js';
import * as S from './selection.js';
import * as Shorts from './shortmaker.js';
import { pages, elements, estimatedWords, CAPTION_LEAD } from './captions.js';
import { cropPositionAt, layoutAt, boxBlur } from './render.js';
import { regionInterval } from './models.js';
import { retryDelay } from './gemini.js';
import { resample, wav, barsFromFrames, isQuiet } from './media.js';
import { mergePlan, resolveConflict } from './syncplan.js';

const cue = (text, start, duration) => ({ text, start, duration });

// Windows cover every sentence, including the tail; batches are near-equal.
const cues = Array.from({ length: 12 }, (_, i) => cue(`Sentence number ${i}.`, i * 10, 9));
const windows = T.windows(cues, { start: 0, end: 120 }, 40, 10);
assert.ok(windows.length >= 3);
assert.equal(windows[0].start, 0);
assert.equal(windows.at(-1).end, 119);
assert.deepEqual(T.batches([1, 2, 3, 4, 5], 4).map((b) => b.length), [3, 2]);

// Little speech: clock windows cover the whole video, silent parts included, and carry the few words inside them.
const sparse = [cue('Look at this.', 200, 3)];
assert.ok(T.speechCoverage(sparse, { start: 0, end: 356 }) < S.SPARSE_SPEECH);
assert.ok(T.speechCoverage(cues, { start: 0, end: 120 }) > S.SPARSE_SPEECH);
const clock = T.timeWindows(sparse, { start: 0, end: 356 }, 90, 30);
assert.equal(clock[0].start, 0);
assert.equal(clock.at(-1).end, 356);
assert.ok(clock.every((w, i) => i === 0 || w.start < clock[i - 1].end));
assert.ok(clock.some((w) => w.text === 'Look at this.') && clock.some((w) => w.text === ''));
assert.deepEqual(T.timeWindows([], { start: 0, end: 40 }, 90, 30), [{ start: 0, end: 40, text: '' }]);

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
// A 4 is still offered as a weaker pick; a 3 or lower is not, and a strong clip wins over weak ones.
assert.equal(S.strongestOrBest([clip(0, 30, 4.2)], { start: 0, end: 200 }, 30, 1, [])[0].reason.startsWith('Weaker pick'), true);
assert.throws(() => S.strongestOrBest([clip(0, 30, 3.5)], { start: 0, end: 200 }, 30, 1, []), { failure: 'noStrongClips' });
assert.equal(S.strongestOrBest([clip(0, 30, 4.5), clip(60, 90, 8)], { start: 0, end: 200 }, 30, 1, [])[0].start, 60);
// Silence is quiet; a tone is not.
assert.equal(isQuiet(new Float32Array(1600), 16000), true);
assert.equal(isQuiet(Float32Array.from({ length: 1600 }, (_, i) => 0.1 * Math.sin(i / 5)), 16000), false);
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

// Models time speech roughly: small overshoots are clamped, gross errors are still refused (and retried in halves).
const clamped = S.validatedWords([{ text: 'hello', start: 0, end: 7 }, { text: 'world', start: 7, end: 15.37 }], 100, 15);
assert.equal(clamped.at(-1).start + clamped.at(-1).duration, 115);
assert.equal(S.validatedWords([{ text: 'late', start: 15.2, end: 16 }], 0, 15).length, 0);
assert.equal(S.validatedWords([{ text: 'a', start: -0.4, end: 2 }], 10, 15)[0].start, 10);
const trimmed = S.validatedWords([{ text: 'a', start: 0, end: 6.5 }, { text: 'b', start: 6, end: 9 }], 0, 15);
assert.ok(trimmed[0].start + trimmed[0].duration <= trimmed[1].start + 1e-9);
assert.throws(() => S.validatedWords([{ text: 'far', start: 2, end: 40 }], 0, 15), { failure: 'invalidTiming' });
assert.throws(() => S.validatedWords([{ text: 'a', start: 0, end: 8 }, { text: 'b', start: 5, end: 9 }], 0, 15), { failure: 'invalidTiming' });

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

// Listing: by position in the video, or best score first with ties kept in video order.
const list = [{ id: 'a', start: 50, score: 88 }, { id: 'b', start: 10, score: 91 }, { id: 'c', start: 30, score: 88 }, { id: 'd', start: 70 }];
assert.deepEqual(Shorts.orderedShorts(list, false).map((s) => s.id), ['b', 'c', 'a', 'd']);
assert.deepEqual(Shorts.orderedShorts(list, true).map((s) => s.id), ['b', 'c', 'a', 'd']);
assert.deepEqual(Shorts.orderedShorts([{ id: 'x', start: 5, score: 70 }, { id: 'y', start: 1, score: 95 }, { id: 'z', start: 9, score: 80 }], true).map((s) => s.id), ['y', 'z', 'x']);

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

// Whole frame is for screens: faces in most frames mean people, so the crop follows them even when the model says "slides".
const found = (faces) => ({ faces, index: 0, found: true, center: 0.5, width: 0.2 });
assert.equal(Framing.isWholeFrame({ wholeFrame: true, frames: [found([0.5]), found([0.5]), found([])] }, 3), false);
assert.equal(Framing.isWholeFrame({ wholeFrame: true, frames: [found([]), found([]), found([0.5])] }, 3), true);
assert.equal(Framing.isWholeFrame({ wholeFrame: false, frames: [found([])] }, 1), false);

// Camera position over time: linear within a move, holds at a scene cut.
assert.equal(cropPositionAt([{ time: 0, position: 0 }, { time: 2, position: 1 }], 1, 0), 0.5);
assert.equal(cropPositionAt([{ time: 0, position: 0 }, { time: 2, position: 1, isSceneCut: true }], 1, 0), 0);
assert.equal(cropPositionAt([{ time: 0, position: 0.9 }, { time: 2, position: 1 }], 0, 0.3), 1);

// Layout: crop is 9:16 inside the source; Fit centers; split uses two halves.
const [crop] = layoutAt({ cropKeyframes: [], cropPosition: 0.5 }, 0, 1920, 1080);
assert.ok(Math.abs(crop.sw / crop.sh - 1080 / 1920) < 1e-6);
assert.ok(crop.sx >= 0 && crop.sx + crop.sw <= 1920 + 1e-6);
assert.equal(layoutAt({ fitToFrame: true }, 0, 1920, 1080)[0].kind, 'fit');
// Burned-in black bars: a black run from an edge counts only where it meets the picture sharply; the widest real one wins.
const frame = (top, bottom, edge = 200) => [...Array(top).fill(0), edge, ...Array(86 - top - bottom).fill(150), edge, ...Array(bottom).fill(0)];
assert.deepEqual(barsFromFrames([frame(5, 5), frame(7, 5)], 360), { top: 33, bottom: 25 }, 'the widest bar across shots');
assert.deepEqual(barsFromFrames([frame(0, 0)], 360), { top: 0, bottom: 0 });
const ramp = [0, 0, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], fading = [...ramp, ...Array(60).fill(150), ...[...ramp].reverse()];
assert.deepEqual(barsFromFrames([fading], 360), { top: 0, bottom: 0 }, 'a dark scene fading out is not a bar');
assert.deepEqual(barsFromFrames([Array(88).fill(0)], 360), { top: 0, bottom: 0 }, 'an all-black frame is not bars');
assert.equal(barsFromFrames([frame(40, 0)], 360).top, Math.ceil(23 * 360 / 88), 'at most a quarter of the picture');
const barred = layoutAt({ cropKeyframes: [], cropPosition: 0.5, cropZoom: 1 }, 0, 640, 360, { top: 29, bottom: 21 })[0];
assert.ok(barred.sy >= 29 - 1e-9 && barred.sy + barred.sh <= 360 - 21 + 1e-9, 'the crop leaves out both bars');
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
// Subtitles lead their words slightly; hidden subtitles leave only the overlay.
const later = elements({ duration: 5, captions: [cue('Hello.', 2, 1)], speechWords: [], captionStyle: 'classic' });
assert.ok(Math.abs(later[0].start - (2 - CAPTION_LEAD)) < 1e-9);
assert.deepEqual(elements({ ...segment, captionsHidden: true }).map((l) => l.text), ['Overlay']);
assert.ok(Math.abs(estimatedWords(cue('aa bbbb', 0, 6)).reduce((s, w) => s + w.duration, 0) - 6) < 1e-9);
// No gaps: two lines with a 2 s pause between them still touch; each page ends where the next starts.
const paused = pages([cue('First line.', 0, 1), cue('Second line.', 3, 1)], [], 'viral');
paused.slice(0, -1).forEach((p, i) => assert.equal(p.end, paused[i + 1].start, 'captions must not leave a blank gap'));
// An edited line follows the words actually spoken in its time, not an even spread over its silence.
const heard = [{ text: 'zero', start: 2, duration: 0.3 }, { text: 'point', start: 2.3, duration: 0.3 }, { text: 'one', start: 2.6, duration: 0.3 }];
const edited = pages([cue('0.1 is guessing', 0, 4)], heard, 'minimal')[0].words;
assert.deepEqual(edited.map((w) => w.start), [2, 2.3, 2.6], 'same word count: timings are taken one for one');
const shorter = pages([cue('Guessing', 0, 4)], heard, 'minimal')[0];
assert.ok(shorter.start >= 2 && shorter.words[0].start + shorter.words[0].duration <= 2.9 + 1e-9, 'the line sits on the speech, not on the silence before it');

// Retry-After handling.
assert.equal(retryDelay(new Response('', { headers: { 'Retry-After': '12' } }), ''), 12);
assert.equal(retryDelay(new Response(''), '{"error":{"details":[{"retryDelay":"37s"}]}}'), 37);
assert.equal(retryDelay(new Response(''), 'nope'), null);

// Background blur: a single bright pixel spreads out and the overall brightness is kept.
const dots = new Uint8ClampedArray(9 * 9 * 4).fill(255);
for (let i = 0; i < 9 * 9; i++) dots[i * 4 + 1] = dots[i * 4 + 2] = dots[i * 4] = i === 40 ? 255 : 0;
boxBlur(dots, 9, 9, 2, 2);
assert.ok(dots[40 * 4] < 255 && dots[39 * 4] > 0 && dots[31 * 4] > 0);
const mean = (data) => { let s = 0; for (let i = 0; i < 81; i++) s += data[i * 4]; return s / 81; };
assert.ok(Math.abs(mean(dots) - 255 / 81) < 3);

// Cloud sync plan: what to fetch, send or drop so this device and the cloud agree.
const T0 = '2026-11-01T10:00:00Z', T1 = '2026-11-01T11:00:00Z', T2 = '2026-11-01T12:00:00Z';
const mine = (id, extra) => ({ id, dirty: false, syncedAt: T0, updated: T0, ...extra });
const theirs = (id, updated_at = T0) => ({ id, updated_at });
assert.deepEqual(mergePlan([], [theirs('a')]), { pull: ['a'], push: [], dropLocal: [], conflict: [] }, 'new on another device: fetch it');
assert.deepEqual(mergePlan([mine('a', { dirty: true, syncedAt: undefined })], []), { pull: [], push: ['a'], dropLocal: [], conflict: [] }, 'never sent: send it');
assert.deepEqual(mergePlan([mine('a')], []), { pull: [], push: [], dropLocal: ['a'], conflict: [] }, 'synced before, gone from the cloud and untouched: deleted elsewhere');
assert.deepEqual(mergePlan([mine('a', { dirty: true })], []), { pull: [], push: ['a'], dropLocal: [], conflict: [] }, 'deleted elsewhere but edited here: keep and send it');
assert.deepEqual(mergePlan([mine('a')], [theirs('a')]), { pull: [], push: [], dropLocal: [], conflict: [] }, 'both agree: nothing to do');
assert.deepEqual(mergePlan([mine('a', { dirty: true })], [theirs('a')]), { pull: [], push: ['a'], dropLocal: [], conflict: [] }, 'edited here only: send it');
assert.deepEqual(mergePlan([mine('a')], [theirs('a', T1)]), { pull: ['a'], push: [], dropLocal: [], conflict: [] }, 'edited elsewhere only: fetch it');
assert.deepEqual(mergePlan([mine('a', { dirty: true, updated: T2 })], [theirs('a', T1)]).conflict, ['a'], 'edited in both: decided with both copies');
// Conflicts: the later change wins as a whole, but each video's cloud status is the newest one either side recorded.
const here = { id: 'p', title: 'Renamed here', changedAt: T2, media: [{ id: 'v1', cloud: { removed: true, at: T2 } }, { id: 'v2' }] };
const there = { id: 'p', title: 'Edited there', media: [{ id: 'v1', cloud: { uploaded: true, at: T0 } }, { id: 'v2', cloud: { uploaded: true, at: T1 } }] };
let merged = resolveConflict(here, there, T1);
assert.deepEqual([merged.winner, merged.project.title, merged.project.media[0].cloud.removed, merged.project.media[1].cloud.uploaded, merged.changed], ['local', 'Renamed here', true, true, true]);
merged = resolveConflict({ ...here, changedAt: T0 }, there, T1);
assert.deepEqual([merged.winner, merged.project.title, merged.project.media[0].cloud.removed, merged.changed], ['cloud', 'Edited there', true, true], 'the cloud copy wins but keeps the newer removal recorded here');
merged = resolveConflict({ id: 'p', changedAt: T0, media: [{ id: 'v1' }] }, there, T1);
assert.deepEqual([merged.winner, merged.changed], ['cloud', false], 'nothing newer here: take the cloud copy as is');
assert.equal(here.media[0].cloud.removed, true, 'the inputs are not changed');

// Audio for Relio AI: 16 kHz mono WAV with a correct header; resampling keeps the duration and clamps nothing out of range.
const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 20));
const speech = resample(tone, 48000, 16000);
assert.equal(speech.length, 16000);
assert.equal(resample(tone, 16000, 16000), tone);
assert.equal(resample(new Float32Array(44100), 44100, 16000).length, 16000);
const file = wav(Float32Array.of(0, 1, -1, 2, -2), 16000);
const view = new DataView(file.buffer);
assert.equal(String.fromCharCode(...file.slice(0, 4)), 'RIFF');
assert.equal(String.fromCharCode(...file.slice(8, 12)), 'WAVE');
assert.equal(view.getUint32(24, true), 16000);
assert.equal(view.getUint16(22, true), 1);
assert.equal(view.getUint32(40, true), 10);
assert.equal(file.length, 54);
assert.deepEqual([1, 2, 3, 4, 5].map((i) => view.getInt16(44 + (i - 1) * 2, true)), [0, 32767, -32767, 32767, -32767]);

console.log('engine checks passed');

// Word timing: AI guesses 0.6 s late are moved onto the speech actually heard, keeping words and order; a pause stays a pause.
{
  const levels = new Float32Array(600).fill(0.001);
  const speak = (from, to) => { for (let i = Math.round(from * 100); i < Math.round(to * 100); i++) levels[i] = 0.2; };
  speak(1, 2); speak(3, 3.8);
  const runs = T.speechRuns(levels, 0);
  assert.equal(runs.length, 2);
  const guessed = [['Hello', 1.6, 0.4], ['there,', 2.0, 0.5], ['good', 3.6, 0.3], ['friend.', 3.9, 0.5]].map(([text, start, duration]) => ({ text, start, duration }));
  const fixed = T.alignToSpeech(guessed, runs);
  assert.deepEqual(fixed.map((w) => w.text), ['Hello', 'there,', 'good', 'friend.']);
  assert.ok(Math.abs(fixed[0].start - 1) < 0.06 && Math.abs(fixed[1].start + fixed[1].duration - 2) < 0.06, 'first phrase sits on the first stretch of speech');
  assert.ok(Math.abs(fixed[2].start - 3) < 0.06 && Math.abs(fixed[3].start + fixed[3].duration - 3.8) < 0.06, 'second phrase sits on the second');
  assert.deepEqual(T.alignToSpeech(guessed, []), guessed, 'no speech found: timings unchanged');
}
console.log('word timing checks passed');

// Titles come from the clip's own words; an invented or misspelled title becomes a short quote from the clip.
{
  const captions = [{ text: 'Я так люблю тебе, моя земля,' }, { text: 'і небо над тобою синє.' }];
  assert.equal(Shorts.groundedTitle('Люблю тебе, моя земля', captions), 'Люблю тебе, моя земля');
  assert.equal(Shorts.groundedTitle('Mylėk savo žemę', captions), 'Я так люблю тебе, моя земля, і небо');
  assert.equal(Shorts.groundedTitle('Люблю тебе, моя зимля мила', captions), 'Я так люблю тебе, моя земля, і небо', 'misspelled words fail');
  assert.equal(Shorts.groundedTitle(null, []), null);
}
console.log('title grounding checks passed');

// Repeated lines within 20 s are dropped; the same line later on is kept.
assert.deepEqual(Shorts.dropRepeats([{ text: 'Hello there.', start: 0 }, { text: 'hello there', start: 8 }, { text: 'hello there', start: 40 }]).map((c) => c.start), [0, 40]);

// Lines with an impossible speaking rate are dropped; a normal line stays; too many removed means likely music.
assert.deepEqual(Shorts.dropImpossibleRate([{ text: 'one two three', start: 0, duration: 2 }, { text: 'a b c d e f g h i j k l m n o p', start: 3, duration: 1 }]).map((c) => c.start), [0]);
