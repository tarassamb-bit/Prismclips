# First-video tutorial QA

Implemented for macOS. The overlay dims the app and cuts out a spotlight over the real controls. Instructions occupy a reserved footer so they do not cover the controls at the 1100 × 720 minimum content size.

## Verified

- `swift build --package-path macOS`.
- `zsh macOS/scripts/package-app.sh`: production build and strict code-signature verification.
- `editor-model-test.sh` with a throwaway preferences home: existing project, import, editor, undo/redo, caption, export, and panel-folding regression checks pass.
- `zsh macOS/scripts/tutorial-test.sh`: signed-out state, first sign-in, forward and backward navigation, unsuccessful editor entry, Finish later, a fresh sign-in, case-insensitive account completion, separate accounts, replay, and every optional editor-tour stage.
- Native Mac UI in `tutorial-preview.sh`, with a throwaway home and fake key store: Start creating advances to upload; selecting the sample advances to settings; an actual pointer click through the spotlight advances to captions; scrolling reaches the next control; continuing advances to content type.
- Simulated successful creation shows **You created your first video**, followed by the optional Shorts, preview, captions, timeline, and export tour. Export opens its dialog and hides the tutorial until the dialog closes. Finish tutorial restores the normal editor.
- Visual inspection of the start, settings, captions, and timeline spotlights at the minimum window size.

Completion is recorded only after the production generation path saves a nonempty new batch. Cancellation, errors, imports and manually opening an editor do not complete the guide. An unfinished guide returns on the next sign-in or launch. Completion is stored per account on the current Mac.

## Live follow-up

A new live AI generation was not run for this UI change. On a test account, follow the guide with a speech video, generate a Short successfully, and relaunch to confirm the guide stays finished. Cancel or fail a generation in a separate unfinished tutorial to check the retry path against real service responses.
