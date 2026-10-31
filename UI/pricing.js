(() => {
  'use strict';

  const grid = document.getElementById('tiers');
  const status = document.getElementById('pricing-status');
  const tiers = window.PRISM_TIERS;
  const db = window.prismDb;
  if (!grid || !status || !Array.isArray(tiers)) return;

  if (window.PRISM_BILLING_ENABLED !== true) {
    status.textContent = 'Paid plans are not available yet. Beta access uses an account and a usage allowance.';
    status.dataset.kind = 'info';
    return;
  }

  const ACTIVE = ['active', 'trialing', 'past_due', 'paused'];
  let paddle = null;
  let user = null;
  let hasPlan = false;
  let finishing = false;
  let opening = false;

  function say(message, kind = 'info') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  const cards = tiers.map((tier) => {
    const card = el('article', tier.badge ? 'info-card highlight' : 'info-card');
    const top = el('div', 'platform-top');
    top.append(el('h3', '', tier.name));
    if (tier.badge) top.append(el('span', 'platform-tag', tier.badge.toUpperCase()));
    const price = el('p', 'price', '…');
    price.setAttribute('aria-live', 'polite');
    const per = el('span', '', ' / month');
    const list = el('ul');
    for (const feature of tier.features) list.append(el('li', '', feature));
    const button = el('button', tier.badge ? 'button button-primary' : 'button button-secondary', 'Subscribe');
    button.type = 'button';
    button.disabled = true;
    button.addEventListener('click', () => void subscribe(tier));
    card.append(top, el('p', '', tier.description), price);
    if (tier.trialLabel) card.append(el('p', 'card-eyebrow', tier.trialLabel.toUpperCase()));
    card.append(list, button);
    grid.append(card);
    return { tier, price, per, button };
  });

  function label() {
    for (const { button } of cards) {
      button.textContent = !user ? 'Sign in to subscribe' : hasPlan ? 'Manage your plan' : 'Subscribe';
    }
  }

  // One plan per account: a second checkout would start a second subscription.
  async function checkPlan() {
    if (!db || !user) return false;
    const { data, error } = await db.from('subscriptions').select('id').in('status', ACTIVE).limit(1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('The server returned an unexpected plan response.');
    return data.length > 0;
  }

  async function subscribe(tier) {
    if (!paddle || opening || finishing) return;
    opening = true;
    for (const { button } of cards) button.disabled = true;
    try {
      const currentUser = (await db?.auth.getSession())?.data?.session?.user ?? null;
      if (currentUser?.id !== user?.id) hasPlan = false;
      user = currentUser;
      label();
      if (!user) {
        // A sign-out or account switch in another tab must apply before checkout opens.
        location.href = '/login?next=/pricing';
        return;
      }
      // Checked again on click: a plan may have been bought in another tab since the page loaded.
      hasPlan = hasPlan || await checkPlan();
      if (hasPlan) {
        label();
        location.href = `/dashboard_${user.id}`;
        return;
      }
      say('');
      paddle.Checkout.open({
        items: [{ priceId: tier.priceId, quantity: 1 }],
        customer: user.email ? { email: user.email } : undefined,
        customData: { supabase_user_id: user.id },
        settings: { displayMode: 'overlay', variant: 'one-page' },
      });
    } catch (error) {
      say(`Couldn’t open checkout. ${error.message || 'Please try again.'}`, 'error');
    } finally {
      opening = false;
      for (const { button } of cards) button.disabled = finishing;
    }
  }

  // Saves the purchase to the account straight away instead of waiting for Paddle's webhook,
  // so the dashboard shows it at once (and on localhost, where webhooks can't arrive).
  async function recordPurchase(transactionId) {
    if (!db || !transactionId) return;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { data } = await db.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const response = await fetch(`/api/billing?action=sync&transaction_id=${encodeURIComponent(transactionId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      // 202: Paddle hasn't attached the subscription yet. Anything else is final; the webhook covers failures.
      if (response.status !== 202) return;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  function onCheckoutEvent(event) {
    if (event?.name !== 'checkout.completed' || finishing) return;
    finishing = true;
    recordPurchase(event.data?.transaction_id)
      .catch((error) => console.error(error))
      .finally(() => location.assign('/welcome'));
  }

  async function start() {
    const response = await fetch('/api/paddle-config', { cache: 'no-store' });
    const config = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(config.error || `The pricing service answered ${response.status}.`);
    if (typeof window.Paddle?.Initialize !== 'function') {
      throw new Error('The payment script didn’t load. If you use a content blocker, allow cdn.paddle.com.');
    }

    if (config.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
    window.Paddle.Initialize({ token: config.token, eventCallback: onCheckoutEvent });
    paddle = window.Paddle;

    user = (await db?.auth.getSession().catch(() => null))?.data?.session?.user ?? null;
    hasPlan = await checkPlan();

    const preview = await paddle.PricePreview({
      items: tiers.map((tier) => ({ priceId: tier.priceId, quantity: 1 })),
      ...(config.country && { address: { countryCode: config.country } }),
    });
    const totals = new Map(preview.data.details.lineItems.map((item) => [item.price.id, item.formattedTotals.total]));
    for (const { tier, price, per, button } of cards) {
      price.textContent = totals.get(tier.priceId) ?? '—';
      price.append(per);
      button.disabled = false;
    }
    label();
    say('');
  }

  say('Loading prices for your country…');
  start().catch((error) => {
    console.error(error);
    const detail = error?.error?.detail || error?.message || String(error);
    say(`Prices couldn’t load. ${detail} Refresh the page to try again.`, 'error');
  });
})();
