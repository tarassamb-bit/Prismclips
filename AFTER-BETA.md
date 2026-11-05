# After the beta: fix list

Things to fix in one go once the beta testing round ends. Add new items at the bottom of the right section, with the date
and who found it. Tick them off (`- [x]`) when fixed.

## Web app: Create Shorts screen

- [ ] **"How many" is confusing** (owner, 2026-11-04). The − Auto + stepper doesn't make clear that Auto is a choice, and it
  jumps to 4 every time a video is chosen. Make it a picker you click (like "Approx. length"), with **Auto** as a visible
  option, and keep Auto unless the person changes it.
- [ ] **"Approx. length" starts at 45 seconds** (owner, 2026-11-04). It should start at **Auto**, like the rest of the
  settings.

## Web app: sidebar

- [ ] **"On this device · Storage 342 KB / 82.5 GB" isn't useful** (owner, 2026-11-04). It shows the browser's own storage
  for the site (the 82.5 GB is what the browser allows, not a limit people manage) and gets confused with the 1 GB cloud
  storage in Settings › Usage. Remove it, or rename it to something like "Saved in this browser: 342 KB".

## Known limits from launch (decide whether to fix)

- [ ] **Safari can't export HEVC** fast (≈4 frames/s), so the option is hidden in Safari.
- [ ] **Caption timing is approximate**, weaker with music under the voice. A speech-to-text service with word timestamps
  would fix it (costs a little per hour of audio).
- [ ] **Prism AI can be slow at busy times.** Supabase's free plan stops a request after 150 s; Mimo 2.6 stays.
- [ ] **Sign-up emails** come from "Supabase Auth" with Supabase's plain text, and its built-in sender only sends a few per
  hour. Supabase only lets you edit the email text with your own sender (custom SMTP). Fix: a free sender such as Brevo
  (single verified sender, no domain needed) or an own domain + Resend, then paste the branded templates from
  `supabase/email-templates/` (subjects: "Confirm your email for Prism", "Reset your Prism password").
- [ ] **Google sign-in** is built but switched off (`GOOGLE_SIGN_IN` in `UI/auth.js`). Needs a Google OAuth client in Supabase
  and a redeploy of `signup-guard`.
- [ ] **Windows and Linux apps** weren't compiled after their "Create account" change (it now opens the website). Build and
  test them before their next release.
- [ ] **Domain**: the site lives at prismclips.vercel.app; `prismclips.app` isn't owned yet.

## Brand

- [ ] **Rename everything from Prism to Relio** (owner, 2026-11-05). The whole website and company become **Relio** /
  **relioclips**: site text, logo and app name, page titles, emails, `llms.txt`, legal pages, the Vercel project and
  domain (prismclips.vercel.app → a relioclips address), the OpenRouter app name ("Prism Clips"), the Mac, Windows and
  Linux apps, and the GitHub repos. Old addresses should redirect to the new ones.

## Found by testers

<!-- - [ ] **What happened** (tester, date). Device and browser. What they expected. -->
