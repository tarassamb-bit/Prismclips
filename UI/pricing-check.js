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
    from: () => ({ select: () => ({ in: () => ({ limit: () => { planCalls++; return Promise.resolve(planResult); } }) }) }),
  };
  const window = {
    prismDb: db,
    PRISM_TIERS: [{ name: 'Creator', priceId: 'pri_test', features: [] }],
    Paddle: {
      Initialize() {}, Environment: { set() {} },
      PricePreview: async () => ({ data: { details: { lineItems: [{ price: { id: 'pri_test' }, formattedTotals: { total: '$10' } }] } } }),
      Checkout: { open: (options) => checkouts.push(options) },
    },
  };
  const document = { getElementById: (id) => id === 'tiers' ? grid : status, createElement: () => new Element() };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/pricing.js`, 'utf8'), {
    window, document, location, console, setTimeout,
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
  assert.equal(checkouts.length, 1, 'an existing subscription opens account management');
  assert.equal(location.href, '/dashboard_user-1');
  sessionUser = null;
  button.events.click();
  await settle();
  assert.equal(checkouts.length, 1, 'signing out in another tab must prevent a stale-user checkout');
  assert.equal(location.href, '/login?next=/pricing');
  console.log('pricing-check: checkout errors, retries, repeated clicks, existing plans and sign-out passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
