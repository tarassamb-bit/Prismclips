// Cloudflare Turnstile "I'm human" check on the sign-up forms (website and web app). The token goes with the sign-up as user
// metadata `turnstile`; the signup-guard hook (supabase/functions/signup-guard) verifies it and refuses sign-ups without one.
// Sign-in never needs it. The widget only asks for a click when Cloudflare isn't sure (appearance: interaction-only).
window.prismTurnstile = (() => {
  // The widget's site key (public; Cloudflare → Turnstile → Prism). Empty: no widget, sign-ups carry no token.
  const SITE_KEY = '0x4AAAAAAFzgmODMQZteUhwA';
  let loading = null;

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
    let id = null, current = null, waiting = [];
    const settle = (token) => { current = token; for (const resolve of waiting) resolve(token); waiting = []; };
    const ready = load().then((turnstile) => {
      id = turnstile.render(container, {
        sitekey: SITE_KEY, appearance: 'interaction-only', action: 'signup',
        callback: settle, 'expired-callback': () => { current = null; }, 'error-callback': () => { current = null; },
      });
    });
    return {
      /** The current token, waiting up to 30 s for the check to finish; a token works once. */
      async token() {
        await ready;
        if (current) return current;
        return await Promise.race([
          new Promise((resolve) => waiting.push(resolve)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Please complete the “I’m human” check, then try again.')), 30_000)),
        ]);
      },
      /** A fresh check for the next attempt (each token is single-use). */
      reset() { current = null; if (id !== null) window.turnstile?.reset(id); },
    };
  }

  return { mount };
})();
