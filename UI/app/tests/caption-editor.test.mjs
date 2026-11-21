import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = app.indexOf('function captionTextFields(');
const end = app.indexOf('\nfunction renderInspector(', start);
const context = vm.createContext({
  mmss: (s) => `${s}s`,
  esc: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
});
vm.runInContext(`${app.slice(start, end)}\nthis.fields = captionTextFields; this.update = setCaptionText;`, context);

test('caption edits remain tied to their time even when text gains a newline', () => {
  const segment = { captions: [{ text: 'one', start: 0, duration: 2 }, { text: 'two', start: 2, duration: 3 }] };
  assert.equal(context.update(segment, 0, 'first\nsecond'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(segment.captions)), [{ text: 'first\nsecond', start: 0, duration: 2 }, { text: 'two', start: 2, duration: 3 }]);
  assert.equal(context.update(segment, 4, 'ignored'), false);
  const html = context.fields(segment.captions);
  assert.match(html, /data-cue-index="0"/);
  assert.match(html, /data-cue-index="1"/);
  assert.match(html, /first\nsecond/);
  assert.match(context.fields([{ text: '<script>', start: 0, duration: 1 }]), /&lt;script&gt;/);
  assert.match(context.fields([]), /No captions yet/);
});

test('changing one timed field saves that caption without altering neighboring cues', async () => {
  const segment = { captions: [{ text: 'first', start: 0, duration: 2 }, { text: 'second', start: 2, duration: 3 }] };
  let handler;
  const from = app.indexOf("document.addEventListener('change', async (event) => {");
  const to = app.indexOf("\ndocument.addEventListener('input',", from);
  const eventContext = vm.createContext({
    document: { addEventListener: (_event, callback) => { handler = callback; } },
    selected: () => segment,
    edit: (change) => change(segment),
    setCaptionText: context.update,
    state: {},
  });
  vm.runInContext(app.slice(from, to), eventContext);
  await handler({ target: { id: '', dataset: { field: 'captionText', cueIndex: '1' }, value: 'corrected\nwords' } });
  assert.equal(segment.captions[0].text, 'first');
  assert.equal(segment.captions[1].text, 'corrected\nwords');
  assert.equal(segment.captions[1].start, 2);
  assert.equal(segment.captions[1].duration, 3);
});
