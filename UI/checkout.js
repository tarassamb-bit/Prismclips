// Buying a pack inside the app: any link with data-pack="minutes" or "live" opens Paddle's checkout over the current page
// instead of going to /pricing (its href stays as the fallback). After paying, the purchase is saved to the account and
// the page hears 'prism:purchased' to refresh what it shows.
(() => {
  'use strict';
  // Paddle's checkout follows the page's theme: light or dark, the person's choice first, then their system's.
  const prismTheme = () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  let paddle = null;
  let loading = null;
  let kind = null;

  async function record(transactionId) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = (await window.prismDb?.auth.getSession())?.data.session?.access_token;
      if (!token || !transactionId) return;
      const response = await fetch(`/api/billing?action=sync&transaction_id=${encodeURIComponent(transactionId)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status !== 202) return; // 202: Paddle hasn't finished the transaction yet
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  function onEvent(event) {
    if (event?.name !== 'checkout.completed') return;
    const bought = kind;
    record(event.data?.transaction_id).catch(console.error).finally(() => {
      paddle?.Checkout.close();
      window.dispatchEvent(new CustomEvent('prism:purchased', { detail: { kind: bought } }));
    });
  }

  function load() {
    loading ??= (async () => {
      const response = await fetch('/api/paddle-config', { cache: 'no-store' });
      const config = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(config.error || `Checkout answered ${response.status}.`);
      if (!window.Paddle) {
        await new Promise((resolve, reject) => {
          const script = Object.assign(document.createElement('script'), { src: 'https://cdn.paddle.com/paddle/v2/paddle.js', onload: resolve });
          script.onerror = () => reject(new Error('The payment script didn’t load. If you use a content blocker, allow cdn.paddle.com.'));
          document.head.append(script);
        });
      }
      if (config.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
      const customer = (await window.prismDb?.from('subscriptions').select('customer_id').order('event_at', { ascending: false }).limit(1).maybeSingle().catch(() => null))?.data?.customer_id;
      // Paddle Retain knows the person by their Paddle customer ID (never our own ID or their email).
      window.Paddle.Initialize({ token: config.token, eventCallback: onEvent, ...(customer && { pwCustomer: { id: customer } }) });
      paddle = window.Paddle;
    })();
    loading.catch(() => { loading = null; });
    return loading;
  }

  document.addEventListener('click', async (event) => {
    const link = event.target.closest?.('a[data-pack]');
    if (!link) return;
    event.preventDefault();
    const chosen = link.dataset.pack === 'live' ? window.PRISM_LIVE_PACK : window.PRISM_PACK;
    const user = (await window.prismDb?.auth.getSession())?.data.session?.user;
    if (!chosen || !user) { location.href = link.href; return; } // the pricing page handles signing in
    try {
      await load();
      kind = link.dataset.pack;
      paddle.Checkout.open({
        items: [{ priceId: chosen.priceId, quantity: 1 }],
        customer: user.email ? { email: user.email } : undefined,
        customData: { supabase_user_id: user.id },
        settings: { displayMode: 'overlay', variant: 'one-page', theme: prismTheme() },
      });
    } catch (error) {
      console.error(error);
      location.href = link.href;
    }
  });
})();
