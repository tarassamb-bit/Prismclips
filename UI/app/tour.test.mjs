import test from 'node:test';
import assert from 'node:assert/strict';
import { hintFor, TOUR_STEPS } from './tour.js';

const at = (extra) => ({ stage: 'on', dialog: false, screen: 'home', running: false, createStep: null, shorts: 0, made: false, ...extra });

test('the tour follows the first project in order, steps 1 to the last', () => {
  const path = [
    at({}), at({ screen: 'create', createStep: 1 }), at({ screen: 'create', createStep: 2 }), at({ screen: 'create', createStep: 3 }),
    at({ screen: 'create', createStep: 4 }), at({ screen: 'games', running: true }), at({ screen: 'editor', shorts: 3 }),
    at({ stage: 'edit', screen: 'editor', shorts: 3 }), at({ stage: 'export', screen: 'editor', shorts: 3 }),
  ].map((where) => hintFor(where).step);
  assert.deepEqual(path, [1, 2, 3, 3, 4, 5, 6, 7, 8]);
  assert.equal(path.at(-1), TOUR_STEPS);
});

test('the button steps lead on: Shorts -> edit -> export -> finish', () => {
  assert.equal(hintFor(at({ screen: 'editor', shorts: 2 })).then, 'edit');
  assert.equal(hintFor(at({ stage: 'edit', screen: 'editor', shorts: 2 })).then, 'export');
  assert.equal(hintFor(at({ stage: 'export', screen: 'editor', shorts: 2 })).then, 'finish');
});

test('no hint when the tour is off, done, behind a dialog, or there is nothing to point at', () => {
  assert.equal(hintFor(at({ stage: null })), null);
  assert.equal(hintFor(at({ stage: 'done' })), null);
  assert.equal(hintFor(at({ dialog: true })), null);
  assert.equal(hintFor(at({ screen: 'settings' })), null);
  assert.equal(hintFor(at({ screen: 'editor', shorts: 0 })), null);
  assert.equal(hintFor(at({ stage: 'export', screen: 'home' })), null);
});

test('while Shorts are made the hint is on the progress card, or on the game cards on the games screen', () => {
  assert.equal(hintFor(at({ screen: 'create', createStep: 4, running: true })).target, '#progress .progress-card');
  assert.equal(hintFor(at({ screen: 'games', running: true })).target, '.games-grid');
});

test('coming back to Home with Shorts already made points at the project, not at Start creating', () => {
  assert.equal(hintFor(at({ made: true })).target, '.project-card');
  assert.equal(hintFor(at({ made: false })).target, '.start-card');
});

test('Back on the button steps returns one step', () => {
  assert.equal(hintFor(at({ stage: 'edit', screen: 'editor', shorts: 2 })).back, 'on');
  assert.equal(hintFor(at({ stage: 'export', screen: 'editor', shorts: 2 })).back, 'edit');
});
