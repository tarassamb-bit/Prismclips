// "Report a bug": any link or button with data-bug-report opens a small form. Reports go straight into the
// bug_reports table (insert-only for the public; see supabase/migrations/202611160001_bug_reports.sql).
// Plain fetch, so it works on site pages that don't load the Supabase library as well as in the app.
(() => {
  const URL_ = 'https://isdplhahgggundbohmlr.supabase.co/rest/v1/bug_reports';
  const KEY = 'sb_publishable_ATTcp2-mrca0swMStHHdYQ_Le851b8l';

  // The signed-in person's session, when there is one, so the report is linked to their account.
  const token = () => {
    try { return JSON.parse(localStorage.getItem('sb-isdplhahgggundbohmlr-auth-token'))?.access_token || null; } catch { return null; }
  };

  let dialog;
  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'bug-dialog';
    dialog.setAttribute('aria-labelledby', 'bug-title');
    dialog.innerHTML = `<style>
      .bug-dialog { max-width: 440px; width: calc(100% - 32px); border: 1px solid var(--border, #444); border-radius: 16px; padding: 24px;
        background: var(--surface1, var(--bg, #1b1b1f)); color: var(--text, #f2f2f2); font: inherit; }
      .bug-dialog::backdrop { background: rgba(0,0,0,.55); }
      .bug-dialog h2 { margin: 0 0 6px; font-size: 22px; }
      .bug-dialog p { margin: 0 0 14px; opacity: .75; font-size: 14px; }
      .bug-dialog label { display: grid; gap: 6px; margin-bottom: 12px; font-size: 14px; }
      .bug-dialog textarea, .bug-dialog input { font: inherit; color: inherit; background: var(--surface2, rgba(255,255,255,.06));
        border: 1px solid var(--border, #444); border-radius: 10px; padding: 10px 12px; width: 100%; box-sizing: border-box; }
      .bug-dialog textarea { min-height: 120px; resize: vertical; }
      .bug-row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 6px; }
      .bug-row button { font: inherit; border-radius: 999px; padding: 10px 18px; cursor: pointer; border: 1px solid var(--border, #444);
        background: transparent; color: inherit; }
      .bug-row button[type=submit] { background: var(--sky, #3fa9f5); border-color: var(--sky, #3fa9f5); color: #0b0b0d; font-weight: 600; }
      .bug-status { min-height: 20px; font-size: 14px; margin: 4px 0 0; }
    </style>
    <form method="dialog" novalidate>
      <h2 id="bug-title">Report a bug</h2>
      <p>Tell us what went wrong and what you were doing. We read every report.</p>
      <label>What happened? <textarea name="message" maxlength="4000" required></textarea></label>
      <label>Your email (optional, if you'd like a reply) <input name="email" type="email" maxlength="200" autocomplete="email"></label>
      <p class="bug-status" role="status" aria-live="polite"></p>
      <div class="bug-row"><button type="button" data-bug-close>Cancel</button><button type="submit">Send report</button></div>
    </form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form'), status = dialog.querySelector('.bug-status'), send = form.querySelector('[type=submit]');
    dialog.querySelector('[data-bug-close]').addEventListener('click', () => dialog.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = form.message.value.trim(), email = form.email.value.trim();
      if (!message) { status.textContent = 'Please describe what went wrong.'; form.message.focus(); return; }
      send.disabled = true;
      status.textContent = 'Sending…';
      try {
        const body = JSON.stringify({ message, email: email || null, page: location.href.slice(0, 500), agent: navigator.userAgent.slice(0, 500) });
        const post = (auth) => fetch(URL_, {
          method: 'POST', body,
          headers: { apikey: KEY, Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        });
        let response = await post(token() || KEY);
        // An expired session still gets the report through, just without the account link.
        if (response.status === 401) response = await post(KEY);
        if (!response.ok) {
          const detail = (await response.json().catch(() => ({}))).message || '';
          throw new Error(detail.startsWith('Too many') ? detail : `The server answered ${response.status}.`);
        }
        form.reset();
        status.textContent = 'Thanks! Your report was sent.';
        setTimeout(() => dialog.open && dialog.close(), 1600);
      } catch (error) {
        status.textContent = `Couldn't send it: ${error.message || 'check your connection'} Please try again.`;
      } finally {
        send.disabled = false;
      }
    });
  }

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-bug-report]');
    if (!trigger) return;
    event.preventDefault();
    if (!dialog) build();
    dialog.querySelector('.bug-status').textContent = '';
    dialog.showModal();
    dialog.querySelector('textarea').focus();
  });
})();
