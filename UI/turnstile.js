// Cloudflare Turnstile "I'm human" check on the sign-up forms (website and web app). The token goes with the sign-up as user
// metadata `turnstile`; the signup-guard hook (supabase/functions/signup-guard) verifies it and refuses sign-ups without one.
// Sign-in never needs it. The widget only asks for a click when Cloudflare isn't sure (appearance: interaction-only).
window.prismTurnstile = (() => {
  // The widget's site key (public; Cloudflare → Turnstile → Relio). Empty: no widget, sign-ups carry no token.
  const SITE_KEY = '0x4AAAAAAFzgmODMQZteUhwA';
  let loading = null;
  const ASK = 'Please complete the “I’m human” check. It keeps bots from creating fake accounts.';

  const load = () => loading ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    window.prismTurnstileReady = () => resolve(window.turnstile);
    const script = Object.assign(document.createElement('script'), {
      src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=prismTurnstileReady', async: true,
    });
    script.onerror = () => { loading = null; reject(new Error('The “I’m human” check couldn’t load. Check your connection, then reload.')); };
    document.head.append(script);
  });

  /** Puts the check in `container`. Returns { token() → Promise<string>, reset() }, or null when no site key is set. */
  function mount(container) {
    if (!SITE_KEY || !container) return null;
    let id = null, current = null, needsClick = false, used = false, waiting = [];
    const settle = (token) => { current = token; needsClick = false; for (const { resolve } of waiting) resolve(token); waiting = []; };
    // Cloudflare wants a click: say so now instead of letting the form wait.
    const askForClick = () => { needsClick = true; for (const { reject } of waiting) reject(new Error(ASK)); waiting = []; };
    const ready = load().then((turnstile) => {
      id = turnstile.render(container, {
        sitekey: SITE_KEY, appearance: 'interaction-only', action: 'signup',
        callback: settle, 'before-interactive-callback': askForClick, 'expired-callback': () => { current = null; }, 'error-callback': () => { current = null; },
      });
    });
    return {
      /** The current token. Fails at once when the check needs a click; otherwise waits up to 30 s for the silent check. */
      async token() {
        await ready;
        if (current) { used = true; return current; }
        if (needsClick) throw new Error(ASK);
        return await Promise.race([
          new Promise((resolve, reject) => waiting.push({ resolve: (token) => { used = true; resolve(token); }, reject })),
          new Promise((_, reject) => setTimeout(() => reject(new Error(ASK)), 30_000)),
        ]);
      },
      /** A fresh check for the next attempt (each token is single-use). An unused check stays as it is, still waiting for its click. */
      reset() { if (!used) return; used = false; current = null; needsClick = false; if (id !== null) window.turnstile?.reset(id); },
    };
  }

  return { mount };
})();
