// The full-screen sign-in and sign-up screen, shared by the website (/login, /signup) and the web app's gate.
// Modes: signin, signup (name, unique username, email, password + confirm, terms, "I'm human" check), forgot (email a reset
// link), reset (choose a new password from that link). Google sign-in on the first two. Uses the page's Supabase client and,
// when loaded, beta.js (spots left, waitlist), turnstile.js and analytics.js.
window.prismAuth = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const USERNAME = /^[a-z0-9_]{3,20}$/;
  // Google sign-in: off until a Google OAuth client is set up in Supabase (Authentication → Providers → Google).
  const GOOGLE_SIGN_IN = false;
  const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const GOOGLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h6a5.1 5.1 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.2-4.8 3.2-8Z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.4-2.7l-3.6-2.7c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2v2.8A11 11 0 0 0 12 23Z"/><path fill="#FBBC05" d="M5.7 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2a11 11 0 0 0 0 9.8l3.7-2.8Z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2 7.1l3.7 2.8C6.6 7.3 9.1 5.4 12 5.4Z"/></svg>';

  /** 0–4 from length and variety; shown as weak / fair / good / strong. */
  function strength(password) {
    if (!password) return 0;
    let score = password.length >= 8 ? 1 : 0;
    if (password.length >= 12) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
    else if (/\d|[^A-Za-z0-9]/.test(password)) score += 0.5;
    return Math.min(4, Math.floor(score));
  }

  /** Supabase's wording, in plain words. */
  function friendly(error) {
    const message = error?.message ?? String(error ?? '');
    if (/invalid login credentials/i.test(message)) return 'That email and password don’t match. Check them, or reset your password.';
    if (/already registered|already exists/i.test(message)) return 'There’s already an account with this email. Sign in instead.';
    if (/email not confirmed/i.test(message)) return 'Confirm your email first: open the link we sent you, then sign in.';
    if (/rate limit|too many/i.test(message) || error?.status === 429) return 'Too many attempts. Wait a minute, then try again.';
    if (/provider is not enabled|unsupported provider/i.test(message)) return 'Google sign-in isn’t switched on yet. Use your email for now.';
    if (/Database error|unexpected_failure|USERNAME_TAKEN/i.test(message)) return 'Couldn’t create your account right now. Please try again in a moment.';
    if (/password/i.test(message) && /least|short|weak/i.test(message)) return 'Choose a longer password: at least 8 characters.';
    return message || 'Couldn’t connect. Check your connection and try again.';
  }

  const passwordField = (id, label, autocomplete, extra = '') => `
    <div class="auth-field"><label for="${id}">${label}</label>
      <div class="auth-password"><input id="${id}" name="${id}" type="password" autocomplete="${autocomplete}" required ${extra}>
        <button type="button" class="auth-eye" data-eye="${id}" aria-label="Show password" aria-pressed="false">${EYE}</button></div>`;

  function mount(root, { db, mode = 'signin', onSignedIn = () => {}, redirectTo = location.origin + '/app/' } = {}) {
    let current = mode, human = null, beta = null;
    const params = new URLSearchParams(location.search);
    // Google and the password-reset email come back here; a failure arrives in the address.
    const hash = new URLSearchParams(location.hash.slice(1));
    const returned = hash.get('error_description') || params.get('error_description');
    if (params.get('mode') === 'reset' || hash.get('type') === 'recovery') current = 'reset';

    function render(notice = '') {
      const titles = {
        signin: ['Welcome back', 'Sign in to keep making Shorts.'],
        signup: ['Create your account', 'Free during the beta. No API key, no credit card.'],
        forgot: ['Reset your password', 'Enter your email and we’ll send you a link to choose a new one.'],
        reset: ['Choose a new password', 'Pick a password you don’t use anywhere else.'],
      };
      const [title, lead] = titles[current];
      const tabs = current === 'signin' || current === 'signup', google = GOOGLE_SIGN_IN && tabs;
      root.innerHTML = `
        <div class="auth">
          <aside class="auth-brand">
            <a class="auth-logo" href="/"><img src="/icon.png" width="36" height="36" alt=""><span>Prism</span></a>
            <div class="auth-pitch">
              <h2>Long video in.<br><span>Shorts out.</span></h2>
              <ul>
                <li>Prism AI finds the moments worth sharing</li>
                <li>Captions, framing and export in your browser</li>
                <li>Your projects follow you to any device</li>
              </ul>
            </div>
            <p class="auth-fine">Beta · Made for creators</p>
          </aside>
          <main class="auth-main">
            <div class="auth-panel">
              ${tabs ? `<div class="auth-tabs" role="tablist">
                <button type="button" role="tab" data-mode="signin" aria-selected="${current === 'signin'}">Sign in</button>
                <button type="button" role="tab" data-mode="signup" aria-selected="${current === 'signup'}">Create account</button>
              </div>` : ''}
              <h1>${title}</h1>
              <p class="auth-lead">${lead}</p>
              ${google ? `<button type="button" class="auth-google" data-google>${GOOGLE}<span>Continue with Google</span></button>
                <div class="auth-or"><span>or with email</span></div>` : ''}
              <form class="auth-form" novalidate>${fields()}</form>
              <p class="auth-status" role="status" aria-live="polite">${esc(notice)}</p>
              ${current === 'forgot' || current === 'reset' ? '<button type="button" class="auth-link" data-mode="signin">Back to sign in</button>' : ''}
            </div>
          </main>
        </div>`;
      wire();
    }

    function fields() {
      if (current === 'signin') return `
        <div class="auth-field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" placeholder="you@example.com" required></div>
        ${passwordField('password', 'Password', 'current-password')}
          <button type="button" class="auth-link auth-forgot" data-mode="forgot">Forgot password?</button></div>
        <button class="auth-submit" type="submit">Sign in</button>`;
      if (current === 'signup') return `
        <div class="auth-row">
          <div class="auth-field"><label for="name">Name</label><input id="name" name="name" autocomplete="name" maxlength="60" placeholder="Your name" required></div>
          <div class="auth-field"><label for="username">Username</label>
            <div class="auth-at"><span>@</span><input id="username" name="username" autocomplete="off" maxlength="21" placeholder="yourname" spellcheck="false" autocapitalize="none" required></div>
            <p class="auth-hint" id="username-hint">3–20 letters, numbers or _</p></div>
        </div>
        <div class="auth-field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
        ${passwordField('password', 'Password', 'new-password', 'minlength="8"')}
          <div class="auth-meter" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <p class="auth-hint" id="password-hint">At least 8 characters</p></div>
        ${passwordField('confirm', 'Confirm password', 'new-password')}
          <p class="auth-hint" id="confirm-hint"></p></div>
        <label class="auth-check"><input type="checkbox" name="terms" required> <span>I agree to the <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy Policy</a></span></label>
        <div class="auth-human"></div>
        <button class="auth-submit" type="submit" disabled>Create account</button>`;
      if (current === 'forgot') return `
        <div class="auth-field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
        <button class="auth-submit" type="submit">Send reset link</button>`;
      return `
        ${passwordField('password', 'New password', 'new-password', 'minlength="8"')}
          <div class="auth-meter" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <p class="auth-hint" id="password-hint">At least 8 characters</p></div>
        ${passwordField('confirm', 'Confirm new password', 'new-password')}
          <p class="auth-hint" id="confirm-hint"></p></div>
        <button class="auth-submit" type="submit" disabled>Save new password</button>`;
    }

    function wire() {
      const form = root.querySelector('.auth-form');
      const status = root.querySelector('.auth-status');
      const submit = form.querySelector('.auth-submit');
      const say = (text, kind = '') => { status.textContent = text; status.dataset.kind = kind; };
      const field = (name) => form.elements.namedItem(name);

      for (const button of root.querySelectorAll('[data-mode]')) {
        button.addEventListener('click', () => { current = button.dataset.mode; history.replaceState(null, '', location.pathname + (current === 'signup' ? '?mode=signup' : '')); render(); });
      }
      for (const eye of root.querySelectorAll('[data-eye]')) {
        eye.addEventListener('click', () => {
          const input = root.querySelector(`#${eye.dataset.eye}`);
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          eye.setAttribute('aria-pressed', String(show));
          eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        });
      }
      root.querySelector('[data-google]')?.addEventListener('click', async () => {
        say('Opening Google…');
        const { error } = await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
        if (error) say(friendly(error), 'error');
      });

      const email = field('email');
      if (email && params.get('email')) email.value = params.get('email').slice(0, 254);

      // New-password forms: strength, match, and (sign-up) username and terms decide when the button works.
      let usernameOk = current !== 'signup', checkTimer = 0, checking = 0;
      const validate = () => {
        if (current === 'signin' || current === 'forgot') return;
        const password = field('password').value, confirm = field('confirm').value;
        const score = strength(password);
        root.querySelectorAll('.auth-meter span').forEach((bar, i) => { bar.dataset.on = String(i < score); });
        root.querySelector('.auth-meter').dataset.score = String(score);
        root.querySelector('#password-hint').textContent = password.length < 8 ? 'At least 8 characters'
          : ['Weak: add more characters', 'Weak: add more characters', 'Fair: mix in capitals or numbers', 'Good', 'Strong'][score];
        const confirmHint = root.querySelector('#confirm-hint');
        confirmHint.textContent = confirm && confirm !== password ? 'Passwords don’t match' : confirm && password.length >= 8 ? '✓ Passwords match' : '';
        confirmHint.dataset.kind = confirm && confirm !== password ? 'error' : 'ok';
        const base = password.length >= 8 && confirm === password;
        submit.disabled = !(current === 'reset' ? base
          : base && usernameOk && field('name').value.trim() && email.value.includes('@') && field('terms').checked);
      };
      form.addEventListener('input', validate);
      form.addEventListener('change', validate);

      if (current === 'signup') {
        const username = field('username'), hint = root.querySelector('#username-hint');
        username.addEventListener('input', () => {
          const value = username.value.trim().replace(/^@/, '').toLowerCase();
          if (username.value !== value) username.value = value;
          usernameOk = false;
          clearTimeout(checkTimer);
          hint.dataset.kind = '';
          if (!USERNAME.test(value)) { hint.textContent = value ? '3–20 letters, numbers or _' : '3–20 letters, numbers or _'; hint.dataset.kind = value.length >= 3 ? 'error' : ''; validate(); return; }
          hint.textContent = 'Checking…';
          const ticket = ++checking;
          checkTimer = setTimeout(async () => {
            // Supabase's request builders have no .catch(); Promise.resolve makes them real promises.
            const { data, error } = await Promise.resolve(db.rpc('username_available', { p_username: value })).catch((e) => ({ error: e }));
            if (ticket !== checking) return;
            // Before the profiles migration the check doesn't exist; let the server decide then.
            usernameOk = error ? true : data === true;
            hint.textContent = error ? '' : data ? `✓ @${value} is free` : `@${value} is taken`;
            hint.dataset.kind = error ? '' : data ? 'ok' : 'error';
            validate();
          }, 350);
        });
        human = window.prismTurnstile?.mount(root.querySelector('.auth-human')) ?? null;
        beta = window.prismBeta?.attach(db, form, { note: 'auth-spots', field: 'auth-field', button: 'auth-submit' }) ?? null;
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        const label = submit.textContent;
        submit.textContent = { signin: 'Signing in…', signup: 'Creating your account…', forgot: 'Sending…', reset: 'Saving…' }[current];
        try {
          if (current === 'signin') {
            const { data, error } = await db.auth.signInWithPassword({ email: email.value.trim(), password: field('password').value });
            if (error) throw error;
            return onSignedIn(data.session);
          }
          if (current === 'forgot') {
            const { error } = await db.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + '/login?mode=reset' });
            if (error) throw error;
            form.hidden = true;
            return say('If there’s an account with that email, a link to reset the password is on its way. Check your inbox.', 'ok');
          }
          if (current === 'reset') {
            const { data, error } = await db.auth.updateUser({ password: field('password').value });
            if (error) throw error;
            say('Password saved.', 'ok');
            return onSignedIn((await db.auth.getSession()).data.session ?? data);
          }
          const username = field('username').value;
          const turnstile = human ? await human.token() : undefined;
          const { data, error } = await db.auth.signUp({
            email: email.value.trim(), password: field('password').value,
            options: { emailRedirectTo: redirectTo, data: { name: field('name').value.trim(), username, ...(turnstile ? { turnstile } : {}) } },
          });
          if (error) {
            if (await beta?.signUpFailed(error)) return say('');
            // A username taken between the check and the sign-up refuses the account; say so.
            if (/Database error|unexpected_failure/i.test(error.message)) {
              const { data: free } = await Promise.resolve(db.rpc('username_available', { p_username: username })).catch(() => ({}));
              if (free === false) { usernameOk = false; root.querySelector('#username-hint').textContent = `@${username} was just taken`; throw new Error('Pick another username.'); }
            }
            throw error;
          }
          window.prismTrack?.('signup_completed');
          if (data.session) return onSignedIn(data.session);
          form.hidden = true;
          say('Almost there: open the link we emailed you to confirm your address, then sign in.', 'ok');
        } catch (error) {
          say(friendly(error), 'error');
        } finally {
          if (current === 'signup') human?.reset();
          submit.textContent = label;
          if (current === 'signin' || current === 'forgot') submit.disabled = false;
          else validate();
        }
      });

      (current === 'signup' ? field('name') : current === 'reset' ? field('password') : email)?.focus();
    }

    render(returned ? friendly({ message: returned }) : '');
    if (returned && /Database error/i.test(returned)) {
      // A Google sign-up refused by the database is most likely the beta being full.
      window.prismBeta?.spots(db).then((s) => { if (s?.left === 0) { current = 'signup'; render('The beta is full. Join the waitlist below.'); beta?.signUpFailed({ message: 'BETA_FULL' }); } });
    }
    db.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY' && current !== 'reset') { current = 'reset'; render(); } });
    return { show(next) { current = next; render(); } };
  }

  return { mount, strength };
})();
