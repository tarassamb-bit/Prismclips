# Supabase rollout status

One line per change that touches the live project (`isdplhahgggundbohmlr`). Read this before applying a migration or
deploying a function, and update it in the same commit. States: planned → tested → **applied** (with date).

| Change | File | State | Notes |
|---|---|---|---|
| Secure beta usage | `migrations/202610270001_secure_beta_usage.sql` | **applied** | See `README.md` for the staged gateway rollout. |
| Old re-analysis runs | `migrations/202610270002_reanalysis_runs.sql` | do not apply | Incompatible with the live schema; replaced by 202611030003. |
| Cloud projects | `migrations/202611030001_cloud_projects.sql` | **applied** 2026-11-03 | |
| Delete account | `migrations/202611030002_delete_account.sql` | **applied** 2026-11-03 | |
| Re-analysis runs (production) | `migrations/202611030003_reanalysis_runs_production.sql` | **applied** 2026-11-03 | Needed by `gemini` v10+. |
| `gemini` function: low reasoning, 100 s model timeout | `functions/gemini/index.ts` | **deployed** 2026-11-03 | |
| `gemini` function: OpenRouter app name (`HTTP-Referer`) | `functions/gemini/index.ts` | planned | Waiting for a redeploy by the owner. |
| Beta cap (100 users), waitlist, analytics events | `migrations/202611040001_beta_cap_waitlist_analytics.sql` | **applied** 2026-11-04 | Website pushed the same minute (prism-website `60f2bdc`). Live check: 97 spots shown, a test sign-up dropped it, waitlist not readable with the public key. Email confirmation turned off by the owner 2026-11-04. |
| Strip the Turnstile token from new accounts | `migrations/202611040002_strip_signup_token.sql` | tested locally 2026-11-04 | Apply together with the `signup-guard` hook. |
| `signup-guard` function (Before User Created hook, Turnstile) | `functions/signup-guard/index.ts` | tested locally 2026-11-04 | Order: owner sets `TURNSTILE_SECRET`; deploy with `--no-verify-jwt`; apply 202611040002; push the website with the site key; then enable the hook (Auth → Hooks) and set `SIGNUP_HOOK_SECRET`. Enabling the hook before the website carries the widget refuses every sign-up. Supabase Bot protection stays **off** (desktop sign-in sends no CAPTCHA). |
