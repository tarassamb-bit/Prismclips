# Repository code review — October 25, 2026

Ten focused passes covered the first-party macOS app, shared .NET engine, Windows and Linux frontends, website, API handlers, database schema, tests, configuration and release scripts. The final inventory contained 114 source, test, script and configuration files, approximately 26,800 lines. Generated output and third-party dependencies were excluded from the manual source review.

Existing workspace changes were retained. No release was published, credentials changed, or production database modified.

## Review passes

| Pass | Focus | Work performed |
| --- | --- | --- |
| 1 | Baseline and build integrity | Inventoried source and existing changes; ran builds, existing payment checks and shared-engine tests. Located the local .NET SDK and verified the repository-pinned ffmpeg/ffprobe checksums before running media tests. |
| 2 | Persistence and data preservation | Reviewed project creation/opening, managed imports, save failures, history and framing commits. Exercised real SQLite save failures. |
| 3 | Async state and cancellation | Traced key verification, preview/generation revisions, concurrent exports, checkout requests, and original-file copying. Checked failed operations release busy state. |
| 4 | Bounds and malformed values | Checked source ranges, generated clip IDs, custom ranges, word timing, crop positions and retry-delay parsing. Added negative/non-finite retry-delay cases. |
| 5 | AI selection and transcription | Reviewed scoring, refinement, final selection, transcript caching/resume, structured-response validation, timing recovery, retries and fallback paths; ran mocked Gemini/transcript suites. |
| 6 | Rendering and cache lifetime | Reviewed export destinations, cache publication/pruning, captions, Fit/Fill/Split, rotated media and source copying; ran actual video renders. |
| 7 | Native editor interaction | Reviewed selection, inspector edits, Undo/Redo, focus-point dragging, scene-cut metadata, playback and native frontend event/error handling. Ran model and rendered-panel checks. |
| 8 | Website, auth and payments | Reviewed all first-party website JavaScript, API handlers and SQL policies; checked checkout failure/race paths, session changes and webhook signatures with offline tests. |
| 9 | Cross-platform resources and packaging | Reviewed managed-path portability, database ownership, platform file/credential helpers, package configuration, installers, release workflow and updater wiring. Checked script/config syntax and local website links. |
| 10 | Regression and patch review | Re-read the changed paths against the starting workspace, checked rollback/name-allocation invariants, added focused regressions, and reran affected builds and suites. |

## Fixed issues

| # | Mistake and resulting fix | Primary location |
| --- | --- | --- |
| 1 | Two projects created within the same second could share a directory and overwrite saved state. Project directories now include an independent UUID. | `RelioApp.swift`, `Session.Projects.cs` |
| 2 | Shared key verification read the mutable input again after the request. It now saves the exact key checked by Google. | `Session.cs` |
| 3 | Import-directory and thumbnail failures could escape the shared import task and leave the app busy. These failures now clean up and return a usable editor with an explanation. | `Session.Projects.cs` |
| 4 | A failed macOS import save changed selection/player to a copied file that was then deleted. Playback and selection now change after persistence succeeds. | `RelioApp.swift` |
| 5 | Concurrent macOS exports could select an existing numbered file, or reserve case variants of the same filename. Allocation now checks both existing files and normalized reservations on every attempt. | `RelioApp.swift` |
| 6 | macOS cache pruning included unfinished render files and unrelated entries. It now prunes only completed Fit/Split cache files. | `ShortMaker.swift` |
| 7 | Both renderers swallowed cache move failures as though another render had succeeded. A move failure is now ignored only when the requested cache file actually exists. | `ShortMaker.swift`, `Renderer.cs` |
| 8 | Generated macOS batches accepted invalid source ranges, missing source IDs and reused clip IDs. These are now validated before committing a batch. | `RelioApp.swift` |
| 9 | Failed framing saves could leave the in-memory path/version changed in preview, export or manual re-tracking. Those changes now roll back; preview failures also expose Retry. | `RelioApp.swift` |
| 10 | A strong crop offset could prevent a focus point from reaching the clicked edge. The existing offset is now incorporated into the path when needed, preserving its visible framing. | `RelioApp.swift`, `Session.Edits.cs` |
| 11 | Merging macOS focus points could drop a scene-cut or whole-frame marker. Merge logic now preserves those flags. | `RelioApp.swift` |
| 12 | A malformed non-ASCII webhook signature could throw during byte comparison; only the final signature was considered. Invalid encodings are rejected and any valid signature can authenticate a rotating key. | `UI/api/paddle-webhook.js` |
| 13 | Failed subscription checks were treated as permission to open a new paid checkout. Checkout now stops and reports the lookup error. | `UI/pricing.js` |
| 14 | Repeated clicks could start concurrent checkout checks. One attempt now owns the controls until it finishes. | `UI/pricing.js` |
| 15 | Checkout retained the user loaded at page startup after sign-out/account changes elsewhere. It now refreshes the session before using account details. | `UI/pricing.js` |
| 16 | Negative/non-finite Gemini retry delays could reach sleep or integer conversion. Both clients now accept only finite, non-negative delays. | `GeminiSelection.swift`, `Gemini.cs` |
| 17 | A shared project-open failure during deserialization could leave the candidate SQLite connection undisposed. Failed candidates are now disposed in `finally`. | `Session.Projects.cs` |
| 18 | Windows-style stored paths broke media names, managed-media relocation and Home thumbnails on Unix systems. Basenames now support both path separators. | `Core.swift`, `Models.cs`, `Platform.cs`, `RelioApp.swift` |
| 19 | Direct original-file copies could leave partial destination files after failure/cancellation; cleanup could also remove a competing destination. Imports/copies now publish through unique temporary files and preserve existing destinations. | `ShortMaker.swift`, `RelioApp.swift`, `Session.Projects.cs` |
| 20 | Shared unique-name selection skipped files but not directories with the same name. It now skips both. | `Session.Projects.cs` |

The editor test harness now accepts a temporary app directory. New tests cover rapid project creation, key-field changes during verification, import/save failures, filename collisions, cache pruning, focus-point edges/merges, re-tracking rollback, invalid generated batches, cross-platform paths, source-copy safety, malformed retry delays, webhook input and checkout races/session changes.

## Verification

| Check | Result |
| --- | --- |
| `swift build --package-path macOS` | Passed. Existing AVFoundation deprecation warnings remain. |
| `dotnet build Prism.sln --no-restore` | Passed for shared code and both native frontends, zero warnings/errors. |
| `dotnet test Shared/Prism.Core.Tests --no-restore` | 91 passed, zero failed/skipped, using checksum-verified ffmpeg/ffprobe via `PRISM_FFMPEG` and `PRISM_FFPROBE`. |
| `zsh macOS/scripts/smoke-test.sh` | Passed; real media import, persistence, original copies, cancellation, rotated layouts, captions, MP4 rendering and export quality. |
| `zsh macOS/scripts/editor-model-test.sh` | Passed; including injected database failures, new regressions, export/reopen and rendered/live panel checks. |
| `zsh macOS/scripts/transcript-selection-test.sh` | Passed. |
| `zsh macOS/scripts/gemini-selection-test.sh` | Passed with mocked HTTP; includes invalid retry-delay cases and pipeline fallback. |
| `zsh macOS/scripts/framing-test.sh` | Passed, including a rendered MP4 with a hard framing cut. |
| `zsh macOS/scripts/updater-test.sh` | Passed without contacting an update feed. |
| `node UI/selfcheck.js` | Passed, including webhook signature regressions. |
| `node UI/pricing-check.js` | Passed: lookup errors, retry, repeated clicks, existing subscriptions and sign-out. Runs the real pricing script with DOM/service doubles. |
| Website structure | All 15 HTML pages checked for missing local assets, links, anchors and duplicate IDs; none found. |
| Syntax/configuration | First-party JavaScript and shell syntax, project XML, JSON and plist parsing passed. |
| `git diff --check` | Passed. |

Windows and Linux desktop interactions could not run on this Mac; their frontends were compiled and their shared behavior was exercised through the .NET suite. macOS checks exercise model actions, real rendering and selected live controls, rather than a full desktop click-through. Gemini, account and payment requests were mocked; no live purchase, cloud-quality evaluation, notarization or release publication was performed.

The pricing tier perk arrays remain intentional content TODOs in `UI/pricing-tiers.js`; no commercial benefits were invented. Source copying uses the native filesystem copy operation: cancellation prevents publication of a cancelled copy, but an already-running filesystem copy may finish before cancellation returns.

## Second review and Windows parity pass

A second set of ten focused passes reviewed the existing changes and their surrounding code. These are different review perspectives, not a claim that ten repetitions can prove the application has no defects.

| Pass | Focus | Repairs or verification |
| --- | --- | --- |
| 1 | Account state and concurrent requests | Invalidated late sign-in, refresh and export responses after sign-out or account changes; serialized authentication; validated saved sessions and authentication replies. |
| 2 | Credential failures | Kept the signed-in state visible when credential deletion fails, instead of falsely reporting successful sign-out. |
| 3 | Project lifecycle | Persisted new projects before replacing the current project; restored titles after failed renames; released database/player locks before trash and recovered the open project after failure. |
| 4 | Stored data | Opened existing SQLite stores without creating missing databases or schemas; rejected invalid project collections; handled unreadable Swift database values. |
| 5 | Library/settings integrity | Deduplicated recent paths, retained memberships when a destination folder is stale, and normalized damaged settings before native layout/timer creation. |
| 6 | Caption boundaries | Intersected captions with the actual clip interval and retained very short valid rendering intervals. |
| 7 | Process lifecycle | Checked cancellation before launching tools and stopped encoders when progress callbacks fail. |
| 8 | Website/account races | Prevented stale session failures or pending statistics from restoring signed-out content. Added execution tests for the real account page script. |
| 9 | API boundary failures | Converted failed upstream body reads and malformed success envelopes to controlled gateway errors; rejected malformed signed webhook events. |
| 10 | Windows/Mac parity and regression checks | Matched the current Mac editor's header and caption sidebar, added folding sections, keyboard navigation, score sorting, Auto captions, twenty-Short selection, and persistent undo/redo with failure rollback. |

### Windows changes

The current native SwiftUI source is the reference; the README editor image represents an older layout. Windows now places captions on the right, keeps the media library on the left, and uses the Mac's project summary and busy-only header status. Existing Windows clip settings and AI editing remain accessible in expandable sections beneath the library. The timeline exposes Undo and Redo, with Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y. Up/Down follow the displayed Short order. Library file drops import video; redundant Import buttons disappear once media exists. Fold state and best-first sorting survive relaunches.

Automatic caption styling follows the same mapping as macOS: Podcast for conversations/split screen, Bold caps for gaming, Minimal for tutorials, Viral highlight otherwise. Detected content type and 0–100 selection scores are preserved in project data. Explicitly chosen styles remain explicit. New projects allow up to twenty Shorts through both the UI and selection engine. Older projects without scores or content types remain readable.

This is closer native parity, not verified pixel identity. Windows still uses WPF/MediaElement and cached ffmpeg previews; Mac uses SwiftUI/AVFoundation. The Mac's automatic count and natural-length generation remain separate from the Windows numeric count and duration controls. Windows runtime layout, scaling, keyboard focus and playback require a Windows machine; this Mac can cross-compile the WPF app but cannot execute it.

Validation after the second review: solution build passed with zero warnings/errors; all 116 .NET tests passed, including redo rollback/branching and five automatic-caption mappings. Swift build, smoke, editor-model, transcript-selection, Gemini-selection, framing and updater checks passed. The three website account/payment/pricing checks and `git diff --check` passed. Network services were mocked. No Windows visual-runtime check or release publication was performed.
