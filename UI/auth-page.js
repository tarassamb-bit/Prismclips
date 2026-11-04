// The website's /login and /signup: the full-screen sign-in screen (auth.js). Signed in already, or once signed in, the
// visitor goes on to ?next (same site only) or to the app's stats.
(() => {
  const db = window.prismDb;
  const root = document.getElementById('auth-root');
  if (!db || !root) return;
  const next = (() => {
    const value = new URLSearchParams(location.search).get('next');
    if (!value) return '/app/settings/overview';
    try { const url = new URL(value, location.origin); return url.origin === location.origin ? url.pathname + url.search + url.hash : '/app/'; } catch { return '/app/'; }
  })();
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') === 'signup' || document.body.dataset.authPage === 'signup' ? 'signup' : 'signin';
  const reset = params.get('mode') === 'reset' || location.hash.includes('type=recovery');
  window.prismAuth.mount(root, { db, mode, redirectTo: location.origin + '/app/', onSignedIn: () => location.replace(next) });
  // Already signed in: straight on (except when choosing a new password from the email link).
  if (!reset) db.auth.getSession().then(({ data }) => { if (data.session) location.replace(next); });
})();
