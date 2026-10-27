# Staged usage-write rollout

The additive migration in `../migrations/202610270001_secure_beta_usage.sql` has been applied to the production project. Its reservation function passed the `expand` live check with a disposable account. The existing gateway and its user-write policy are still active.

`gemini_usage_only.ts` is the tested gateway snapshot for this first rollout. It deliberately excludes the concurrent analysis-run changes in `../functions/gemini/index.ts`; their migration has not been applied. A copy of the original deployed function was captured at `/private/tmp/prism-live-gemini-backup.txt` (temporary storage, so preserve it before relying on it for rollback).

To finish this phase:

1. Deploy the exact usage-only gateway snapshot. First ensure a working, verified rollback mechanism is available.
2. Run `python3 supabase/tests/live_usage_security.py gateway`. This makes a real AI request using a disposable account and verifies the new gateway records the server's UTC day. If it fails, keep the old write policy and restore the old gateway.
3. Allow existing old-function requests to drain. Supabase propagation and in-flight behavior must be verified; the two services cannot be changed in one atomic transaction.
4. Apply `contract_beta_usage.sql`, then run `python3 supabase/tests/live_usage_security.py contract`. It verifies normal users cannot insert, update or delete usage rows and removes the disposable account.

Do not automatically apply `../migrations/202610270002_reanalysis_runs.sql` as part of this phase. It was changed concurrently, has not been validated against the live schema and depends on the later analysis-limit work.
