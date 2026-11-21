import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountLiveHome } from './live.js';

globalThis.cancelAnimationFrame = () => {};

function container() {
  let html = '', loading = null, retry = null;
  return {
    isConnected: true,
    get innerHTML() { return html; },
    set innerHTML(value) {
      if (loading) loading.isConnected = false;
      html = value;
      loading = value.includes('id="live-home-loading"') ? { isConnected: true } : null;
      retry = value.includes('id="live-retry"') ? { addEventListener(_type, fn) { this.click = fn; } } : null;
    },
    querySelector(selector) { return selector === '#live-home-loading' ? loading : selector === '#live-retry' ? retry : null; },
    querySelectorAll() { return []; },
  };
}
const ok = (data = []) => ({ data, error: null });
function database(sessions, clips = ok()) {
  return () => ({
    from: (table) => ({ select: () => ({ order: () => table === 'live_sessions' ? sessions : clips }) }),
    rpc: async () => ({ error: true }),
  });
}

test('failed recording requests show a retry rather than a false empty library', async () => {
  const element = container();
  let failure = true;
  const db = () => database(failure ? { error: new Error('offline') } : ok())();
  await mountLiveHome(element, db, () => {});
  assert.match(element.innerHTML, /Couldn’t load your recordings/);
  assert.doesNotMatch(element.innerHTML, /Your recordings will appear here/);
  const retry = element.querySelector('#live-retry');
  failure = false;
  retry.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(element.innerHTML, /Your recordings will appear here/);
});

test('a late recording list cannot replace a different screen', async () => {
  const element = container();
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const mounted = mountLiveHome(element, database(pending), () => {});
  element.innerHTML = '<p>Editor</p>';
  resolve(ok());
  await mounted;
  assert.equal(element.innerHTML, '<p>Editor</p>');
});
