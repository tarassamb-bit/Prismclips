# Motion Studio (local)

Run `node UI/dev-server.js` from the repository root and open http://localhost:4173/motion/. The Motion OpenRouter key lives outside this repo: put `MOTION_OPENROUTER_API_KEY=...` in `~/.config/relio-motion/.env` (or set `MOTION_ENV_FILE`). It never uses the Relio Clips key. Generation and visual review use MiMo V2.6 Flash with medium reasoning through the existing local `OPENROUTER_API_KEY` in `UI/.env.local`. `MOTION_MODEL` and `MOTION_REVIEW_MODEL` can override the respective models. The review model must accept images.

Motion Studio uses one Canvas-based workflow for generation, in-browser playback, direct frame sampling, and browser MP4 export. Generated code runs in an isolated iframe. Remotion and HyperFrames integrations remain in the local source for development, but they are not combined into the active workflow. Do not run model-generated compositions on the Node host.

The browser runtime is built from pinned dependencies. To rebuild after changing it, run `npm ci --prefix UI/motion` and `npm run build --prefix UI/motion`.

After generation the app samples five 720×1280 frames directly from the Canvas preview, renders a sample of the selected supplied style in a separate sandboxed iframe, and asks the configured OpenRouter model to describe that reference and inspect each frame separately. It makes at most one corrective revision if the review identifies a concrete issue. The corrected result is sampled once more. If capture or review fails, the chat reports that it could not complete the visual check. Sampling cannot verify every frame. Review and any corrective generation use additional model calls and may incur additional cost.
