// Reaction test: after a random 1–4 s the box turns blue; tap as fast as possible. Tapping before that is a fail.
// Score = best of 5 rounds in ms (lower is better). Loaded only when the player opens it (see panel.js).
import { reactionScore, reactionDelay } from './scoring.js';

const ROUNDS = 5;

export function start(root, { onEnd }) {
  const box = document.createElement('button');
  box.type = 'button';
  box.className = 'reaction-box';
  const log = document.createElement('ol');
  log.className = 'reaction-dots';
  log.setAttribute('aria-label', 'Rounds');
  root.replaceChildren(box, log);

  let rounds, state, goAt, timer, started;
  const show = (text, mode) => { box.textContent = text; box.dataset.mode = mode; };
  // Five pills, one per round: its time, "early", or its number while still to come.
  const report = () => log.replaceChildren(...Array.from({ length: ROUNDS }, (_, i) => {
    const r = rounds[i], li = document.createElement('li');
    li.className = i >= rounds.length ? '' : r == null ? 'early' : 'done';
    li.textContent = i >= rounds.length ? String(i + 1) : r == null ? 'early' : `${Math.round(r)} ms`;
    return li;
  }));
  function begin() { rounds = []; started = performance.now(); report(); next(); }
  function next() {
    state = 'waiting';
    show('Wait for blue…', 'wait');
    timer = setTimeout(() => { state = 'go'; goAt = performance.now(); show('Tap!', 'go'); }, reactionDelay());
  }
  function finish() {
    state = 'done';
    const best = reactionScore(rounds);
    show(best == null ? 'Every round was early. Tap to try again' : `Best: ${best} ms. Tap to play again`, 'done');
    if (best != null) onEnd(best, performance.now() - started);
  }
  function tap(event) {
    event.preventDefault();
    if (state === 'done' || state === 'idle') return begin();
    if (state === 'result') return rounds.length === ROUNDS ? finish() : next();
    if (state === 'waiting') { clearTimeout(timer); rounds.push(null); show('Too early! Tap to continue', 'early'); }
    else if (state === 'go') { const ms = performance.now() - goAt; rounds.push(ms); show(`${Math.round(ms)} ms. Tap to continue`, 'result'); }
    state = 'result';
    report();
  }
  // pointerdown, not click: click adds the browser's tap delay to the measured time.
  box.addEventListener('pointerdown', tap);
  box.addEventListener('keydown', (event) => { if (event.code === 'Space' || event.key === 'Enter') tap(event); });
  state = 'idle';
  rounds = [];
  report();
  show('Tap to start. 5 rounds', 'idle');
  box.focus({ preventScroll: true });
  return () => clearTimeout(timer);
}
