// Check that the Create screen's default custom range is accepted by the real clip engine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { regionInterval } from '../engine/models.js';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const defaultLine = app.match(/const defaultCustomEnd = [^\n]+/)[0];
const rangeFn = app.slice(app.indexOf('function rangeProblem('), app.indexOf('\nfunction renderCreate('));
const context = vm.createContext({ clock: (seconds) => `${seconds}s` });
vm.runInContext(`${defaultLine}\n${rangeFn}\nthis.defaultCustomEnd = defaultCustomEnd;`, context);

test('the default custom end stays inside videos of different lengths', () => {
  for (const seconds of [0.05, 1, 3.78, 63, 123.4, 3600.123]) {
    const end = context.defaultCustomEnd(seconds);
    assert.ok(end > 0 && end * 60 <= seconds);
    assert.equal(context.rangeProblem({ region: 'custom', media: { duration: seconds }, customStart: 0, customEnd: end }), null);
    assert.doesNotThrow(() => regionInterval('custom', seconds, 0, end * 60));
  }
});

test('invalid or incomplete custom ranges are rejected before generation', () => {
  for (const [start, end] of [[0, 1.01], [0, NaN], [1, 1], [-1, 0.5]]) {
    assert.ok(context.rangeProblem({ region: 'custom', media: { duration: 60 }, customStart: start, customEnd: end }));
  }
});

test('a possible first-analysis limit is shown before setup without blocking or assuming a repeat charge', () => {
  assert.equal(context.firstAnalysisNotice(600, { allowance: 20, used: 5 }), null);
  assert.equal(context.firstAnalysisNotice(600, null), null);
  const notice = context.firstAnalysisNotice(3600, { allowance: 20, used: 5 });
  assert.match(notice, /15 min remaining/);
  assert.match(notice, /first analysis/i);
  assert.match(notice, /analyzed it before.*charge may differ/i);
  assert.match(notice, /checked again/i);
});
