import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const code = await readFile(new URL('../store.js', import.meta.url), 'utf8');
const start = code.indexOf('export async function saveTranscript(');
const stop = code.indexOf('\n/** Count committed exports', start);
assert.ok(start >= 0 && stop > start);

test('a new language replaces old checkpoints, while shorter same-language checkpoints cannot erase progress', async () => {
  const record = { media: [{ id: 'media' }], transcripts: { media: { start: 0, end: 120, language: 'English', cues: [] } } };
  let changes = 0;
  const context = vm.createContext({
    update: async (_table, _id, callback) => callback(record),
    changed: () => { changes++; },
  });
  vm.runInContext(code.slice(start, stop).replace('export async function', 'async function'), context);
  const save = context.saveTranscript;
  await save('project', 'media', { start: 0, end: 60, language: 'english', cues: [] }, () => true);
  assert.equal(record.transcripts.media.end, 120);
  assert.equal(changes, 0);
  await save('project', 'media', { start: 0, end: 60, language: 'Spanish', cues: [] }, () => true);
  assert.equal(record.transcripts.media.language, 'Spanish');
  assert.equal(record.transcripts.media.end, 60);
  assert.equal(changes, 1);
  await save('project', 'media', { start: 0, end: 90, language: 'Spanish', cues: [] }, () => false);
  assert.equal(record.transcripts.media.end, 60, 'a cancelled task cannot overwrite the new checkpoint');
  await save('project', 'media', { start: 0, end: 40, language: 'SPANISH', cues: [] }, () => true);
  assert.equal(record.transcripts.media.end, 60, 'a shorter checkpoint in the new language cannot overwrite progress');
});
