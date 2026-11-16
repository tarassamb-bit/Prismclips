// The session recording on/off switch on the privacy page. A file, not an inline script, so the CSP can block inline scripts.
document.addEventListener('DOMContentLoaded', () => {
  const state = document.getElementById('replay-state'), toggle = document.getElementById('replay-toggle');
  const show = () => { const on = window.relioReplayConsent?.() === 'yes'; state.textContent = on ? 'on' : 'off'; toggle.textContent = on ? 'Turn off' : 'Turn on'; };
  toggle.addEventListener('click', () => { window.relioReplayConsent(window.relioReplayConsent() !== 'yes'); show(); });
  show();
});
