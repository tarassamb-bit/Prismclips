// Run runClippingBrowserChecks() from a same-origin local preview. No account or AI requests.
import * as M from '../engine/media.js';
import * as R from '../engine/render.js';
import * as store from '../store.js';

export async function runClippingBrowserChecks() {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const m = await M.mediabunny();
  const canvas = new OffscreenCanvas(320, 180), ctx = canvas.getContext('2d');
  const output = new m.Output({ format: new m.Mp4OutputFormat(), target: new m.BufferTarget() });
  const video = new m.CanvasSource(canvas, { codec: 'avc', bitrate: 1e6 });
  const audio = new m.AudioBufferSource({ codec: 'aac', bitrate: 128000 });
  output.addVideoTrack(video, { frameRate: 30 }); output.addAudioTrack(audio);
  await output.start();
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = i < 60 ? 'red' : 'blue'; ctx.fillRect(0, 0, 160, 180);
    ctx.fillStyle = 'green'; ctx.fillRect(160, 0, 160, 180);
    await video.add(i / 30, 1 / 30);
  }
  const buffer = new AudioBuffer({ length: 192000, sampleRate: 48000, numberOfChannels: 2 });
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = .1 * Math.sin(2 * Math.PI * (440 + c * 110) * i / 48000);
  }
  await audio.add(buffer); video.close(); audio.close(); await output.finalize();
  const source = await M.openSource(new File([output.target.buffer], 'clipping-qa.mp4', { type: 'video/mp4' }));
  const edit = { start: .723, duration: 1.11, captions: [] };
  try {
    let frames = 0;
    for await (const sample of new m.AudioSampleSink(source.audio).samples(edit.start, edit.start + edit.duration)) {
      const trimmed = R.trimAudioSample(sample, edit.start, edit.duration);
      try {
        if (trimmed) {
          check(trimmed.timestamp >= 0 && trimmed.timestamp + trimmed.duration <= edit.duration + 1e-7, 'PCM extends outside edit');
          frames += trimmed.numberOfFrames;
        }
      } finally { trimmed?.close(); sample.close(); }
    }
    check(Math.abs(frames - edit.duration * 48000) <= 2, 'Audio trim lost more than boundary rounding');
    results.push({ check: 'decoded stereo PCM inside boundaries', frames });
    for (const [name, settings, width, height] of [
      ['fill', {}, 720, 1280], ['fit', { fitToFrame: true }, 720, 1280],
      ['split', { splitScreen: true }, 720, 1280], ['muted', { isMuted: true }, 720, 1280],
      ['1080p', {}, 1080, 1920],
    ]) {
      const blob = await R.render(source, { ...edit, ...settings }, { width, height, bitrate: 2e6 });
      const decoded = await M.openSource(new File([blob], `${name}.mp4`, { type: 'video/mp4' }));
      try {
        check(decoded.width === width && decoded.height === height, `${name} dimensions`);
        check(decoded.hasAudio === !settings.isMuted, `${name} audio`);
        check(Math.abs(decoded.duration - edit.duration) < .1, `${name} duration exceeds AAC padding allowance`);
        const frame = await M.frameImage(decoded, .5, 100);
        check(frame !== null, `${name} exported frame cannot decode`);
        results.push({ check: `${name} MP4`, bytes: blob.size, duration: decoded.duration, hasAudio: decoded.hasAudio });
      } finally { decoded.input.dispose(); }
    }
    for (const phase of ['last frame', 'finishing the file']) {
      const controller = new AbortController();
      let rejected = false;
      try {
        await R.render(source, { ...edit, isMuted: true }, {
          width: 720, height: 1280, signal: controller.signal,
          progress: (p) => { if (phase === 'last frame' && p === 1) controller.abort(); },
          step: (step) => { if (phase === step) controller.abort(); },
        });
      } catch (error) { check(error.name === 'AbortError', `Unexpected cancellation error: ${error}`); rejected = true; }
      check(rejected, `Cancellation at ${phase} returned an MP4`);
      results.push({ check: `cancel at ${phase}`, rejected });
    }
  } finally { source.input.dispose(); }

  // Isolated, local-only project; remove it directly so no cloud deletion is queued.
  const id = `clipping-qa-${crypto.randomUUID()}`, mediaId = 'fixture';
  const project = { id, owner: 'clipping-test', title: 'Keep this title', media: [{ id: mediaId }], segments: [{ id: 'keep-edit', caption: 'Keep this caption' }] };
  const removeLocal = async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('prism', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { await new Promise((resolve, reject) => { const t = db.transaction('projects', 'readwrite'); t.objectStore('projects').delete(id); t.oncomplete = resolve; t.onerror = () => reject(t.error); }); }
    finally { db.close(); }
  };
  try {
    await store.saveRaw('projects', project);
    const transcript = { start: 0, end: 60, cues: [{ start: 0, duration: 1, text: 'Checkpoint' }] };
    await store.saveTranscript(id, mediaId, transcript, () => true);
    const freshStore = await import(`../store.js?clipping-qa=${encodeURIComponent(id)}`);
    let saved = await freshStore.loadProject(id);
    check(saved.transcripts[mediaId].end === 60 && saved.dirty, 'Checkpoint not durable across new store instance');
    let current = true;
    const late = store.saveTranscript(id, mediaId, { ...transcript, end: 120 }, () => current);
    current = false; await late;
    await store.saveTranscript(id, mediaId, { ...transcript, end: 30 }, () => true);
    saved = await store.loadProject(id);
    check(saved.transcripts[mediaId].end === 60, 'Stale or shorter checkpoint overwrote saved progress');
    await Promise.all([store.addExportCount(id, 1), store.addExportCount(id, 2)]);
    saved = await store.loadProject(id);
    check(saved.exported === 3 && saved.updated, 'Export count/retention update failed');
    check(saved.title === project.title && saved.segments[0].caption === 'Keep this caption', 'Checkpoint/export overwrote edits');
    const compared = structuredClone(saved);
    await store.patch('projects', id, (record) => { record.title = 'Newer local edit'; });
    check(!await store.applyCloud('projects', { ...compared, title: 'Stale network response' }, compared, () => true), 'Cloud overwrote an edit made while fetching');
    saved = await store.loadProject(id);
    check(saved.title === 'Newer local edit', 'Concurrent local edit lost');
    check(saved.changedAt === compared.changedAt, 'Same-timestamp race fixture must retain the original timestamp');
    await store.markSynced('projects', id, 'server-version', compared);
    saved = await store.loadProject(id);
    check(saved.dirty && saved.title === 'Newer local edit', 'Same-timestamp export acknowledgement marked newer edits clean');
    await store.saveMediaCloud(id, mediaId, { uploaded: true, key: 'fixture-key' }, (record) => record.owner === project.owner);
    saved = await store.loadProject(id);
    check(saved.media[0].cloud.uploaded && saved.title === 'Newer local edit' && saved.exported === 3, 'Upload status overwrote edits or export counts');
    check(!await store.saveMediaCloud(id, mediaId, { removed: true }, () => false), 'Stale upload status survived account change');
    let saveCurrent = true;
    const staleSave = store.saveProject({ ...saved, title: 'Cancelled captions' }, { isCurrent: () => saveCurrent });
    saveCurrent = false;
    check(!await staleSave, 'Cancelled editor save committed');
    check((await store.loadProject(id)).title === 'Newer local edit', 'Cancelled save changed the project');
    check(!await store.applyCloud('projects', { ...saved, title: 'Other account response' }, saved, () => false), 'Cloud write survived account change');
    check(!await store.dropSynced('projects', compared, () => true), 'Cloud deletion erased a newer local edit');
    const clean = { ...saved, dirty: false, syncedAt: 'cloud-version' };
    await store.saveRaw('projects', clean);
    check(!await store.dropSynced('projects', clean, () => false), 'Cloud deletion survived account change');
    check(await store.dropSynced('projects', clean, () => true), 'Unchanged cloud-deleted project was not removed');
    check(!await store.loadProject(id), 'Cloud-deleted project still exists');
    await store.saveRaw('projects', saved);
    results.push({ check: 'Cloud responses preserve concurrent local edits and stop after account changes', passed: true });
    await removeLocal();
    check(!await store.saveProject(saved, { isCurrent: () => true }), 'Delayed editor save recreated a deleted project');
    await store.saveTranscript(id, mediaId, transcript, () => true);
    check(await store.addExportCount(id, 1) === null, 'Deleted project export count unexpectedly saved');
    check(!await store.loadProject(id), 'Delayed checkpoint resurrected deleted project');
    results.push({ check: 'IndexedDB checkpoints, cancellation, atomic counts, edit preservation, no resurrection', passed: true });
  } finally { await removeLocal(); }
  return results;
}
