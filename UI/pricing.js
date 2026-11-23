(() => {
  'use strict';
  // Paddle's checkout follows the page's theme: light or dark, the person's choice first, then their system's.
  const prismTheme = () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

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
  let currentPrice = null; // the active plan's price, so its card says "Your plan" and the others offer a switch
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
    const price = el('p', 'price', tier.price ?? '…');
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
      button.textContent = !user ? 'Sign in to subscribe' : hasPlan ? 'Switch to this plan' : 'Subscribe';
    }
    for (const { tier, button } of cards) if (hasPlan && tier.priceId === currentPrice) button.textContent = 'Your plan';
    // A lower plan can't be switched to from here (the server refuses it too).
    const rank = (priceId) => tiers.findIndex((t) => t.priceId === priceId);
    for (const { tier, button } of cards) {
      if (hasPlan && currentPrice && rank(tier.priceId) < rank(currentPrice)) { button.disabled = true; button.textContent = 'Lower plan: at renewal'; }
    }
  }

  // One plan per account: a second checkout would start a second subscription.
  async function checkPlan() {
    if (!db || !user) return false;
    const { data, error } = await db.from('subscriptions').select('id,price_id').in('status', ACTIVE).limit(1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('The server returned an unexpected plan response.');
    currentPrice = data[0]?.price_id ?? null;
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
      hasPlan = await checkPlan();
      if (hasPlan) {
        label();
        await switchPlan(tier);
        return;
      }
      say('');
      const withPack = await offerPack(tier);
      if (withPack === null) return;
      // The add-on dialog can stay open while another tab signs out, switches accounts, or starts a plan.
      const latestUser = (await db?.auth.getSession())?.data?.session?.user ?? null;
      if (latestUser?.id !== user.id) {
        user = latestUser;
        hasPlan = false;
        label();
        say('Your account changed. Please start checkout again for the current account.', 'error');
        return;
      }
      user = latestUser;
      hasPlan = await checkPlan();
      if (hasPlan) {
        label();
        location.href = '/app/settings/plans';
        return;
      }
      paddle.Checkout.open({
        items: [{ priceId: tier.priceId, quantity: 1 }, ...(withPack ? [{ priceId: pack.priceId, quantity: 1 }] : [])],
        customer: user.email ? { email: user.email } : undefined,
        customData: { supabase_user_id: user.id },
        settings: { displayMode: 'overlay', variant: 'one-page', theme: prismTheme() },
      });
    } catch (error) {
      say(`Couldn’t open checkout. ${error.message || 'Please try again.'}`, 'error');
    } finally {
      opening = false;
      for (const { button } of cards) button.disabled = finishing;
    }
  }

  /** An active plan is changed in place (Paddle prorates it), never bought a second time. */
  async function switchPlan(tier) {
    if (tier.priceId === currentPrice) { say(`You’re already on ${tier.name}.`); return; }
    if (tiers.findIndex((t) => t.priceId === tier.priceId) < tiers.findIndex((t) => t.priceId === currentPrice)) {
      say('You can only switch to a higher plan. To go lower, cancel and subscribe to the lower plan when your current one ends.', 'error'); return;
    }
    if (!confirm(`Switch to ${tier.name}? Paddle charges or credits the difference for the rest of this month right away; your renewal date stays the same.`)) return;
    say(`Switching to ${tier.name}…`);
    const token = (await db.auth.getSession())?.data?.session?.access_token;
    const response = await fetch(`/api/billing?action=change&price_id=${encodeURIComponent(tier.priceId)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    const body = await response?.json().catch(() => ({}));
    if (!response?.ok) { say(body?.error || 'Couldn’t change your plan. Please try again.', 'error'); return; }
    say(`You’re on ${tier.name} now.`);
    location.href = '/app/settings/plans';
  }

  // The add-on, offered once before checkout: true to add it, false without it, null when the person closes the box.
  const pack = window.PRISM_PACK;
  let packPrice = '';
  function offerPack(tier) {
    if (!pack) return Promise.resolve(false);
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'bump';
      dialog.innerHTML = `<form method="dialog" class="bump-body">
          <p class="card-eyebrow">ONE MORE THING</p>
          <h3>Need more minutes this month?</h3>
          <label class="bump-option"><input type="checkbox" name="pack">
            <span><strong>Add ${pack.minutes} extra video minutes${packPrice ? ` for ${packPrice}` : ''}</strong>
            <span class="muted">On top of ${tier.name}, for this month. Paid once, no subscription.</span></span></label>
          <div class="bump-actions"><button class="button button-secondary" value="cancel" type="submit">Back</button>
            <button class="button button-primary" value="go" type="submit">Continue to checkout</button></div>
        </form>`;
      document.body.append(dialog);
      dialog.addEventListener('close', () => {
        const go = dialog.returnValue === 'go';
        resolve(go ? dialog.querySelector('[name=pack]').checked : null);
        dialog.remove();
      });
      dialog.showModal();
    });
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
      .finally(() => location.assign(new URLSearchParams(location.search).get('pack') === 'live' ? '/app/live' : new URLSearchParams(location.search).has('pack') ? '/app/settings/usage' : '/app'));
  }

  async function start() {
    const response = await fetch('/api/paddle-config', { cache: 'no-store' });
    const config = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(config.error || `The pricing service answered ${response.status}.`);
    if (typeof window.Paddle?.Initialize !== 'function') {
      throw new Error('The payment script didn’t load. If you use a content blocker, allow cdn.paddle.com.');
    }

    if (config.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
    const customer = (await Promise.resolve(db?.from('subscriptions').select('customer_id').order('event_at', { ascending: false }).limit(1).maybeSingle()).catch(() => null))?.data?.customer_id;
    // Paddle Retain knows the person by their Paddle customer ID (never our own ID or their email).
    window.Paddle.Initialize({ token: config.token, eventCallback: onCheckoutEvent, ...(customer && { pwCustomer: { id: customer } }) });
    paddle = window.Paddle;

    user = (await db?.auth.getSession().catch(() => null))?.data?.session?.user ?? null;
    hasPlan = await checkPlan();

    const preview = await paddle.PricePreview({
      items: [...tiers.map((tier) => ({ priceId: tier.priceId, quantity: 1 })), ...(pack ? [{ priceId: pack.priceId, quantity: 1 }] : [])],
      ...(config.country && { address: { countryCode: config.country } }),
    });
    const totals = new Map(preview.data.details.lineItems.map((item) => [item.price.id, item.formattedTotals.total]));
    if (pack) packPrice = totals.get(pack.priceId) ?? '';
    for (const { tier, price, per, button } of cards) {
      price.textContent = totals.get(tier.priceId) ?? tier.price ?? '—';
      price.append(per);
      button.disabled = false;
    }
    label();
    say('');
    // /pricing?pack=minutes or ?pack=live (from the app, when minutes or Live hours run out): straight to that pack's checkout.
    const wanted = new URLSearchParams(location.search).get('pack');
    if (wanted) await buyPack(wanted === 'live' ? 'live' : 'minutes');
  }

  /** A checkout for one pack only: 'minutes' (video minutes) or 'live' (Live hours). */
  async function buyPack(kind) {
    const chosen = kind === 'live' ? window.PRISM_LIVE_PACK : pack;
    if (!chosen) return;
    if (!user) { location.href = '/login?next=' + encodeURIComponent(`/pricing?pack=${kind}`); return; }
    const latestUser = (await db?.auth.getSession())?.data?.session?.user ?? null;
    if (latestUser?.id !== user.id) {
      user = latestUser;
      hasPlan = false;
      label();
      say('Your account changed. Please open the minutes purchase again for the current account.', 'error');
      return;
    }
    user = latestUser;
    say(kind === 'live' ? `Buying ${chosen.hours} extra Live hours for this month.` : `Buying ${chosen.minutes} extra video minutes for this month${packPrice ? ` (${packPrice})` : ''}.`);
    paddle.Checkout.open({
      items: [{ priceId: chosen.priceId, quantity: 1 }],
      customer: user.email ? { email: user.email } : undefined,
      customData: { supabase_user_id: user.id },
      settings: { displayMode: 'overlay', variant: 'one-page', theme: prismTheme() },
    });
  }

  say('Loading prices for your country…');
  start().catch((error) => {
    console.error(error);
    const detail = error?.error?.detail || error?.message || String(error);
    say(`Prices couldn’t load. ${detail} Refresh the page to try again.`, 'error');
  });
})();
