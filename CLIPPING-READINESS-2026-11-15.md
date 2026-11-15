# Clipping readiness review — 15 November 2026

The subsequent website completion pass adds caption, tracking, account-switch and cloud-sync race fixes. See [the current website completion record](WEBSITE-READINESS-2026-11-15.md) for the latest scope, checks and remaining release evidence. Earlier merge-readiness statements below apply to the earlier clipping-only patch, not all subsequent website changes.

Updated verdict: all five reported code problems were confirmed and fixes were tested locally. This does not establish public-release readiness: current live AI quality, the signed-in deployed flow, other browsers, and sample-exact encoded MP4 duration remain outside the verified result.

Scope of fixes: browser clipping only. Existing sidebar/style/markup and rollout edits were preserved. No Mac, Windows/Linux, games, authentication, gateway, production configuration or deployment changes were made. Nothing was staged or committed.

## Fresh-eyes review of the fixes

Reviewed the five fixes against the current files after the fact. All five hold, and no unrelated file was touched by them. Two further small gaps were found and closed:

- **Cancelled folder write left an empty file.** `create: true` creates the `.mp4` before the write, and `abort()` discards the write but not that empty file. `saveFile` now removes it after aborting, so a cancelled export leaves nothing behind. Covered by the existing abort test, extended to assert the removal.
- **Stats insert held the export dialog open.** `recordExport` is a best-effort Supabase insert that was awaited inside the task, so a slow or blocked network kept the progress card up after every file was already saved. It is now fire-and-forget; the insert already swallows its own errors.

One deliberate tradeoff was left as it is: transcription checkpoints are awaited, so a storage failure now fails the generation rather than silently losing the checkpoint. That is rare, and it is the price of never losing completed transcription; it was not changed.

Merge readiness: the clipping change set is self-contained (`UI/app/app.js`, `store.js`, `engine/render.js`, `engine/gemini.js`, `engine/selection.js`, `engine/shortmaker.js`, plus the tests), the clipping suite passes (14/14), and the pre-existing sidebar/style edits in the same working tree were preserved. Public-release readiness is unchanged from the section below.

## Confirmed problems and fixes

| Finding | Confirmation | Fix and verification |
| --- | --- | --- |
| Overlapping exports | Regression reproduced the active task being replaced; repeated submits also opened multiple folder pickers. | Guards at dialog open, submission and export entry; submission is locked across the picker and checks the project again afterwards. Regression tests pass. A generation also rechecks task/project ownership after loading its source. |
| Audio crosses source boundaries | The real renderer, with a deterministic PCM fixture and mocked codec, forwarded 200 source frames when only frames 25–124 belonged to the selection. | Trim PCM before rebasing timestamps. The renderer now forwards exactly those 100 frames. Chromium decoded-stereo checks retain exactly 53,280 frames for a 1.11-second selection at 48 kHz. **This fixes source-content trimming, not encoded-file padding/duration.** |
| Partial export bookkeeping | The first successful file was omitted from counts/history when the second failed or was cancelled. | Successful files are counted in cleanup even on failure/cancellation; the partial result is explained. Atomic IndexedDB patches refresh retention and preserve other edits. Tests cover later failure, later cancellation and a local bookkeeping failure. |
| Lost transcription checkpoints | A checkpoint callback followed by an AI error left no durable checkpoint. | Await checkpoint writes throughout transcription. Patch only an existing project; check task ownership again inside the transaction. Real IndexedDB tests verify a new store instance can read the checkpoint, cancelled/shorter checkpoints do not overwrite it, unrelated edits survive, and delayed writes cannot recreate a deleted project. |
| Late cancellation saves output | Original muted render returned an MP4 when aborted on its final frame or during finalization; cancellation after render/filename lookup could still save. | Check cancellation at frame emission, finalization and save boundaries; close decoded samples on failure and abort an uncommitted file stream. Regression tests cover these paths. Actual Chromium renders reject cancellation at the last frame and before finalization. Cancellation during finalization/file writing uses controlled mocks. |

## Checks for the fixes

- `node --test UI/app/tests/clipping.test.mjs`: **14 passed, 0 failed**. [Regression tests](UI/app/tests/clipping.test.mjs) execute the actual app function bodies with controlled storage/render dependencies, the actual render control flow with controlled codecs, and real Mediabunny PCM samples. These are not signed-in UI tests.
- `BASELINE=1 node --test UI/app/tests/clipping.test.mjs`: **12 expected regression failures** against the committed pre-fix app/render code. The other two tests import current helpers and are not before/after comparisons. No production files are switched to run baseline mode.
- `node UI/app/engine/engine.test.mjs`: passed existing engine, word-timing and title checks.
- `node --check UI/app/app.js` and `git diff --check`: passed.
- [Browser fixture](UI/app/tests/clipping.browser.test.js), executed in Chromium at `http://127.0.0.1:4174/app/`: passed PCM checks, encode/reopen/frame-decode checks for Fill, Fit, Split, muted 720p and H.264 1080p exports, cancellation checks and actual IndexedDB checks. Local test records were removed without queuing cloud deletions. No AI requests or account creation were used.

### Important evidence correction

The server reused on port 4173 during the original review belonged to `/Users/marian/Desktop/Prism-with-motion/UI`, not this checkout. Those original browser observations must not be treated as verification of this checkout. The tests for the fixes used a separate server whose process directory was checked as `/Users/marian/Desktop/Prism`, on port 4174; the browser was reloaded before the final run. The original shell-based Mac/Node tests ran in this checkout.

### Known limits and still-unverified behavior

- **Confirmed remaining duration limit:** for a requested 1.11-second selection, current Chromium AAC MP4s probe as 1.194667 seconds and the muted MP4 probes as 1.10 seconds. Source PCM is now trimmed correctly, but encoded/container padding and 30 fps rounding are not removed by these fixes. The precise cause of the full AAC duration overhead has not been isolated. Do not describe the result as sample-exact MP4 duration or fully verified A/V synchronization.
- A file already committed, or a download already handed to the browser, cannot be undone by a later cancellation. Tests verify cancellation prevents the next save/commit when it is observed before that boundary. Actual browser Downloads acceptance and actual folder-picker filesystem commits were not automated.
- Current signed-in live-AI generation, cloud sync/history persistence, real speech/subject quality, Safari/Firefox/Edge, HEVC, and long-video memory/latency remain unverified. The local page is signed out; controlled tests do not replace this release evidence.
- No new full Mac/platform test run was needed for these browser-only fixes. Original Mac results below are historical evidence for their own scope.

## Original findings (historical, superseded by verification above)

1. **High — overlapping exports can replace the active task.** `UI/app/app.js:1919` starts an export without checking `state.task`; `beginTask` at line 1389 overwrites that shared slot. The export action is not guarded by the running-task navigation check, and the export button is disabled only when there are no clips. Starting another export can leave the first running while progress/cancel refers to the second. Add a single-task guard before opening/submitting exports. This is a source-review finding, not a signed-in UI reproduction.

2. **Medium — export audio crosses selected boundaries.** `UI/app/engine/render.js:197` clones whole decoded audio samples and adjusts timestamps, without trimming their PCM to the selected start/end. In a real Chromium encode/decode check, a requested 1.11-second Short starting at 0.723 seconds became a 1.194667-second MP4 with audio; its muted counterpart was 1.10 seconds. The first source audio sample began at 0.704 seconds, before the selected start. AAC padding also contributes to output duration, so the entire discrepancy should not be attributed to trimming. Trim audio samples and verify synchronization and end duration with boundary fixtures.

3. **Medium — partial batch exports skip success bookkeeping.** In `UI/app/app.js:1955`, a later clip failing or cancellation returns before lines 1964–1972 record already-saved clips and refresh the project's expiry timer. A successful first export followed by a failed second export therefore loses its history/count and does not refresh the retention date through this path. Record successful files even when the batch is interrupted, and report the partial result.

4. **Medium — transcription recovery is only held in memory until generation succeeds.** `UI/app/app.js:1317` updates `project.transcripts` without saving. The explicit persistence is after successful clip preparation. If a later AI stage fails and the page reloads before another save, completed transcription is lost and must be requested again. Save checkpoints during transcription, with task ownership/cancellation protection. The Mac model already saves transcripts immediately.

5. **Medium — late export cancellation can still finish/save a file.** `UI/app/engine/render.js:191–218` does not check cancellation during the final repeated frames, before finalization, or before returning. `UI/app/app.js:1949–1950` does not check it before saving either. Cancellation late in a muted render or during finalization can therefore still save the result. This is a source-review finding; the attempted dedicated browser reproduction could not run because the preview tab was no longer available.

## Original review checks

- Passed: `node UI/app/engine/engine.test.mjs` (selection, transcript boundaries/alignment, caption logic, framing/render calculations, retry logic and sync planning).
- Passed: `node UI/app/engine/cloudvideo.test.mjs` (mock storage transport).
- Passed: `node --test UI/api/_gemini.test.js UI/api/_cleanup.test.js supabase/functions/gemini/security.test.mjs`. The web gateway test covers model ordering; the broader authentication/accounting tests exercise the Supabase gateway, not the web gateway end to end.
- Passed: macOS transcript selection, smoke, Gemini selection and framing scripts. Smoke coverage includes real AVFoundation MP4 exports, layouts, captions, invalid inputs, destination preservation, persistence and quality settings. AI selection uses mocks.
- Passed: macOS editor-model script, including import/create settings, cancellation behavior in the Mac model, clip edits, undo, save/reopen and export. It exercises model actions directly and is not a complete desktop interaction test. Swift compilation emitted deprecation warnings.
- Browser: reused the existing local server on 127.0.0.1:4173. Generated a four-second H.264/AAC source in Chromium using Mediabunny, imported it through `openSource`, then rendered and re-opened Fill, Fit, Split and muted 720×1280 MP4s, plus a 1080×1920 H.264 MP4. Audio was present where expected and absent when muted. Invalid negative start rejected with `invalidRange`. These were direct engine calls, not the signed-in application workflow. Actual spoken captions and subject-tracking quality were not assessed by this synthetic fixture.
- The local sign-in/create-account screen loaded, but localhost Turnstile errors were present. No account was created, no credentials were read, and no paid live AI request was made.

## Public-release evidence still needed

- Current signed-in import → live AI → review/edit → export → reload/reopen, using the deployed release and service. Historical QA documents do not establish current deployment health.
- Representative real podcasts, interviews and tutorials, including a long recording: assess complete hooks/payoffs, caption accuracy, crop quality, time to completion and failure/retry behavior.
- Browser coverage for the supported Safari/Firefox/Edge versions, HEVC where offered, long-file memory pressure, multiple downloads, offline recovery and cancellation. Chromium synthetic success does not establish these.
- For public Mac distribution, confirm the actual release artifact's Developer ID signature and notarization. The repository's release-readiness document still lists this gate; the installed/distributed artifact was not inspected.

Existing unrelated working-tree edits were left intact. No deployment or production configuration was changed.
