import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const code = app.slice(app.indexOf('function dialogControls('), app.indexOf('\nfunction openDialog('));
const document = { activeElement: null };
const context = vm.createContext({ document, getComputedStyle: (el) => ({ visibility: el.visibility ?? 'visible' }) });
vm.runInContext(`${code}\nthis.trapDialogFocus = trapDialogFocus;`, context);

test('Tab and Shift+Tab wrap within a dialog and skip hidden or disabled controls', () => {
  const control = (options = {}) => ({ disabled: false, getClientRects: () => [1], ...options, focus() { document.activeElement = this; } });
  const first = control(), disabled = control({ disabled: true }), hidden = control({ getClientRects: () => [] }), last = control();
  const host = { querySelectorAll: () => [first, disabled, hidden, last] };
  const tab = (shiftKey = false) => {
    const event = { key: 'Tab', shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
    context.trapDialogFocus(event, host);
    return event.prevented;
  };
  document.activeElement = last;
  assert.equal(tab(), true);
  assert.equal(document.activeElement, first);
  assert.equal(tab(true), true);
  assert.equal(document.activeElement, last);
  document.activeElement = first;
  assert.equal(tab(), false, 'normal tab movement within the dialog remains native');
  document.activeElement = {};
  assert.equal(tab(), true);
  assert.equal(document.activeElement, first);
});

test('a dialog without focusable controls keeps focus on the dialog itself', () => {
  let focused = false, prevented = false;
  const host = { querySelectorAll: () => [], querySelector: () => ({ focus() { focused = true; } }) };
  context.trapDialogFocus({ key: 'Tab', preventDefault() { prevented = true; } }, host);
  assert.ok(focused && prevented);
});
