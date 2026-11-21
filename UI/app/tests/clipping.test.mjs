// Focused regressions: node --test UI/app/tests/clipping.test.mjs
// BASELINE=1 runs the app/render regressions against HEAD to reproduce the original bugs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { AudioSample } from '../../vendor/mediabunny-1.61.5.min.mjs';
import { trimAudioSample } from '../engine/render.js';
import { map } from '../engine/gemini.js';

const read = (path) => process.env.BASELINE
  ? execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' })
  : readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const app = read('UI/app/app.js');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function harness(overrides = {}) {
  const state = { project: { id: 'p', title: 'Talk', media: [{ id: 'm' }], segments: [1, 2].map((id) => ({ id, mediaId: 'm', duration: 1 })) }, task: null };
  const calls = { saved: [], recorded: [], counted: [], errors: [], dialogs: [] };
  const context = {
    state, AbortController, setInterval, clearInterval, Date, console, structuredClone,
    STALL_MS: 45000, uuid: () => 'run', accessToken() {}, accountToken: () => async () => 'fixture-only', userId: () => 'test-account', localDay: () => '2026-11-15',
    beginTask: () => (state.task = { controller: new AbortController() }),
    endTask: (task) => { if (state.task === task) state.task = null; },
    setTask() {}, track() {}, lengthBucket: () => '<10 min', exportSettings: () => ({}), sourceFor: async () => ({}),
    render: async () => new Blob(['mp4']), uniqueName: async (_, name) => name,
    safeName: (name) => name, esc: (s) => s,
    saveFile: async (_, blob, name) => calls.saved.push(name),
    recordExport: async (...args) => calls.recorded.push(args),
    store: {
      addExportCount: async (...args) => { calls.counted.push(args); return args[1]; }, saveTranscript: async () => {},
      loadProject: async () => structuredClone(state.project), saveProject: async () => {},
    },
    showError: (...args) => calls.errors.push(args), openDialog: (html) => calls.dialogs.push(html),
    freePlan: () => false, paidPlan: () => true, location: { hostname: 'localhost' },
    showGames() {}, closeGames() {}, leaveGames() {}, refreshUsage() {},
    reportGenerationError: (...args) => calls.errors.push(args),
    db: () => ({ rpc: async () => ({ data: true }) }),
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(section('async function exportShorts(', '/** A name that'), context);
  vm.runInContext(section('async function runShorts(', '\nfunction localDay('), context);
  return { ...context, calls, context };
}

test('a second export cannot replace the active task', async () => {
  const gate = deferred();
  const h = harness({ sourceFor: () => gate.promise });
  const first = h.context.exportShorts([1], 'small');
  const task = h.state.task;
  const second = h.context.exportShorts([1], 'small');
  const stillOwned = h.state.task === task;
  gate.resolve({});
  await Promise.all([first, second]);
  assert.equal(stillOwned, true);
  assert.equal(h.calls.saved.length, 1);
});

test('repeated submits open one folder picker and cannot start over a newer task', async () => {
  const gate = deferred();
  let picks = 0, submitHandler;
  const form = {
    isConnected: true, elements: { quality: { value: 'small' } },
    querySelectorAll: () => [{ value: 1 }], querySelector: () => ({}),
    addEventListener: (event, handler) => { submitHandler = handler; },
  };
  const h = harness({
    $: () => form, clock: () => '0:01', EXPORT_QUALITIES: {}, navigator: { userAgent: 'Chromium' }, closeDialog() {},
    window: { showDirectoryPicker: () => { picks++; return gate.promise; } },
  });
  vm.runInContext(section('function openExportDialog(', '\nconst STALL_MS'), h.context);
  h.context.openExportDialog();
  const event = { preventDefault() {}, currentTarget: form };
  const first = submitHandler(event), second = submitHandler(event);
  const newer = { controller: new AbortController() };
  h.state.task = newer;
  gate.resolve(null);
  await Promise.all([first, second]);
  assert.equal(picks, 1);
  assert.equal(h.state.task, newer);
  assert.equal(h.calls.saved.length, 0);
});

test('a failed second clip still counts the first and explains the partial result', async () => {
  let rendered = 0;
  const h = harness({ render: async () => { if (++rendered === 2) throw new Error('encoder failed'); return new Blob(['mp4']); } });
  await h.context.exportShorts([1, 2], 'small');
  assert.equal(h.calls.saved.length, 1);
  assert.deepEqual(h.calls.counted, [['p', 1]]);
  assert.deepEqual(h.calls.recorded, [[1, 1, 'small']]);
  assert.match(h.calls.errors[0][1], /1 of 2 Shorts saved/);
});

test('cancellation after rendering prevents saving and preserves earlier successes', async () => {
  let rendered = 0;
  const h = harness({ render: async () => {
    if (++rendered === 2) { h.state.task.cancelled = true; h.state.task.controller.abort(); }
    return new Blob(['mp4']);
  } });
  await h.context.exportShorts([1, 2], 'small');
  assert.equal(h.calls.saved.length, 1);
  assert.deepEqual(h.calls.counted, [['p', 1]]);
  assert.match(h.calls.errors[0][1], /1 of 2 Shorts saved.*cancelled/);
});

test('cancellation during filename lookup prevents the file save', async () => {
  const h = harness({ uniqueName: async () => { h.state.task.cancelled = true; h.state.task.controller.abort(); return 'clip'; } });
  await h.context.exportShorts([1], 'small');
  assert.equal(h.calls.saved.length, 0);
});

test('project bookkeeping failure does not hide saved files or skip export history', async () => {
  const h = harness({ store: { addExportCount: async () => { throw new Error('disk full'); } } });
  await h.context.exportShorts([1], 'small');
  assert.equal(h.calls.recorded.length, 1);
  assert.match(h.calls.errors[0][1], /files were saved/i);
});

test('transcript checkpoints are persisted before a later AI failure', async () => {
  const checkpoint = { start: 0, end: 60, cues: [] };
  let durable = null;
  const h = harness({
    store: { saveTranscript: async (id, media, transcript, current) => { assert.equal(current(), true); durable = structuredClone(transcript); } },
    Shorts: { analyze: async (source, config, options) => { await options.onTranscript(checkpoint); throw new Error('AI unavailable'); } },
  });
  await h.context.runShorts(h.state.project.media[0], {}, 'hash', 1);
  assert.deepEqual(durable, checkpoint);
  assert.equal(h.calls.errors[0][0].message, 'AI unavailable');
});

test('a stale cancelled generation cannot persist a late transcript checkpoint', async () => {
  let writes = 0, analyzed = false;
  const h = harness({
    store: { saveTranscript: async () => { writes++; } },
    Shorts: { analyze: async (source, config, options) => {
      analyzed = true;
      h.state.task.controller.abort();
      h.state.task = null;
      await options.onTranscript({ start: 0, end: 60, cues: [] });
      throw new Error('cancelled');
    } },
  });
  await h.context.runShorts(h.state.project.media[0], {}, 'hash', 1);
  assert.equal(analyzed, true);
  assert.equal(writes, 0);
  assert.equal(h.state.project.transcripts, undefined);
});

test('file writing aborts its stream when cancellation happens during write', async () => {
  const controller = new AbortController();
  let closed = 0, aborted = 0;
  const removed = [];
  const writable = { write: async () => controller.abort(), close: async () => closed++, abort: async () => aborted++ };
  const folder = { getFileHandle: async () => ({ createWritable: async () => writable }), removeEntry: async (name) => removed.push(name) };
  const context = vm.createContext({});
  vm.runInContext(section('async function saveFile(', '\nasync function recordExport('), context);
  await assert.rejects(context.saveFile(folder, new Blob(['mp4']), 'clip.mp4', controller.signal), { name: 'AbortError' });
  assert.equal(closed, 0);
  assert.equal(aborted, 1);
  // A cancelled write must not leave the empty file behind.
  assert.deepEqual(removed, ['clip.mp4']);
});

for (const phase of ['create file', 'open stream']) test(`file cleanup covers cancellation or failure during ${phase}`, async () => {
  const controller = new AbortController();
  const removed = [];
  const folder = {
    getFileHandle: async () => {
      if (phase === 'create file') controller.abort();
      return { createWritable: async () => { throw new Error('Cannot open stream'); } };
    },
    removeEntry: async (name) => removed.push(name),
  };
  const context = vm.createContext({});
  vm.runInContext(section('async function saveFile(', '\nasync function recordExport('), context);
  await assert.rejects(context.saveFile(folder, new Blob(['mp4']), 'clip.mp4', controller.signal));
  assert.deepEqual(removed, ['clip.mp4']);
});

test('export holds a snapshot when a Short is edited while its source loads', async () => {
  const gate = deferred();
  let rendered;
  const h = harness({ sourceFor: () => gate.promise, render: async (_, segment) => { rendered = segment; return new Blob(['mp4']); } });
  const exporting = h.context.exportShorts([1], 'small');
  h.state.project.segments[0].duration = 20;
  gate.resolve({});
  await exporting;
  assert.equal(rendered.duration, 1);
});

test('generation reports a missing source without starting a task', async () => {
  const h = harness({ sourceFor: async () => { throw new Error('Source missing'); } });
  await h.context.runShorts(h.state.project.media[0], {}, 'hash', 1);
  assert.equal(h.state.task, null);
  assert.equal(h.calls.errors[0][0].message, 'Source missing');
});

test('caption regeneration saves to the original Short after selection changes', async () => {
  const gate = deferred();
  const h = harness({ Selection: { regenerateCaptions: () => gate.promise }, usageFor: async () => ({}) });
  const first = h.state.project.segments[0], second = h.state.project.segments[1];
  first.start = 5;
  h.context.selected = () => first;
  h.state.selectedId = first.id;
  h.state.undo = [];
  h.context.selectShort = () => { throw new Error('Must not change the selection'); };
  vm.runInContext(section('async function regenerateCaptions(', '\nwindow.addEventListener(\'beforeunload\''), h.context);
  const work = h.context.regenerateCaptions();
  await new Promise((r) => setTimeout(r, 0));
  h.state.selectedId = second.id;
  gate.resolve({ cues: [{ start: 5, text: 'Original clip' }], words: [], notice: null });
  await work;
  assert.equal(first.captions[0].start, 0);
  assert.equal(second.captions, undefined);
  assert.equal(h.calls.errors.length, 0);
  assert.equal(h.state.task, null);
});

test('an account change stops work and clears the previous account editor without deleting saved projects', () => {
  const task = { controller: new AbortController() };
  let disposed = 0;
  const state = { session: { user: { id: 'first' } }, task, project: { id: 'private' }, sources: new Map([['video', { input: { dispose() { disposed++; } } }]]), previewToken: 0 };
  const context = vm.createContext({
    state, userId: () => state.session?.user?.id ?? null, uploadController: null, $: () => ({ replaceChildren() {} }),
    endTask: () => { state.task = null; }, closeGames() {}, closeDialog() {}, unmountPlayer() {}, renderUsage() {},
  });
  vm.runInContext(section('function setSession(', '\nasync function boot('), context);
  assert.equal(context.setSession({ user: { id: 'second' } }), true);
  assert.equal(task.controller.signal.aborted, true);
  assert.equal(state.project, null);
  assert.equal(state.sources.size, 0);
  assert.equal(disposed, 1);
  assert.equal(context.setSession({ user: { id: 'second' } }), false, 'Token refresh must not clear the editor');
});

test('background credentials reject an account change during session lookup', async () => {
  const gate = deferred();
  let account = 'first';
  const context = vm.createContext({ userId: () => account, db: () => ({ auth: { getSession: () => gate.promise } }), DOMException, location: { hostname: 'localhost' } });
  vm.runInContext(section('function accountToken(', '\nasync function refreshUsage('), context);
  const token = context.accountToken();
  const lookup = token();
  account = 'second';
  gate.resolve({ data: { session: { user: { id: 'second' }, access_token: 'fixture-only' } } });
  await assert.rejects(lookup, { name: 'AbortError' });
});

test('account deletion cannot continue under a new account after video cleanup', async () => {
  const gate = deferred();
  let rpcCalls = 0, deleted = 0;
  const state = { session: { user: { id: 'first', email: 'fixture@example.test' } } };
  const context = vm.createContext({
    state, userId: () => state.session?.user.id, confirm: () => true, $: () => null, DOMException,
    accountToken: () => async () => { if (state.session.user.id !== 'first') throw new DOMException('Account changed', 'AbortError'); return 'fixture-only'; },
    removeAllVideos: () => gate.promise,
    db: () => ({ rpc: () => { rpcCalls++; } }), store: { deleteOwner: async () => deleted++ },
  });
  vm.runInContext(section('async function deleteAccount(', '\nasync function deleteProjectNow('), context);
  const work = context.deleteAccount();
  state.session = { user: { id: 'second' } };
  gate.resolve();
  await work;
  assert.equal(rpcCalls, 0);
  assert.equal(deleted, 0);
});

test('an import completing after an account switch cannot render the old create flow', async () => {
  const gate = deferred();
  const state = { create: {}, session: { user: { id: 'first' } } };
  let renders = 0, saved = 0;
  const context = vm.createContext({
    state, userId: () => state.session.user.id, track() {}, uuid: () => 'fixture', renderCreate: () => renders++,
    importMedia: () => gate.promise, store: { saveProject: async () => saved++ }, Date,
  });
  vm.runInContext(section('async function chooseVideo(', '\n/** Why the custom range'), context);
  const work = context.chooseVideo({ name: 'talk.mp4' });
  state.session = { user: { id: 'second' } };
  state.create = null;
  gate.resolve({ duration: 200 });
  await work;
  assert.equal(saved, 0);
  assert.equal(renders, 1);
});

for (const change of ['project', 'trim', 'cancel']) test(`caption regeneration ignores stale results after ${change}`, async () => {
  const gate = deferred();
  const h = harness({ Selection: { regenerateCaptions: () => gate.promise }, usageFor: async () => ({}) });
  const segment = h.state.project.segments[0];
  segment.start = 5;
  h.context.selected = () => segment;
  h.state.undo = [];
  vm.runInContext(section('async function regenerateCaptions(', '\nwindow.addEventListener(\'beforeunload\''), h.context);
  const work = h.context.regenerateCaptions();
  await new Promise((r) => setTimeout(r, 0));
  if (change === 'project') h.state.project = { id: 'new-project' };
  if (change === 'trim') segment.start = 6;
  if (change === 'cancel') h.state.task.controller.abort();
  gate.resolve({ cues: [{ start: 5, text: 'Old result' }], words: [] });
  await work;
  assert.equal(segment.captions, undefined);
  assert.equal(h.state.task, null);
  assert.equal(h.calls.errors.length, change === 'trim' ? 1 : 0);
});

test('a delayed subject track cannot save into a different project', async () => {
  const gate = deferred();
  let saved = 0;
  const h = harness({ usageFor: async () => ({}), Framing: { VERSION: 1, analyze: () => gate.promise } });
  const segment = h.state.project.segments[0];
  h.context.store.saveProject = async () => saved++;
  vm.runInContext(section('async function retrack(', '\nfunction renderInspector('), h.context);
  const work = h.context.retrack(segment, {});
  await new Promise((r) => setTimeout(r, 0));
  h.state.project = { id: 'new-project' };
  gate.resolve([{ time: 0, position: .5 }]);
  await work;
  assert.equal(saved, 0);
  assert.equal(segment.cropKeyframes, undefined);
});

test('PCM trimming removes both outside boundaries, preserves stereo data and relative timing', () => {
  const sample = new AudioSample({ data: Float32Array.from({ length: 20 }, (_, i) => i), format: 'f32', sampleRate: 10, numberOfChannels: 2, timestamp: 2 });
  const trimmed = trimAudioSample(sample, 2.25, 0.4);
  try {
    assert.equal(trimmed.numberOfFrames, 3);
    assert.ok(Math.abs(trimmed.timestamp - 0.05) < 1e-8);
    assert.ok(trimmed.timestamp + trimmed.duration <= 0.4 + 1e-8);
    const pcm = new Float32Array(6);
    trimmed.copyTo(pcm, { planeIndex: 0, format: 'f32' });
    assert.deepEqual([...pcm], [6, 7, 8, 9, 10, 11]);
    assert.equal(trimAudioSample(sample, 5, 1), null);
  } finally { trimmed?.close(); sample.close(); }
});

test('parallel transcription waits for checkpoint writes and propagates storage failure', async () => {
  const gate = deferred();
  let finished = false;
  const work = map([1], async (x) => x, undefined, 1, () => gate.promise).then(() => { finished = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(finished, false);
  gate.resolve(); await work;
  await assert.rejects(map([1], async (x) => x, undefined, 1, async () => { throw new Error('storage failed'); }), /storage failed/);
});

test('the renderer passes only selected PCM frames to the audio encoder', async () => {
  const captured = [];
  const audioSample = new AudioSample({ data: Float32Array.from({ length: 200 }, (_, i) => i), format: 'f32', sampleRate: 1000, numberOfChannels: 1, timestamp: 0 });
  const lib = {
    Output: class { target = { buffer: new ArrayBuffer(1) }; addVideoTrack() {} addAudioTrack() {} async start() {} async finalize() {} async cancel() {} },
    BufferTarget: class {}, Mp4OutputFormat: class {}, canEncodeVideo: async () => true,
    CanvasSource: class { async add() {} close() {} },
    AudioSampleSource: class { async add(sample) { const data = new Float32Array(sample.numberOfFrames); sample.copyTo(data, { planeIndex: 0, format: 'f32' }); captured.push({ at: sample.timestamp, data: [...data] }); } close() {} },
    VideoSampleSink: class { async *samples() { yield { timestamp: 0, draw() {}, close() {} }; } },
    AudioSampleSink: class { async *samples() { yield audioSample; } },
  };
  const code = read('UI/app/engine/render.js').replace(/^import .*;\n/gm, '').replace(/export /g, '').replaceAll('import.meta.url', "'file:///render.js'");
  const ctx = { fillRect() {}, setTransform() {}, save() {}, beginPath() {}, rect() {}, clip() {}, restore() {} };
  const context = vm.createContext({ navigator: { userAgent: "" },
    mediabunny: async () => lib, letterbox: async () => ({}), eased: (x) => x, elements: () => [], drawCaptions() {},
    OffscreenCanvas: class { getContext() { return ctx; } }, Blob, EXPORT_QUALITIES: {}, ShortMakerError: class extends Error {}, URL,
  });
  vm.runInContext(code, context);
  await context.render({ duration: 1, width: 640, height: 360, video: {}, audio: {} }, { start: .025, duration: .1, captions: [] }, { watermark: false });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].at, 0);
  assert.deepEqual(captured[0].data, Array.from({ length: 100 }, (_, i) => 25 + i));
});

// Exercise the real render control flow with a fake codec: cancellation at its final-frame and finalize boundaries.
for (const phase of ['last frame', 'finalize']) test(`muted render rejects cancellation at ${phase}`, async () => {
  const controller = new AbortController();
  class Output {
    target = { buffer: new ArrayBuffer(1) };
    addVideoTrack() {} async start() {} async cancel() {}
    async finalize() { if (phase === 'finalize') controller.abort(); }
  }
  const canvasContext = { fillRect() {}, setTransform() {}, save() {}, beginPath() {}, rect() {}, clip() {}, restore() {} };
  const source = { duration: 1, width: 640, height: 360, video: {}, audio: null };
  const sample = { timestamp: 0, draw() {}, close() {} };
  const lib = {
    Output, BufferTarget: class {}, Mp4OutputFormat: class {}, canEncodeVideo: async () => true,
    CanvasSource: class { async add() {} close() {} },
    VideoSampleSink: class { async *samples() { yield sample; } },
  };
  const code = read('UI/app/engine/render.js').replace(/^import .*;\n/gm, '').replace(/export /g, '').replaceAll('import.meta.url', "'file:///render.js'");
  const context = vm.createContext({ navigator: { userAgent: '' },
    mediabunny: async () => lib, letterbox: async () => ({}), eased: (x) => x, elements: () => [], drawCaptions() {},
    OffscreenCanvas: class { getContext() { return canvasContext; } }, Blob, EXPORT_QUALITIES: {},
    ShortMakerError: class extends Error {}, URL, console,
  });
  vm.runInContext(code, context);
  await assert.rejects(context.render(source, { start: 0, duration: .1, captions: [], isMuted: true }, {
    watermark: false, signal: controller.signal,
    progress: (p) => { if (phase === 'last frame' && p === 1) controller.abort(); },
  }), { name: 'AbortError' });
});
