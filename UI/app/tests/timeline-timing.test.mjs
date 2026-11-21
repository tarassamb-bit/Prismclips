// Exercise the real timing control's validation and save path without opening a project or spending AI minutes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const validation = app.slice(app.indexOf('function timelineProblem('), app.indexOf('\n/** Moves or resizes', app.indexOf('function timelineProblem(')));
const wiring = app.slice(app.indexOf('function wireTimeline('), app.indexOf('\n/** Applies an edit', app.indexOf('function wireTimeline(')));

test('precise timing rejects invalid ranges and saves a valid range', async () => {
  const handlers = {}, note = { textContent: '' }, button = { disabled: false, focus() {} };
  const start = { value: '' }, end = { value: '' }, changes = [];
  const segment = { id: 'clip', start: 1, duration: 2 };
  const nodes = {
    '#tl-track': {}, '#tl-clip': { addEventListener() {} }, '.timeline': { dataset: { total: '60' } },
    '#tl-start': start, '#tl-end': end, '#tl-error': note,
    '#tl-apply': { ...button, addEventListener: (type, fn) => { handlers[type] = fn; } },
  };
  const context = vm.createContext({
    $: (key) => nodes[key],
    edit: async (change) => change(segment),
    applyTiming: (_s, from, duration) => changes.push({ from, duration }),
    selected: () => segment,
  });
  vm.runInContext(`${validation}\n${wiring}\nthis.wireTimeline = wireTimeline;`, context);
  context.wireTimeline(segment);
  const click = () => handlers.click({ currentTarget: nodes['#tl-apply'] });
  for (const [from, to] of [['', '10'], ['-1', '10'], ['5', '5.1'], ['3', '61']]) {
    start.value = from; end.value = to; await click();
    assert.match(note.textContent, /within the video/);
  }
  assert.equal(changes.length, 0);
  start.value = '10.25'; end.value = '20.75'; await click();
  assert.equal(note.textContent, '');
  assert.deepEqual(changes, [{ from: 10.25, duration: 10.5 }]);
});
