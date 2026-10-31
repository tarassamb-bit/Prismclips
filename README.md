<p align="center">
  <img src="macOS/assets/readme/hero.png" width="100%" alt="Prism: one in, many out. A native macOS editor that turns one long video into vertical Shorts.">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-14%2B-0E0F14?style=flat-square&labelColor=20232B" alt="macOS 14+">
  <img src="https://img.shields.io/badge/Swift-6-0E0F14?style=flat-square&labelColor=20232B" alt="Swift 6">
  <img src="https://img.shields.io/badge/AI-Cloud-3FA9F5?style=flat-square&labelColor=20232B" alt="Cloud AI">
  <img src="https://img.shields.io/badge/license-MIT-0E0F14?style=flat-square&labelColor=20232B" alt="MIT">
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#how-a-short-is-made"><b>How it works</b></a> ·
  <a href="#privacy-and-cost"><b>Privacy</b></a> ·
  <a href="#testing"><b>Testing</b></a>
</p>

Drop in a podcast, lecture, vlog or stream. Prism suggests moments intended to work as standalone Shorts, with a hook, context and payoff. It renders them as 1080 × 1920 MP4s with captions and an automatically framed crop. You review and tweak every clip before export.

> **Status:** early Phase 1 prototype. The core long-video-to-Short pipeline works end to end; see [Limits](#limits) before relying on it.

> **macOS registration fix:** the previous Mac beta (0.1.2) had a registration issue where email confirmation links led to localhost. Use [Prism 0.1.3 for macOS](https://github.com/tarassamb-bit/Prismclips/releases/tag/mac-v0.1.3), which includes the fix and a guided first-video tutorial. Request a fresh confirmation email if your old link still points to localhost.

## The editor

<p align="center"><img src="macOS/assets/readme/editor.png" width="100%" alt="The Prism editor: Shorts list, vertical preview with highlighted captions, clip inspector and timeline."></p>

<p align="center">
  <img src="macOS/assets/readme/home.png" width="49%" alt="Home: recent projects with thumbnails.">
  <img src="macOS/assets/readme/create.png" width="49%" alt="Create: choose how many Shorts, their length and the source range.">
</p>

<sub>Screens use a generated demo library with illustrated footage and may not show the current editor layout. Regenerate them with <code>zsh macOS/scripts/readme-assets.sh</code>.</sub>

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [How a Short is made](#how-a-short-is-made)
- [Privacy and cost](#privacy-and-cost)
- [Projects on disk](#projects-on-disk)
- [Code map](#code-map)
- [Testing](#testing)
- [Packaging and signing](#packaging-and-signing)
- [Limits](#limits)
- [Brand](#brand)
- [Credits and license](#credits-and-license)

## Features

| | |
|---|---|
| **Story-aware clip picking** | Cloud AI scores the whole transcript, refines a shortlist, then a final editor pass chooses distinct clips with a hook and a payoff. |
| **Clean cuts** | Edges snap to whole sentences and words. Filler openings ("Okay, so.") and sign-offs ("Thanks for watching!") are trimmed. |
| **Subject framing** | Cloud AI finds the subject in about one frame per second. A camera planner smooths the path and cuts hard on scene changes. |
| **Layouts** | Fill (tracked crop), Fit (whole frame over a blurred background) and Split screen (two speakers stacked). |
| **Captions** | Seven styles, including word-by-word highlighting when the AI's word timing verifies. |
| **Video types** | Podcast, informational, tutorial, vlog, gaming or auto-detect, each steering selection and layout. |
| **Non-destructive projects** | New batches append and skip overlaps. Every batch can be undone. Originals are copied, never modified. |
| **Editor chat** | Ask in plain language: "trim to 20 seconds", "mute the audio", "export". |

## Quick start

**You need:** macOS 14 or newer, Xcode command line tools (`xcode-select --install`), an internet connection and a Prism account. You can create an account in the app. No API key is needed.

```sh
git clone <this repo> && cd Relio
zsh macOS/scripts/package-app.sh
open macOS/dist/Prism.app
```

1. Sign in, or create an account, when Prism opens. If confirmation is required, confirm your email and then sign in.
2. On Home, choose **Start creating** and pick a source file.
3. Set the number of Shorts, their length and the source range: entire video, first half, last half or custom minutes.
4. Pick a caption style and video type, then generate. You can cancel at any time; existing clips are kept.
5. Review each Short in the editor and adjust it, then **Export**. Each Short becomes its own MP4, with its title and description in the file and in a `.txt` beside it. They go to Downloads › Prism › the project's name unless you choose another folder.

> **Keychain prompts after every rebuild?** Run `zsh macOS/scripts/create-signing-identity.sh` once. See [Packaging and signing](#packaging-and-signing).

### Windows and Linux

Native ports are in [Windows](Windows/README.md) (WPF) and [Linux](Linux/README.md) (GTK4/Gir.Core). They share a .NET 10 Gemini/ffmpeg engine and app model in `Shared/Prism.Core`, including Home folders, the create flow, captions, focus editing, chat and export cards. Their libraries and credentials are separate from macOS.

```sh
dotnet build Prism.sln
dotnet test Shared/Prism.Core.Tests  # requires ffmpeg and ffprobe
```

Unlike the macOS app, the current Windows and Linux ports use a user-provided Google AI Studio API key and send AI requests directly to Gemini. Their usage may be billed by Google. The native ports compile on the development Mac, but desktop playback, layout and platform services still need verification on real Windows/Linux machines; each platform guide includes dependencies, launch commands and a check list.

## How a Short is made

```
source video
   │
   ├─ 1. Transcribe   Cloud AI, sentence-level, in chunks up to 2 min (saved and reused per video)
   ├─ 2. Classify     auto-detect the video type from the transcript
   ├─ 3. Score        overlapping transcript windows, scored 0–100 against fixed anchors
   ├─ 4. Refine       top windows → exact clips with title, reason and layout (3 batches in parallel)
   ├─ 5. Final cut    one editor pass chooses distinct stories; score-ranked backups are used if the pass fails
   ├─ 6. Snap         whole sentences → filler trimmed → padding → word-safe edges
   ├─ 7. Captions     AI word timing, verified against the transcript; else whole-sentence captions
   ├─ 8. Frame        AI subject positions → smoothed crop path with hard scene cuts
   └─ 9. Render       AVFoundation, H.264, 1080 × 1920, on your Mac
```

Selection adapts the score → shortlist → detail pipeline from [OpenShorts](macOS/THIRD-PARTY-NOTICES.md) (MIT) into native Swift, with no Python or Docker. A few design choices:

- **The whole range is scored**, so a strong moment late in a long recording is not lost to an early one.
- **One failed batch costs only its own candidates**, not the whole run.
- **Model output is data, not instructions.** The renderer consumes validated time ranges only. The transcript is marked as untrusted in every prompt.
- **Honest failure.** If nothing passes the hook-and-payoff bar, Prism takes the best 5–6/10 clips and labels them "Weaker pick". If nothing usable remains, it returns an error and keeps your existing clips.
- **Bounded retries.** Temporary server errors retry at most twice. Short per-minute quota waits are honoured. Key and quota errors are reported, not retried.

## Privacy and cost

The macOS AI features require an internet connection and a signed-in Prism account. The app sends requests through a [Supabase Edge Function](supabase/functions/gemini/index.ts) to OpenRouter and its model providers; the configured model and providers may change. The server holds the provider key. The Windows and Linux ports instead use Gemini directly with your own key.

**Sent for AI processing:**
- Audio chunks of the selected range.
- Transcripts.
- Sampled frames: up to 12 per refinement batch, and about 1 per second of each tracked Short.
- Chat messages, with recent conversation and a short edit summary.

On macOS, the service also receives a hashed video identifier, its duration and the local date to check usage. The account service receives export statistics (Short count, duration and quality). The checked-in Edge Function does not log model response text; the deployed service must be updated separately to use this change.

**Stays on your Mac:**
- Your source files.
- Projects.
- Preview and rendering.
- Your account refresh session, stored in the macOS Keychain.

Requests use an ephemeral URL session, and temporary audio files are deleted after each request. The checked-in beta configuration provides 60 minutes of source video per account, with promo codes able to add server-side allowance; usage and availability depend on the deployed service. Transcripts are saved per video, so creating more Shorts from the same video does not transcribe it again.

## Projects on disk

```
~/Library/Application Support/Relio/
└── Library/
    └── Projects/
        └── <name>.relio/
            ├── project.sqlite   SQLite (WAL): versionable JSON project record
            ├── Media/           copied source files; originals untouched
            ├── Thumbnails/
            └── Exports/         older exports; new ones go to Downloads › Prism
```

Each edit segment stores the following. Projects from older versions remain readable.

- Source range.
- Caption cues and word timings.
- Caption style, position and size.
- Crop keyframes and layout (Fit, Fill or Split).
- Mute state.
- Title and selection reason.

## Code map

```
macOS/Sources/RelioApp/
  RelioApp.swift            app model, project actions, home, settings, chat
  EditorWorkspace.swift     editor: media bin, player, inspector, timeline
  ShortMaker.swift          analysis pipeline, captions, AVFoundation composition and export
  GeminiSelection.swift     AI client: transcription, scoring, refinement, final cut, chat, Keychain
  TranscriptSelection.swift windows, batching, sentence/word/filler snapping, alignment checks
  SubjectFraming.swift      AI subject location, scene-cut detection, camera path planner
  Core.swift                project store (SQLite), media inspection, data model
  Theme.swift               Prism design tokens and fonts
macOS/Sources/CSQLite/            SQLite system module
```

## Testing

Each test script compiles a small standalone runner with `swiftc`. No live API calls are made: the AI service is replaced by a mock `URLProtocol`.

| Command | Covers |
|---|---|
| `zsh macOS/scripts/smoke-test.sh` | Import, project persistence, range validation, export, Fit and Split layouts, every caption style. Writes `macOS/test-output/`. |
| `zsh macOS/scripts/transcript-selection-test.sh` | Windows, batching, sentence and filler snapping, word alignment checks. |
| `zsh macOS/scripts/gemini-selection-test.sh` | Ranking, late moments, backups, window clamping, timing recovery, quota handling, Gemini framing. Needs `macOS/test-output/pictures.mov` from the smoke test. |
| `zsh macOS/scripts/framing-test.sh` | Camera planner stability, fast subjects, scene cuts and rendered cut timing. |
| `zsh macOS/scripts/editor-model-test.sh` | Editor actions, undo, folders, rename, save and reopen, export. |
| `zsh macOS/scripts/tutorial-test.sh` | First-login guide progression, retry, per-account completion, dismissal, replay and optional editor tour. Uses isolated preferences. |
| `zsh macOS/scripts/ui-smoke-test.sh` | Drives the installed `~/Applications/Prism.app` through its screens with System Events (needs Accessibility permission for your terminal). |

**End-to-end fixture.** After the smoke test:

1. Run `zsh macOS/scripts/generate-speech-fixture.sh` to build a spoken video with two self-contained stories plus an intro and outro.
2. Run it through Prism with a signed-in account. This uses the deployed AI service and counts against the applicable beta allowance.
3. Check the exports with `zsh macOS/scripts/verify-speech-workflow.sh PROJECT_DIRECTORY`.

Mocks prove the logic, not clip quality. Judge real footage yourself.

The Mac app starts a guided first-video tutorial after signing in. It highlights the real controls from **Start creating** through a successful generation, then offers an optional editor tour. **Finish later** leaves it unfinished; **Settings → Account → Replay first-video tutorial** starts it again. For a separate UI preview with fake credentials and simulated generation, run `zsh macOS/scripts/tutorial-preview.sh`; its Preview menu loads a sample and simulates a successful result.

## Packaging and signing

`macOS/scripts/package-app.sh` builds a release binary and assembles `macOS/dist/Prism.app` with icon, fonts and notices. It signs the app with the first of these that is available:

1. `RELIO_SIGNING_IDENTITY`, if set. Uses the hardened runtime and a timestamp, for distribution.
2. **Prism Local Signing**, if it is in your keychain. Create it once with `zsh macOS/scripts/create-signing-identity.sh`.
3. An ad-hoc signature. With this, macOS asks for Keychain access again after every rebuild.

A stable identity lets the Keychain's **Always Allow** survive rebuilds. See [RELEASE-READINESS.md](macOS/RELEASE-READINESS.md) for launch gates.

## Limits

- **Needs a network and an account on macOS.** Nothing AI-driven works offline. Windows and Linux use a Gemini key instead.
- **Word timing is best-effort.** When AI word timestamps fail verification, captions show whole sentences and word highlighting is off for that clip.
- **Framing follows sampled frames at about 1 fps.** It does not identify a specific person across cuts or know who is speaking.
- **Very long recordings** may need a proxy or indexing pipeline.
- **Filler trimming is English-only.**
- **Not yet built:** YouTube upload, analytics, speaker memory, multi-clip storytelling.

## Brand

<p align="center"><img src="macOS/assets/readme/brand.png" width="100%" alt="Prism palette and type: Ink, Paper, Sky, Coral, Amber; Space Grotesk, Sora, JetBrains Mono."></p>

The Prism design system uses:

- Ink `#0E0F14` as the background.
- Sky `#3FA9F5` as the only action colour.
- Space Grotesk for headlines, Sora for interface text and JetBrains Mono for timecodes. The fonts are in `packaging/Fonts` under the SIL Open Font License.

Tokens live in `macOS/Sources/RelioApp/Theme.swift`.

Internal identifiers still say *Relio*, including the bundle ID `app.relio.prototype`, the Application Support folder, the Keychain item and the target names.

## Credits and license

<p align="center"><img src="macOS/assets/readme/icon.png" width="64" alt="Prism icon"></p>

Prism is MIT-licensed; see [LICENSE](LICENSE). Clip selection adapts [OpenShorts](macOS/THIRD-PARTY-NOTICES.md) (MIT). Fonts are under the SIL Open Font License.

Project contributor: [NeoChief (@neochief)](https://github.com/neochief).
