// Auth/analytics regressions against the real page script. No network or browser account is used.
// Run: node UI/account-check.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  children = [];
  childNodes = [];
  dataset = {};
  attributes = {};
  events = {};
  textContent = '';
  hidden = false;
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, fn) { this.events[name] = fn; }
  querySelector() { return null; }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function page(initial, query) {
  const ids = ['account', 'auth', 'signedIn', 'status', 'rows', 'who', 'export-count', 'shorts', 'minutes'];
  const nodes = Object.fromEntries(ids.map((id) => [id, new Element()]));
  nodes.auth.elements = [];
  nodes.auth.elements.namedItem = () => ({ value: '' });
  let authChanged;
  const db = {
    auth: { getSession: () => initial, onAuthStateChange: (fn) => { authChanged = fn; } },
    from() {
      const chain = {
        select() { return this; }, order() { return this; }, limit() { return this; }, or() { return this; },
        then(ok, fail) { return query().then(ok, fail); },
      };
      return chain;
    },
  };
  const location = {
    origin: 'https://example.test', pathname: '/dashboard_user-1', search: '', replacements: [],
    replace(url) { this.replacements.push(url); },
  };
  const document = {
    body: { dataset: { authPage: 'dashboard' } }, getElementById: (id) => nodes[id] ?? null,
    querySelector: () => null, querySelectorAll: () => [], createElement: () => new Element(),
  };
  const window = { prismDb: db, location, setTimeout };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/account.js`, 'utf8'), {
    window, document, location, history: { replaceState() {} }, URL, URLSearchParams, Intl, console,
  });
  return { nodes, location, emit: (session) => authChanged('CHANGE', session) };
}

(async () => {
  const session = { user: { id: 'user-1', email: 'creator@example.com' } };
  const initial = deferred();
  const restored = page(initial.promise, async () => ({ data: [], error: null }));
  restored.emit(session);
  await flush();
  assert.equal(restored.nodes.account.dataset.state, 'signed-in');
  initial.reject(new Error('An older restore failed'));
  await flush();
  assert.equal(restored.nodes.account.dataset.state, 'signed-in', 'a stale restore error cannot override a newer auth event');
  assert.doesNotMatch(restored.nodes.status.textContent, /older restore failed/);

  const stats = deferred();
  const signedOut = page(Promise.resolve({ data: { session }, error: null }), () => stats.promise);
  await flush();
  assert.equal(signedOut.nodes.account.dataset.state, 'loading');
  signedOut.emit(null);
  await flush();
  assert.equal(signedOut.nodes.signedIn.hidden, true);
  assert.equal(signedOut.location.replacements.at(-1), '/login');
  stats.resolve({ data: [{ id: 'export-1', created_at: '2026-10-25T00:00:00Z', short_count: 9, seconds: 60, quality: 'full' }], error: null });
  await flush();
  assert.equal(signedOut.nodes['export-count'].textContent, '—', 'old stats stay cleared while sign-out navigation is pending');
  assert.equal(signedOut.nodes.who.textContent, '');
  console.log('account-check: stale restore failures and pending stats after sign-out passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
