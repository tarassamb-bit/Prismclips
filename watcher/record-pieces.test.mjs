import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordPieces } from './record-pieces.js';

test('a failed segment is retried before later segments on the next refresh', async () => {
  const calls = [], failures = [];
  let fail = true;
  const recorder = { lastSequence: 0, stopped: false, pieces: new Map(), async record(piece) {
    calls.push(piece.sequence);
    if (piece.sequence === 1 && fail) { fail = false; throw new Error('network'); }
    this.pieces.set(piece.sequence, {});
  } };
  const playlist = [{ sequence: 1 }, { sequence: 2 }];
  await recordPieces(recorder, playlist, null, (error) => failures.push(error.message));
  assert.equal(recorder.lastSequence, 0);
  assert.deepEqual(calls, [1]);
  await recordPieces(recorder, playlist, null, (error) => failures.push(error.message));
  assert.equal(recorder.lastSequence, 2);
  assert.deepEqual(calls, [1, 1, 2]);
  assert.deepEqual(failures, ['network']);
});

test('an already-saved segment is not counted twice if later processing fails', async () => {
  const recorder = { lastSequence: 0, stopped: false, pieces: new Map(), async record(piece) {
    this.pieces.set(piece.sequence, {});
    throw new Error('processing');
  } };
  await recordPieces(recorder, [{ sequence: 1 }], null, () => {});
  assert.equal(recorder.lastSequence, 1);
});
