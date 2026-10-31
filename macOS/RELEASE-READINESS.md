# Prism release readiness

Prism is a macOS video-to-vertical-Shorts editor in beta. It is not yet approved for a commercial release. Internal identifiers still say Relio (bundle ID `app.relio.prototype`, executable `Relio`, `~/Library/Application Support/Relio`) so existing projects and settings keep working.

## How it works now

All AI runs in the cloud; there is no on-device AI. The app sends Gemini-format requests to the `gemini` Supabase function, which forwards them to OpenRouter (the `OPENROUTER_MODEL` secret first, then free fallback models). Transcription, clip picking, word timing, subject positions and descriptions come from those requests. Cut snapping, the camera path, scene-cut detection and rendering run on the Mac.

Previews play live through the same composition used for export, so they start at once. Export renders 1080 × 1920 H.264 or HEVC. Sources under 720p are first enlarged with Lanczos resampling, which helps a little; a 1080p source is still needed for sharp Shorts, and the create screen says so.

Usage: each account gets 60 minutes of video in total during the beta, plus promo-code minutes. The server refuses requests past that allowance and past a spend cap of allowance × `usd_per_minute`. Every model answer counts at least $0.002 toward the cap, so free models are bounded too.

## Verified engine behavior

`zsh scripts/smoke-test.sh` covers import, SQLite project persistence, range validation, corrupt input rejection, invalid edits, destination preservation, caption timing and styles, Fit and Split layouts, rotated sources, live preview, title and description metadata and `.txt` files, and 1080 × 1920 MP4 export. `zsh scripts/gemini-selection-test.sh` covers the AI request pipeline against a mock server, including retries, quota errors, saved transcripts and descriptions.

## Build

`zsh scripts/package-app.sh` builds `dist/Prism.app`. It signs with `RELIO_SIGNING_IDENTITY` if set (hardened runtime, for distribution), else with the local "Prism Local Signing" identity, else ad hoc. Notarization and stapling still need Apple developer credentials and must be done before public distribution.

## Remaining launch gates

- Measure clip quality on real podcasts, interviews and tutorials: how many Shorts a creator would actually post.
- Time a real 30-minute video from start to finished Shorts.
- Framing follows the AI's subject positions at about 1 frame per second; it does not know who is speaking.
- Usage minutes come from the app; the spend cap is the server-side bound. Compute minutes on the server before paid plans.
- Developer ID signing and notarization, then the bundle ID question (changing it needs a migration).
- Paid plans: see `../FUTURE-PRICING.md`.
- Windows and Linux compile but have not been tested on real machines.

## History

The sections below record tests of the earlier on-device pipeline, removed on October 19, 2026. They no longer describe the app.

## Real-video test — October 4, 2026

Tested `~/Downloads/video-1790957260292.mp4`: 1280 × 720, 798.58 seconds, with audio. Managed import, project save/reopen, three fallback 30-second selections, 1080 × 1920 exports, and frame decoding passed. Also rendered a full-frame alternative after visual inspection showed the centered crop removed useful CAD interface content. The editor now offers **Fit entire video** and **Fill vertical frame** in the preview menu.

Outputs are in `test-output/downloads-video-test-20261004-fit/`. Desktop automation could not initialize. Speech recognition could not run in the command-line harness because macOS attributed the privacy request to the terminal host without a speech usage description. No speech permissions were changed. These tests explicitly disable transcription and validate fallback selection; they do not validate moment quality, subtitles, or desktop interaction.

(`scripts/real-video-test.sh` was removed on October 19, 2026, with the on-device pipeline it exercised.)

## Real-video regression — October 11, 2026

After adding motion scoring to Auto Shorts, reran the same 1280 × 720, 798.58-second source. The selector returned three distinct 30-second moments at 71.3, 543.8, and 686.3 seconds. All three exports passed 1080 × 1920 dimension, duration, audio-track, and decoded-frame checks; the Fit alternative rendered. Speech recognition remained disabled in this command-line run, so subtitle accuracy was not evaluated. Outputs are in `/tmp/relio-motion-analysis-qa-20261011/`.
