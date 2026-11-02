# Prism in the browser

The web version of Prism lives in this folder and is served at `/app/` by the same site (Vercel, or `node dev-server.js` in `UI/`, then open http://localhost:4173/app/).

- **Sign-in and limits:** the app reuses the website's Supabase session, so signing in on the site signs in here. The minute allowance, promo codes and re-analysis charges are the same server functions the desktop apps call (`my_usage`, `my_reanalysis`, `usage_allowed`, `redeem_promo`).
- **AI:** requests go to the existing `gemini` edge function with the same headers (`x-prism-video`, `x-prism-minutes`, `x-prism-run`). The AI key never reaches the browser.
- **Video:** read and rendered in the browser with WebCodecs through Mediabunny (`../vendor/mediabunny-1.61.5.min.mjs`, MPL-2.0, see `../vendor/MEDIABUNNY-LICENSE`). Videos and projects are kept in this browser's IndexedDB; only short audio chunks and a few frames are sent to Prism AI.
- **Engine:** `engine/` is a port of `Shared/Prism.Core` (selection, framing, captions, rendering). When one changes, change the other.
- **Browsers:** needs WebCodecs (a current Chrome, Edge, Safari or Firefox); other browsers see a message. HEVC export only where the browser can encode it.

## Checks

```sh
node UI/app/engine/engine.test.mjs   # pure engine logic, no browser or network
```

The rendering path needs a real browser; it was checked in headless Chromium with a generated video and a mocked server.
