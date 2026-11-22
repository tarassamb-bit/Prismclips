// The first-project tour's steps, as a pure function of where the person is, so the order is unit-tested (tour.test.mjs).
// app.js draws the hint and saves the stage. Stages: 'on' (follow the screens) -> 'edit' -> 'export' -> 'done'.

export const TOUR_STEPS = 7;

/**
 * The hint for this moment, or null when there is none.
 * `at` = { stage, dialog, screen, running (Shorts are being made), createStep, shorts (in the open project),
 *          made (a project on Home already has Shorts) }.
 * A hint has { step, target (CSS selector), text (HTML) } and, when the person moves on with a button, { button, then }:
 * `then` is the next stage, or 'finish'; `back` is the stage the Back button returns to.
 */
export function hintFor({ stage, dialog, screen, running, createStep, shorts, made }) {
  if (!stage || stage === 'done' || dialog) return null;
  if (stage === 'edit' || stage === 'export') {
    if (screen !== 'editor' || !shorts) return null;
    return stage === 'edit'
      ? { step: 6, target: '#inspector', text: 'Edit the selected Short here: its title, captions, start, length and crop. The preview in the middle shows every change.', button: 'Next', then: 'export', back: 'on' }
      : { step: 7, target: '#export-button', text: '<strong>Export</strong> saves your Shorts as video files, ready to post.', button: 'Finish', then: 'finish', back: 'edit' };
  }
  if (running) {
    // On the games screen the hint sits on the game cards and goes away once a game is open, so it never covers a game.
    return screen === 'games' ? { step: 4, target: '.games-grid', text: 'Relio AI needs a few minutes. Pick a game while you wait: the progress stays in the corner.' }
      : { step: 4, target: '#progress .progress-card', text: 'Relio AI is finding the best moments. This takes a few minutes, and the progress stays here.' };
  }
  // Someone who comes back with Shorts already made is sent to them, not told to start over.
  if (screen === 'home' && made) return { step: 5, target: '.project-card', text: 'Your Shorts are in this project. Open it to watch, edit and export them.' };
  if (screen === 'home') return { step: 1, target: '.start-card', text: 'Start here: choose a video and Relio makes Shorts from it.' };
  if (screen === 'create') {
    if (createStep === 1) return { step: 2, target: '.drop-card', text: 'Choose a video from your device, or drop it here.' };
    if (createStep === 2) return { step: 3, target: '[data-create="make"]', text: 'Everything starts on <strong>Auto</strong>. Change what you like, then press <strong>Make Shorts</strong>.' };
  }
  if (screen === 'editor' && shorts) {
    return { step: 5, target: '.short-card', text: 'Your Shorts are ready, best ones marked with a score. Click one to watch it.', button: 'Next', then: 'edit' };
  }
  return null;
}
