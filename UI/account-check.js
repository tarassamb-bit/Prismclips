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

function page(initial, query, { origin = 'https://example.test', pathname = '/dashboard_user-1', authPage = 'dashboard' } = {}) {
  const ids = ['account', 'auth', 'signedIn', 'status', 'rows', 'who', 'export-count', 'shorts', 'minutes'];
  const nodes = Object.fromEntries(ids.map((id) => [id, new Element()]));
  nodes.auth.elements = [];
  const fields = { email: { value: 'creator@example.com' }, password: { value: 'test-password' } };
  nodes.auth.elements.namedItem = (name) => fields[name];
  nodes.auth.reportValidity = () => true;
  const signUps = [];
  let authChanged;
  const db = {
    auth: {
      getSession: () => initial, onAuthStateChange: (fn) => { authChanged = fn; },
      signUp: async (request) => { signUps.push(request); return { data: { session: null }, error: null }; },
    },
    from() {
      const chain = {
        select() { return this; }, order() { return this; }, limit() { return this; }, or() { return this; },
        then(ok, fail) { return query().then(ok, fail); },
      };
      return chain;
    },
  };
  const location = {
    origin, pathname, search: '', replacements: [],
    replace(url) { this.replacements.push(url); },
  };
  const document = {
    body: { dataset: { authPage } }, getElementById: (id) => nodes[id] ?? null,
    querySelector: () => null, querySelectorAll: () => [], createElement: () => new Element(),
  };
  const window = { prismDb: db, location, setTimeout };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/account.js`, 'utf8'), {
    window, document, location, history: { replaceState() {} }, URL, URLSearchParams, Intl, console,
  });
  return { nodes, location, fields, signUps, emit: (session) => authChanged('CHANGE', session) };
}

(async () => {
  const session = { user: { id: 'user-1', email: 'creator@example.com' } };
  // The dashboard moved into the app's Settings: a signed-in visit (or a restored session) ends up there, a signed-out one at /login.
  const initial = deferred();
  const restored = page(initial.promise, async () => ({ data: [], error: null }));
  restored.emit(session);
  await flush();
  assert.equal(restored.location.replacements.at(-1), '/app/settings/overview');
  initial.reject(new Error('An older restore failed'));
  await flush();
  assert.equal(restored.location.replacements.at(-1), '/app/settings/overview', 'a stale restore error cannot undo the redirect');
  assert.doesNotMatch(restored.nodes.status.textContent, /older restore failed/);

  const stats = deferred();
  const signedOut = page(Promise.resolve({ data: { session }, error: null }), () => stats.promise);
  await flush();
  assert.equal(signedOut.location.replacements.at(-1), '/app/settings/overview');
  signedOut.emit(null);
  await flush();
  assert.equal(signedOut.nodes.signedIn.hidden, true);
  assert.equal(signedOut.location.replacements.at(-1), '/login');
  assert.equal(signedOut.nodes.who.textContent, '');

  // Signing in on the login page goes straight to the app's Settings.
  const login = page(Promise.resolve({ data: { session }, error: null }), async () => ({ data: [], error: null }), { pathname: '/login', authPage: 'login' });
  await flush();
  assert.equal(login.location.replacements.at(-1), '/app/settings/overview');

  for (const origin of ['https://relioclips.com', 'http://localhost:4173']) {
    const signup = page(Promise.resolve({ data: { session: null }, error: null }), async () => ({ data: [], error: null }), {
      origin, pathname: '/signup', authPage: 'login',
    });
    await flush();
    await signup.nodes.auth.events.submit({ preventDefault() {}, submitter: { value: 'up' } });
    assert.equal(signup.signUps.length, 1);
    assert.equal(signup.signUps[0].options.emailRedirectTo, `${origin}/login`);
    assert.match(signup.nodes.status.textContent, /Check your inbox/);
    assert.equal(signup.fields.password.value, '');
    assert.deepEqual(signup.location.replacements, [], 'confirmation is required before redirecting to the dashboard');
  }
  console.log('account-check: auth races and signup confirmation redirects passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
