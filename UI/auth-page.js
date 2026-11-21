// The website's /login and /signup: the full-screen sign-in screen (auth.js). Signed in already, or once signed in, the
// visitor goes on to ?next (same site only) or to the app. On sign-up, someone already signed in is asked first.
(() => {
  const db = window.prismDb;
  const root = document.getElementById('auth-root');
  if (!db || !root) return;
  const next = (() => {
    const value = new URLSearchParams(location.search).get('next');
    if (!value) return '/app/';
    try { const url = new URL(value, location.origin); return url.origin === location.origin ? url.pathname + url.search + url.hash : '/app/'; } catch { return '/app/'; }
  })();
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') === 'signup' || document.body.dataset.authPage === 'signup' ? 'signup' : 'signin';
  const reset = params.get('mode') === 'reset' || location.hash.includes('type=recovery');
  window.prismAuth.mount(root, { db, mode, redirectTo: location.origin + '/app/', onSignedIn: () => location.replace(next) });
  // Already signed in: straight on (except when choosing a new password from the email link). On sign-up, say who is
  // signed in instead, so making a new account never silently opens the old one.
  if (!reset) db.auth.getSession().then(async ({ data }) => {
    if (!data.session) return;
    // A saved login the server already ended (a password change ends every session) is dropped, not used.
    const { error } = await db.auth.getUser().catch((e) => ({ error: e }));
    if (error && (error.status === 401 || error.status === 403 || /session missing|session_not_found|sub claim/i.test(error.message ?? ''))) {
      await db.auth.signOut({ scope: 'local' }).catch(() => {});
      return;
    }
    if (mode !== 'signup') return location.replace(next);
    const box = document.createElement('div');
    box.className = 'auth-signed-in';
    box.setAttribute('role', 'status');
    box.append(Object.assign(document.createElement('p'), { textContent: `You're signed in as ${data.session.user.email}.` }));
    const open = Object.assign(document.createElement('a'), { href: next, className: 'auth-submit', textContent: 'Open Relio' });
    const out = Object.assign(document.createElement('button'), { type: 'button', className: 'auth-link', textContent: 'Sign out to create a new account' });
    out.addEventListener('click', async () => { await db.auth.signOut({ scope: 'local' }).catch(() => {}); box.remove(); });
    box.append(open, out);
    root.prepend(box);
  });
})();
