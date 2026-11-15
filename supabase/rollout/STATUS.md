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
| `gemini` function: OpenRouter app name (`HTTP-Referer`) | `functions/gemini/index.ts` | **deployed** 2026-11-07 (v20) | `https://relioclips.com`. |
| Beta cap (100 users), waitlist, analytics events | `migrations/202611040001_beta_cap_waitlist_analytics.sql` | **applied** 2026-11-04 | Website pushed the same minute (prism-website `60f2bdc`). Live check: 97 spots shown, a test sign-up dropped it, waitlist not readable with the public key. Email confirmation turned off by the owner 2026-11-04. |
| Strip the Turnstile token from new accounts | `migrations/202611040002_strip_signup_token.sql` | **applied** 2026-11-04 (owner) | |
| `signup-guard` function (Before User Created hook, Turnstile) | `functions/signup-guard/index.ts` | **deployed, hook on** 2026-11-04 | Live check: a sign-up without a token is refused with the hook's message. Refusals must be HTTP 200 + `error` object (any non-2xx shows Auth's generic error). Site key in `UI/turnstile.js`. Supabase Bot protection stays **off** (desktop sign-in sends no CAPTCHA). A real sign-up through the page is to be confirmed by the owner. |
| Profiles: name + unique username | `migrations/202611040003_profiles.sql` | tested locally 2026-11-04 | **Not applied: owner to run in SQL Editor.** The website (prism-website `c9de131`) works before it, without username checks. |
| `signup-guard`: let Google (non-email) sign-ups through | `functions/signup-guard/index.ts` | committed, not deployed | Only needed when Google sign-in is switched on (`GOOGLE_SIGN_IN` in `UI/auth.js`). |
| `gemini`: read slow answers (OpenRouter keep-alive lines), 135 s budget across models | `functions/gemini/index.ts` | **deployed** 2026-11-07 (v20) | Cause of the 546 on 2026-11-04 17:31: Mimo answered after ~106 s but the reply was discarded. |
| `gemini`: audio tries 30 s, per-attempt logs, failed log writes reported | `functions/gemini/index.ts` | **deployed** 2026-11-07 (v20) | Chain: MiMo-V2.6-Flash, then Gemini 3.8 Flash. |
| `ai_spend`: `kind` and `ms` columns | `migrations/202611080001_ai_spend_kind_ms.sql` | **applied** 2026-11-08 (owner, SQL Editor) | Must exist before `gemini` v21 and the web gateway write them. |
| `gemini`: MiMo audio pinned to Makora, provider recorded on every attempt, kind and time per answer | `functions/gemini/index.ts` | **deployed** 2026-11-08 (v21, owner via CLI) | Web gateway (`UI/api/gemini.js`) same, prism-website `3d5192f`. Pinned on most answers overall, not proven audio successes. |
| Daily cleanup of projects untouched 7 days | `UI/api/cleanup.js` (Vercel cron 04:00 UTC) | **live** 2026-11-08 | Deletes `cloud_projects` rows and R2 videos; needs `CRON_SECRET` in Vercel. |

## Confirmed state — 2026-11-08

- **Export while going Home:** fixed and tested on a real video: all files downloaded, the 7-day timer reset (prism-website `14bb46a`).
- **7-day deletion rule:** live. Edits, re-analysis and export all reset the timer. From day 5 a warning shows on the project card and as a banner on Home. The app deletes after each sync; the daily cron covers people who never return.
- **Audio chain:** MiMo-V2.6-Flash (pinned to Makora, 30 s), then Gemini 3.8 Flash. MiMo-V2.6-Pro is **not** in the chain: unverified, with no audio pricing on any endpoint and no retention data shown publicly. Needs a test with an OpenRouter key and a short audio clip.
- **Beta cap:** 100 spots, live.
- **Turnstile sign-up guard:** `signup-guard` deployed with the Before User Created hook on since 2026-11-04 (see the table). A real sign-up through the page is still to be confirmed by the owner.
- **Domain:** relioclips.com is the main domain. prismclips.vercel.app returns 404 (no redirect).

### Open items

- **Ukrainian song, no captions:** cause found 2026-11-07. Too many lines were dropped as sung, so the Shorts were flagged as music and their captions hidden; music videos now get a "This is a music video" error instead. A fresh test on the song is still due.
- **MiMo audio timeouts:** still happening. Since `gemini` v21 and the web deploy on 2026-11-08, timeouts record the pinned provider (Makora); success rate and median time per provider to be reported from `ai_spend` after a day of use.
- **18 tables to review.**
