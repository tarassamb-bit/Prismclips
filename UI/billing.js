(() => {
  'use strict';

  const plan = document.getElementById('plan');
  const tiers = document.getElementById('tiers');
  const note = document.getElementById('plans-note');
  const manage = document.getElementById('manage-billing');
  const db = window.prismDb;
  if (!plan || !tiers || !manage || !db) return;

  const ACTIVE = ['active', 'trialing', 'past_due', 'paused'];
  const STATUS = { active: 'Active', trialing: 'Free trial', past_due: 'Payment due', paused: 'Paused' };
  const tierName = (priceId) => window.PRISM_TIERS?.find((tier) => tier.priceId === priceId)?.name ?? 'Prism';
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

  function show(message, kind = 'info') {
    plan.textContent = message;
    plan.dataset.kind = kind;
  }

  async function billing(action) {
    const { data } = await db.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Sign in again.');
    const response = await fetch(`/api/billing?action=${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Billing is unavailable.');
    return body;
  }

  function describe(sub) {
    const change = sub.scheduled_change?.action === 'cancel'
      ? ` · Ends ${date(sub.scheduled_change.effective_at)}`
      : sub.next_billed_at ? ` · Next bill ${date(sub.next_billed_at)}` : '';
    return `${tierName(sub.price_id)} — ${STATUS[sub.status] ?? sub.status}${change}`;
  }

  async function render() {
    // Row level security returns only this user's subscriptions.
    const { data: subscriptions, error } = await db.from('subscriptions')
      .select('status, price_id, next_billed_at, scheduled_change')
      .in('status', ACTIVE)
      .order('event_at', { ascending: false });
    if (error) throw error;
    manage.hidden = !subscriptions.length;
    // One plan per account; cancelling and card changes happen in the billing portal.
    tiers.hidden = subscriptions.length > 0;
    if (!subscriptions.length) {
      if (window.PRISM_BILLING_ENABLED === true) {
        show('No plan yet. Pick one in Plans & billing.');
        if (note) note.textContent = 'Prices are in your local currency, with tax where it applies.';
      } else {
        show('Beta access');
        if (note) note.textContent = 'Paid plans are not available yet. Check Settings in the Mac app for your beta usage allowance.';
      }
      return;
    }
    const lines = subscriptions.map(describe);
    if (subscriptions.length > 1) {
      lines.push(`You have ${subscriptions.length} plans. Cancel the ones you don’t need in Manage billing.`);
    }
    show(lines.join('\n'));
    if (note) note.textContent = `You’re on ${tierName(subscriptions[0].price_id)}. Use Manage billing on Overview to cancel or update your card.`;
  }

  async function load() {
    try {
      await render();
    } catch (error) {
      show(`Couldn’t load your plan. ${error.message}`, 'error');
      tiers.hidden = false;
    }
    // Then catch up with Paddle in case a webhook was missed (always the case on localhost).
    try {
      await billing('refresh');
      await render();
    } catch (error) {
      console.warn('Plan refresh failed:', error);
    }
  }

  function resetManage() {
    manage.disabled = false;
    manage.textContent = 'Manage billing';
  }

  manage.addEventListener('click', async () => {
    manage.disabled = true;
    manage.textContent = 'Opening billing…';
    try {
      const { url } = await billing('portal');
      location.assign(url);
    } catch (error) {
      show(`Couldn’t open billing: ${error.message}`, 'error');
      resetManage();
    }
  });

  // Coming Back from the billing portal can restore this page from the browser's cache:
  // reset the button and pick up any change made there.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    resetManage();
    void load();
  });

  db.auth.getSession().then(({ data }) => {
    if (data.session) void load();
  });
})();
