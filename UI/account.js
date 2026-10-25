(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const account = byId('account');
  const form = byId('auth');
  const signedIn = byId('signedIn');
  const status = byId('status');
  if (!account || !form || !signedIn || !status) return;

  const formWrap = byId('auth-form-wrap') || form;
  const signInButton = byId('auth-submit');
  const createButton = byId('auth-create');
  const signOutButton = byId('signOut');
  const pageTitle = document.querySelector('[data-account-title]');
  const pageDescription = document.querySelector('[data-account-description]');
  const signedOutTitle = pageTitle?.textContent;
  const signedOutDescription = pageDescription?.textContent;
  const originalButtonContent = new Map(
    [signInButton, createButton, signOutButton]
      .filter(Boolean)
      .map((button) => [button, Array.from(button.childNodes)]),
  );
  const emailInput = form.elements.namedItem('email');
  const passwordInput = form.elements.namedItem('password');
  const rows = byId('rows');
  const numberFormat = new Intl.NumberFormat();
  const minuteFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  let currentUserId = null;
  let statsRequest = 0;
  let pending = false;
  let available = false;

  function say(message, kind = 'info') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function updateButtons(action = '') {
    form.setAttribute('aria-busy', String(pending));
    for (const control of form.elements) control.disabled = pending || !available;
    if (signOutButton) signOutButton.disabled = pending || !available;
    for (const [button, type, label] of [
      [signInButton, 'in', 'Signing in…'],
      [createButton, 'up', 'Creating account…'],
      [signOutButton, 'out', 'Signing out…'],
    ]) {
      if (!button) continue;
      if (action === type) button.textContent = label;
      else button.replaceChildren(...originalButtonContent.get(button));
    }
  }

  function setPending(value, action = '') {
    pending = value;
    updateButtons(action);
  }

  function tableMessage(message) {
    if (!rows) return;
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'table-message';
    cell.textContent = message;
    row.append(cell);
    rows.replaceChildren(row);
  }

  function clearStats() {
    for (const id of ['export-count', 'shorts', 'minutes']) {
      if (byId(id)) byId(id).textContent = '—';
    }
    rows?.replaceChildren();
  }

  function formatDuration(seconds) {
    const rounded = Math.round(seconds);
    const minutes = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return minutes ? `${numberFormat.format(minutes)}m ${remainder}s` : `${remainder}s`;
  }

  function renderRows(exports) {
    if (!rows) return;
    if (!exports.length) {
      tableMessage('Your exported Shorts will appear here.');
      return;
    }
    const qualityLabels = { full: 'Full', compact: 'Compact', small: 'Small' };
    const elements = exports.map((entry) => {
      const row = document.createElement('tr');
      const date = new Date(entry.created_at);
      const values = [
        date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
        numberFormat.format(entry.short_count),
        formatDuration(entry.seconds),
        qualityLabels[entry.quality] || entry.quality,
      ];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (index === 1 || index === 2) cell.className = 'num';
        if (index === 0) cell.title = date.toLocaleString();
        row.append(cell);
      });
      return row;
    });
    rows.replaceChildren(...elements);
  }

  // Created once per page by supabase-client.js.
  const db = window.prismDb;
  if (!db) {
    account.dataset.state = 'unavailable';
    updateButtons();
    say('Account services couldn’t load. Refresh the page to try again.', 'error');
    return;
  }
  available = true;

  // ?next=/pricing returns the user where they came from. Only same-site paths are allowed; parsing
  // the URL also catches tricks like "/\evil.com" that a simple prefix check lets through.
  function nextPath() {
    const next = new URLSearchParams(location.search).get('next');
    if (!next) return null;
    try {
      const url = new URL(next, location.origin);
      return url.origin === location.origin ? url.pathname + url.search + url.hash : null;
    } catch {
      return null;
    }
  }

  async function loadStats() {
    const request = ++statsRequest;
    account.dataset.state = 'loading';
    signedIn.setAttribute('aria-busy', 'true');
    clearStats();
    tableMessage('Loading your export history…');
    say('Loading your export history…');

    try {
      let cursor = null;
      let totalExports = 0;
      let totalShorts = 0;
      let totalSeconds = 0;
      const latest = [];

      // Fetch the latest 50 for the table, then walk the remaining history for
      // totals. A stable keyset avoids both the server's row cap and shifting
      // offset pages when a new export arrives while this request is running.
      while (true) {
        let query = db.from('exports')
          .select('id, created_at, short_count, seconds, quality')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(cursor ? 500 : 50);
        if (cursor) {
          query = query.or(
            `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
          );
        }
        const { data, error } = await query;
        if (request !== statsRequest) return;
        if (error) throw error;
        if (!Array.isArray(data)) throw new Error('The server returned an unexpected response.');
        if (!cursor || latest.length < 50) {
          latest.push(...data.slice(0, 50 - latest.length));
          renderRows(latest);
        }
        if (!data.length) break;

        for (const entry of data) {
          totalExports += 1;
          totalShorts += entry.short_count;
          totalSeconds += entry.seconds;
        }
        const last = data[data.length - 1];
        if (cursor?.id === last.id) throw new Error('The export history could not be fully loaded.');
        cursor = last;
        say('Calculating totals across your export history…');
      }

      if (byId('export-count')) byId('export-count').textContent = numberFormat.format(totalExports);
      if (byId('shorts')) byId('shorts').textContent = numberFormat.format(totalShorts);
      if (byId('minutes')) byId('minutes').textContent = minuteFormat.format(totalSeconds / 60);
      account.dataset.state = 'signed-in';
      say(totalExports === 0
        ? 'No exports yet. Sign in to Prism for Mac and export your first Short.'
        : totalExports > 50 ? 'Showing your latest 50 exports. Totals include your full history.' : 'Your export history is up to date.');
    } catch (error) {
      if (request !== statsRequest) return;
      account.dataset.state = 'error';
      say(`Couldn’t load your stats. ${error?.message || 'Please refresh the page to try again.'}`, 'error');
      if (!rows?.children.length || rows.querySelector('.table-message')) {
        tableMessage('Export history is unavailable. Please try again later.');
      }
    } finally {
      if (request === statsRequest) signedIn.setAttribute('aria-busy', 'false');
    }
  }

  function authErrorMessage(error) {
    // Supabase limits how many sign-up emails go out per hour.
    if (error?.code === 'over_email_send_rate_limit') {
      return 'Too many sign-up emails were sent in the last hour. Please try again a bit later.';
    }
    if (error?.status === 429) return 'Too many attempts. Wait a minute, then try again.';
    return error?.message || 'Couldn’t connect. Please try again.';
  }

  function showSession(session) {
    const user = session?.user;
    const userId = user?.id || null;
    const page = document.body.dataset.authPage;
    const changed = userId !== currentUserId;
    if (changed) {
      // Revoke old queries before redirects: navigation can be delayed or restored from the browser cache.
      statsRequest += 1;
      currentUserId = userId;
      clearStats();
      signedIn.hidden = true;
      signedIn.setAttribute('aria-busy', 'false');
      if (byId('who')) byId('who').textContent = '';
    }
    if (userId && page === 'login') {
      location.replace(nextPath() || `/dashboard_${userId}`);
      return;
    }
    if (!userId && page === 'dashboard') {
      location.replace('/login');
      return;
    }
    if (userId && page === 'dashboard' && location.pathname !== `/dashboard_${userId}`) {
      history.replaceState(null, '', `/dashboard_${userId}`);
    }
    formWrap.hidden = Boolean(userId);
    signedIn.hidden = !userId;
    if (pageTitle) pageTitle.textContent = userId ? 'Your export history' : signedOutTitle;
    if (pageDescription) pageDescription.textContent = userId
      ? 'Track your exports, Shorts, and time created with Prism for Mac.'
      : signedOutDescription;
    document.querySelectorAll('.nav-signin').forEach((link) => { link.textContent = userId ? 'Your account' : 'Sign in'; });
    if (!changed) {
      if (!userId) account.dataset.state = 'signed-out';
      return;
    }
    if (!userId) {
      if (byId('who')) byId('who').textContent = '';
      signedIn.setAttribute('aria-busy', 'false');
      account.dataset.state = 'signed-out';
      say('');
      return;
    }
    if (byId('who')) byId('who').textContent = user.email || 'Your Prism account';
    void loadStats();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || !available || !form.reportValidity()) return;
    const action = event.submitter?.value === 'up' ? 'up' : 'in';
    const credentials = { email: emailInput.value.trim(), password: passwordInput.value };
    setPending(true, action);
    say(action === 'up' ? 'Creating your account…' : 'Signing in…');
    try {
      const { data, error } = action === 'up'
        ? await db.auth.signUp({
          ...credentials,
          options: { emailRedirectTo: window.location.origin + window.location.pathname },
        })
        : await db.auth.signInWithPassword(credentials);
      if (error) throw error;
      passwordInput.value = '';
      if (data?.session) showSession(data.session);
      else say(action === 'up'
        ? 'Check your inbox to confirm your email, then sign in here.'
        : 'Your session couldn’t be established. Please try signing in again.');
    } catch (error) {
      say(authErrorMessage(error), 'error');
    } finally {
      setPending(false);
    }
  });

  signOutButton?.addEventListener('click', async () => {
    if (pending || !available) return;
    setPending(true, 'out');
    say('Signing out…');
    try {
      const { error } = await db.auth.signOut();
      if (error) throw error;
      showSession(null);
      say('You’re signed out.');
    } catch (error) {
      say(error?.message || 'Couldn’t sign out. Please try again.', 'error');
    } finally {
      setPending(false);
    }
  });

  account.dataset.state = 'initializing';
  setPending(true);
  say('Checking your session…');
  let authRevision = 0;
  db.auth.onAuthStateChange((_event, session) => {
    const revision = ++authRevision;
    // Leave Supabase's auth callback before making any authenticated queries.
    window.setTimeout(() => {
      if (revision !== authRevision) return;
      showSession(session);
    }, 0);
  });
  const initialRevision = authRevision;
  Promise.resolve().then(() => db.auth.getSession()).then(({ data, error }) => {
    if (error) throw error;
    if (authRevision === initialRevision) showSession(data?.session || null);
    if (!currentUserId) say('');
  }).catch((error) => {
    if (authRevision !== initialRevision) return;
    say(`Couldn’t restore your session. ${error?.message || 'Please sign in again.'}`, 'error');
    account.dataset.state = 'signed-out';
  }).finally(() => {
    setPending(false);
  });
})();
