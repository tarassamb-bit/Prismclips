// Checkout regressions against the real browser script, with disposable DOM and service doubles.
// Run: node UI/pricing-check.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  children = [];
  events = {};
  dataset = {};
  disabled = false;
  textContent = '';
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  addEventListener(name, callback) { this.events[name] = callback; }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  const grid = new Element();
  const status = new Element();
  const location = { href: '', assign(url) { this.href = url; } };
  let planResult = { data: [], error: null };
  let planCalls = 0;
  const checkouts = [];
  let sessionUser = { id: 'user-1', email: 'creator@example.com' };
  const db = {
    auth: { getSession: async () => ({ data: { session: sessionUser ? { user: sessionUser } : null } }) },
    from: () => ({ select: () => ({
      in: () => ({ limit: () => { planCalls++; return Promise.resolve(planResult); } }),
      order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }) }),
  };
  const window = {
    prismDb: db,
    PRISM_BILLING_ENABLED: true,
    PRISM_TIERS: [{ name: 'Creator', priceId: 'pri_test', features: [] }],
    Paddle: {
      Initialize() {}, Environment: { set() {} },
      PricePreview: async () => ({ data: { details: { lineItems: [{ price: { id: 'pri_test' }, formattedTotals: { total: '$10' } }] } } }),
      Checkout: { open: (options) => checkouts.push(options) },
    },
  };
  const document = { documentElement: { dataset: {} }, getElementById: (id) => id === 'tiers' ? grid : status, createElement: () => new Element() };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/pricing.js`, 'utf8'), {
    window, document, location, console, setTimeout, URLSearchParams, confirm: () => false, matchMedia: () => ({ matches: false }),
    fetch: async () => ({ ok: true, json: async () => ({ environment: 'sandbox', token: 'test_public' }) }),
  });
  await settle();
  const button = grid.children[0].children.at(-1);
  assert.equal(button.disabled, false, 'checkout becomes available after prices and plan load');

  planResult = { data: null, error: new Error('Plan service unavailable') };
  button.events.click();
  await settle();
  assert.equal(checkouts.length, 0, 'a failed plan check cannot create a duplicate paid plan');
  assert.match(status.textContent, /Plan service unavailable/);
  assert.equal(button.disabled, false, 'a failed attempt can be retried');

  let resolvePlan;
  planResult = new Promise((resolve) => { resolvePlan = resolve; });
  const before = planCalls;
  button.events.click();
  button.events.click();
  await settle();
  assert.equal(planCalls, before + 1, 'repeated clicks share one pending checkout attempt');
  assert.equal(button.disabled, true);
  resolvePlan({ data: [], error: null });
  await settle();
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].customData.supabase_user_id, 'user-1');

  planResult = { data: [{ id: 'sub_existing' }], error: null };
  button.events.click();
  await settle();
  assert.equal(checkouts.length, 1, 'an existing subscription is switched in place, never bought again');
  assert.equal(location.href, '', 'declining the switch stays on the page');
  sessionUser = null;
  button.events.click();
  await settle();
  assert.equal(checkouts.length, 1, 'signing out in another tab must prevent a stale-user checkout');
  assert.equal(location.href, '/login?next=/pricing');

  // Account and plan can change while the add-on dialog is open in this tab.
  for (const change of ['account', 'plan']) {
    const packGrid = new Element(), packStatus = new Element(), opened = [];
    let selectedUser = { id: 'user-1', email: 'one@example.com' }, existingPlan = false, dialog;
    const packDb = {
      auth: { getSession: async () => ({ data: { session: { user: selectedUser } } }) },
      from: () => ({ select: () => ({
        in: () => ({ limit: async () => ({ data: existingPlan ? [{ id: 'existing' }] : [], error: null }) }),
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      }) }),
    };
    const packLocation = { href: '', search: '' };
    const packDocument = {
      documentElement: { dataset: { theme: 'dark' } },
      getElementById: (id) => id === 'tiers' ? packGrid : packStatus,
      body: { append: (node) => { dialog = node; } },
      createElement: (tag) => {
        const node = new Element();
        if (tag === 'dialog') { node.showModal = () => {}; node.remove = () => {}; node.querySelector = () => ({ checked: false }); }
        return node;
      },
    };
    const packWindow = { ...window, prismDb: packDb, PRISM_PACK: { priceId: 'pack', minutes: 100 },
      Paddle: { ...window.Paddle, Checkout: { open: (options) => opened.push(options) } } };
    vm.runInNewContext(fs.readFileSync(`${__dirname}/pricing.js`, 'utf8'), {
      window: packWindow, document: packDocument, location: packLocation, console, setTimeout, URLSearchParams,
      fetch: async () => ({ ok: true, json: async () => ({ environment: 'sandbox', token: 'test_public' }) }),
    });
    await settle();
    packGrid.children[0].children.at(-1).events.click();
    await settle();
    assert.ok(dialog, 'the add-on dialog is open');
    if (change === 'account') selectedUser = { id: 'user-2', email: 'two@example.com' };
    else existingPlan = true;
    dialog.returnValue = 'go';
    dialog.events.close();
    await settle();
    assert.equal(opened.length, 0, `${change} change must prevent an outdated checkout`);
    if (change === 'account') assert.match(packStatus.textContent, /account changed/i);
    else assert.equal(packLocation.href, '/app/settings/plans');
  }

  {
    const packGrid = new Element(), packStatus = new Element(), opened = [];
    let selectedUser = { id: 'user-1' }, finishPreview;
    const packDb = {
      auth: { getSession: async () => ({ data: { session: { user: selectedUser } } }) },
      from: () => ({ select: () => ({
        in: () => ({ limit: async () => ({ data: [], error: null }) }),
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      }) }),
    };
    const packWindow = { ...window, prismDb: packDb, PRISM_PACK: { priceId: 'pack', minutes: 100 }, Paddle: {
      ...window.Paddle, PricePreview: () => new Promise((resolve) => { finishPreview = resolve; }),
      Checkout: { open: (options) => opened.push(options) },
    } };
    vm.runInNewContext(fs.readFileSync(`${__dirname}/pricing.js`, 'utf8'), {
      window: packWindow, document: { documentElement: { dataset: { theme: 'dark' } }, getElementById: (id) => id === 'tiers' ? packGrid : packStatus, createElement: () => new Element() },
      location: { href: '', search: '?pack=minutes' }, console, setTimeout, URLSearchParams,
      fetch: async () => ({ ok: true, json: async () => ({ environment: 'sandbox', token: 'test_public' }) }),
    });
    await settle();
    selectedUser = { id: 'user-2' };
    finishPreview({ data: { details: { lineItems: [] } } });
    await settle();
    assert.equal(opened.length, 0, 'pack checkout must not open for an account changed while prices load');
    assert.match(packStatus.textContent, /account changed/i);
  }

  const disabledGrid = new Element();
  const disabledStatus = new Element();
  let requestedConfig = false;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/pricing.js`, 'utf8'), {
    window: { ...window, PRISM_BILLING_ENABLED: false },
    document: { getElementById: (id) => id === 'tiers' ? disabledGrid : disabledStatus, createElement: () => new Element() },
    location, console, setTimeout,
    fetch: async () => { requestedConfig = true; throw new Error('Checkout must stay unavailable'); },
  });
  assert.equal(requestedConfig, false, 'disabled billing must not initialize checkout');
  assert.equal(disabledGrid.children.length, 0, 'disabled billing must not display plan cards');
  assert.match(disabledStatus.textContent, /Paid plans are not available yet/);
  console.log('pricing-check: disabled billing, checkout errors, retries, repeated clicks, existing plans and sign-out passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
