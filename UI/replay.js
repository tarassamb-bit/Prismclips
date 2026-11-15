// PostHog session replay for the web app, only after the person agrees. Nothing from PostHog loads before consent.
// Masked: every input, every piece of text inside the app (project names, titles, captions, transcripts) and the URL's
// project part. Blocked (recorded as an empty box): the video preview, the timeline, thumbnails, every <video>, <canvas>, <img>.
// The choice is kept in localStorage; privacy.html and the app's banner can change it at any time.
(() => {
  const KEY = 'relio-replay-consent';
  const LIVE = ['relioclips.com', 'www.relioclips.com'];
  // Everything the app draws itself; all of it may hold what people wrote or uploaded.
  const MASK_TEXT = '#app, #dialog, #progress, #gate, #screen-title, #upload-status, .p-title, .card-title, .project-card, .title-input';
  const BLOCK = 'video, canvas, img, .player, .timeline, .tl-track, .tl-clip, .card-thumb, .poster, .style-preview';

  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (value) => { try { localStorage.setItem(KEY, value); } catch { /* private window: asked again next time */ } };

  // Project addresses carry the project's title; the same grouping analytics.js uses.
  const scrub = (url) => typeof url === 'string' ? url
    .replace(/\/app\/project\/[^/?#]+\/short-\d+/, '/app/project/[project]/short/[n]')
    .replace(/\/app\/project\/[^/?#]+/, '/app/project/[project]')
    .replace(/[?#].*$/, '') : url;

  const scrubAll = (value) => {
    if (typeof value === 'string') return value.includes('/app/project/') ? scrub(value) : value;
    if (Array.isArray(value)) return value.map(scrubAll);
    if (value && typeof value === 'object') { for (const key of Object.keys(value)) value[key] = scrubAll(value[key]); }
    return value;
  };

  let started = false;
  async function start() {
    if (started) return;
    started = true;
    const config = await fetch('/api/posthog-config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!config?.key) { started = false; return; }
    await new Promise((resolve, reject) => {
      const script = Object.assign(document.createElement('script'), { src: '/vendor/posthog-1.440.0.full.js', onload: resolve, onerror: reject });
      document.head.append(script);
    });
    window.posthog.init(config.key, {
      api_host: config.host,
      ui_host: 'https://eu.posthog.com',
      person_profiles: 'identified_only',
      autocapture: false,
      capture_pageview: true,
      capture_pageleave: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_surveys: true,
      enable_heatmaps: false,
      capture_dead_clicks: false,
      session_recording: {
        maskAllInputs: true,
        maskInputOptions: { password: true, email: true, text: true, textarea: true, search: true, number: true, tel: true, url: true },
        // A fixed mask, so a recording doesn't even show how long the typed text was.
        maskInputFn: () => '***',
        maskTextSelector: MASK_TEXT,
        // Same for text: no word lengths or word count.
        maskTextFn: (text) => (text.trim() ? '***' : text),
        blockSelector: BLOCK,
        recordCrossOriginIframes: false,
        recordHeaders: false,
        recordBody: false,
      },
      // Every string anywhere in the event, replay data included: PostHog keeps adding URL properties ($session_entry_url…),
      // so a fixed list of fields would miss the next one.
      before_send: (event) => (event ? scrubAll(event) : event),
    });
  }

  function stop() {
    try { window.posthog?.stopSessionRecording(); window.posthog?.opt_out_capturing(); window.posthog?.reset(); } catch { /* not loaded */ }
  }

  /** consent(true|false) records the choice and starts or stops replay; consent() returns 'yes', 'no' or null. */
  window.relioReplayConsent = (value) => {
    if (value === undefined) return read();
    write(value ? 'yes' : 'no');
    document.getElementById('replay-banner')?.remove();
    if (value) { window.posthog?.opt_in_capturing(); start(); } else stop();
    return read();
  };

  function banner() {
    const box = document.createElement('div');
    box.id = 'replay-banner';
    box.className = 'replay-banner';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Session recording');
    box.innerHTML = `<p>Help us improve Relio? With your OK we record how you use the app to find bugs. Your videos, previews,
      timeline, typing and text are hidden from the recording. <a href="/privacy#session-replay">Details</a></p>
      <div><button type="button" data-replay="no">No thanks</button><button type="button" data-replay="yes">Allow</button></div>`;
    box.addEventListener('click', (e) => {
      const choice = e.target.closest('[data-replay]')?.dataset.replay;
      if (choice) window.relioReplayConsent(choice === 'yes');
    });
    document.body.append(box);
  }

  // Only on the live site, or locally with ?replaytest (for checking what is recorded).
  const enabled = LIVE.includes(location.hostname) || /[?&]replaytest\b/.test(location.search);
  if (!enabled || !location.pathname.startsWith('/app')) return;
  const ready = () => { const choice = read(); if (choice === 'yes') start(); else if (choice === null) banner(); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', ready) : ready();
})();
