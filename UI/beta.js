// The beta cap on sign-up forms (website and web app): "X of 100 beta spots left", and when the beta is full, a waitlist in
// place of the form. The cap itself is enforced by the database (migration 202611040001); this only explains it.
// Until that migration is applied, the functions it calls don't exist and sign-up simply works as before.
window.prismBeta = (() => {
  const FULL = 'Beta is full — join the waitlist';

  /** { left, cap }, or null when the server can't say (no beta cap set up yet, or offline). */
  async function spots(db) {
    try {
      const [left, cap] = await Promise.all([db.rpc('beta_spots_left'), db.rpc('prism_beta_user_cap')]);
      if (left.error || cap.error || !Number.isFinite(left.data) || !Number.isFinite(cap.data)) return null;
      return { left: left.data, cap: cap.data };
    } catch { return null; }
  }

  /**
   * Adds the spots line before `form`, and shows the waitlist after it when no spots are left, hiding `hide` (the form
   * itself on a sign-up page; only the Create account button where people also sign in).
   * `classes` = { note, field, input, button } so it matches the page. Returns { signUpFailed(error) }: call it with a
   * failed sign-up's error; it answers true (and shows the waitlist) when the beta filled up.
   */
  function attach(db, form, classes = {}, hide = [form]) {
    const note = Object.assign(document.createElement('p'), { className: classes.note ?? '' });
    note.hidden = true;
    form.before(note);
    let waitlist = null;

    const showFull = () => {
      note.hidden = true;
      for (const element of hide) element.hidden = true;
      if (waitlist) return;
      waitlist = document.createElement('div');
      waitlist.className = 'beta-waitlist';
      waitlist.innerHTML = `<h3>${FULL}</h3>
        <p>All beta spots are taken. Leave your email and we’ll write when a spot opens. We only use it for that.</p>
        <form novalidate>
          <div class="${classes.field ?? ''}"><label for="waitlist-email">Email address</label>
            <input id="waitlist-email" class="${classes.input ?? ''}" type="email" name="email" placeholder="you@example.com" autocomplete="email" required></div>
          <button class="${classes.button ?? ''}" type="submit">Join the waitlist</button>
        </form>
        <p class="beta-waitlist-status" role="status" aria-live="polite"></p>`;
      form.after(waitlist);
      const [list, status] = [waitlist.querySelector('form'), waitlist.querySelector('[role=status]')];
      list.addEventListener('submit', async (event) => {
        event.preventDefault();
        const email = list.elements.email.value.trim();
        if (!list.elements.email.checkValidity() || !email) { status.textContent = 'Enter a valid email address.'; return; }
        list.querySelector('button').disabled = true;
        status.textContent = 'Adding you…';
        const { error } = await Promise.resolve(db.rpc('join_beta_waitlist', { p_email: email })).catch((e) => ({ error: e }));
        list.querySelector('button').disabled = false;
        if (!error) { list.hidden = true; status.textContent = 'You’re on the waitlist. We’ll email you when a spot opens.'; return; }
        status.textContent = /RATE_LIMITED/.test(error.message) ? 'Too many tries. Wait an hour, then try again.'
          : /INVALID_EMAIL/.test(error.message) ? 'Enter a valid email address.' : 'Couldn’t add you right now. Try again in a moment.';
      });
    };

    spots(db).then((s) => {
      if (!s) return;
      if (s.left <= 0) return showFull();
      note.textContent = `${s.left} of ${s.cap} beta spots left`;
      note.hidden = false;
    });

    return {
      async signUpFailed(error) {
        // Supabase Auth reports the database's BETA_FULL as "Database error saving new user"; ask how many spots are left.
        if (!/BETA_FULL|Database error saving new user/i.test(error?.message ?? String(error ?? ''))) return false;
        const s = await spots(db);
        if (!s || s.left > 0) return false;
        showFull();
        return true;
      },
    };
  }

  return { attach, spots, FULL };
})();
