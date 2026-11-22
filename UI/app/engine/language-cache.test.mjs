// Exercise the actual analyze control flow with a small isolated AI double, without sending audio or using an account.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compatibleTranscript } from './shortmaker.js';

const code = await readFile(new URL('./shortmaker.js', import.meta.url), 'utf8');
const start = code.indexOf('export async function analyze(');
const stop = code.indexOf("\n/** The AI's title", start);
assert.ok(start >= 0 && stop > start, 'analyze must be available for the workflow test');
const body = code.slice(start, stop).replace('export async function analyze(', 'async function analyze(');
const endOfTest = new Error('stop after selection input');

async function run(language, cached) {
  const fresh = [{ text: 'New speech', start: 0, duration: 10 }];
  const calls = { transcriptions: 0, checkpoints: [], selected: null, language: null };
  const selection = {
    detectLanguage: async () => 'English',
    transcribeSentences: async (_source, _interval, config) => {
      calls.transcriptions++;
      calls.language = config.language;
      return fresh;
    },
    select: async (_source, transcript) => { calls.selected = transcript; throw endOfTest; },
  };
  const transcripts = { cuesCovering: (value, start, end) => value && value.start <= start && value.end >= end ? value.cues : null };
  const analyze = new Function('compatibleTranscript', 'regionInterval', 'autoCount', 'T', 'S', 'maxShorts', 'SELECTION_GUIDANCE', 'VIDEO_TYPE_TITLES', 'GeminiError',
    `${body}\nreturn analyze;`)(compatibleTranscript, () => ({ start: 0, end: 20 }), () => 1, transcripts, selection, () => 20, {}, {}, Error);
  await assert.rejects(analyze({ duration: 20, hasAudio: true }, {}, {
    region: 'entireVideo', count: 1, duration: 15, language, cachedTranscript: cached,
    onTranscript: async (value) => calls.checkpoints.push(value),
  }), (error) => error === endOfTest);
  return calls;
}

test('explicitly changing language starts a new transcript instead of reusing the previous one', async () => {
  const cached = { start: 0, end: 20, language: 'English', cues: [{ text: 'Old speech', start: 0, duration: 10 }] };
  const changed = await run('Spanish', cached);
  assert.equal(changed.transcriptions, 1);
  assert.equal(changed.language, 'Spanish');
  assert.equal(changed.selected[0].text, 'New speech');
  assert.equal(changed.checkpoints[0].language, 'Spanish');
  const same = await run('english', cached);
  assert.equal(same.transcriptions, 0);
  assert.equal(same.selected[0].text, 'Old speech');
  const auto = await run('auto', cached);
  assert.equal(auto.transcriptions, 0);
  assert.equal(auto.selected[0].text, 'Old speech');
});

test('an old transcript with unknown language is not reused for an explicit language', async () => {
  const cached = { start: 0, end: 20, cues: [{ text: 'Old speech', start: 0, duration: 10 }] };
  const explicit = await run('Spanish', cached);
  assert.equal(explicit.transcriptions, 1);
  const auto = await run('auto', cached);
  assert.equal(auto.transcriptions, 0);
});

import { repeatedLines } from './shortmaker.js';
import assertRepeat from 'node:assert/strict';
assertRepeat.equal(repeatedLines([{ start: 0, text: 'Oh baby baby' }, { start: 8, text: 'oh, baby baby!' }, { start: 40, text: 'Oh baby baby' }, { start: 41, text: 'Other' }]), 1);
assertRepeat.equal(repeatedLines([{ start: 0, text: 'Yeah.' }, { start: 3, text: 'Yeah.' }, { start: 6, text: 'Right.' }, { start: 9, text: 'Right.' }]), 0, 'short replies are normal speech');
