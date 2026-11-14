// "Play while you wait": a small games panel shown only while Shorts are being made. app.js loads this file when a run
// starts, and each game's code loads only when the player opens it, so the AI step isn't slowed.
// When the Shorts are ready, a banner sits on top of whatever is open, with a button to view them: a game never hides the result.

const GAMES = [
  { id: 'stack', name: 'Stack the tower', unit: '', lower: false, load: () => import('./stack.js'),
    icon: '<path d="M6 18h12M7 14h10M8 10h8M9 6h6"/>' },
  { id: 'draw', name: 'Draw the logo', unit: ' / 100', lower: false, load: () => import('./draw.js'),
    icon: '<path d="M4 20l4-1 10-10-3-3L5 16zM14 7l3 3"/>' },
  { id: 'reaction', name: 'Reaction test', unit: ' ms', lower: true, load: () => import('./reaction.js'),
    icon: '<circle cx="12" cy="13" r="7"/><path d="M12 13V9M10 3h4"/>' },
];
const SUBMIT_GAP_MS = 5000; // the server refuses more than one score per 5 s; waiting here spares the request

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not remembered: private mode or blocked storage */ } };
const bestOf = (game) => { const raw = read(`relio-game-best-${game.id}`); return raw === null || !Number.isFinite(Number(raw)) ? null : Number(raw); };
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (game) => `<svg viewBox="0 0 24 24" aria-hidden="true">${game.icon}</svg>`;

/**
 * Shows the panel in `host`. `db()` returns the Supabase client (or null), `signedIn()` says whether scores can be saved,
 * `onView()` runs when the person asks to see their finished Shorts. Returns { ready(count), close() }.
 */
export function mountGames(host, { db, signedIn, onView }) {
  host.hidden = false;
  host.innerHTML = `<section class="games-panel" aria-label="Play while you wait">
      <div class="games-ready" role="status" hidden><strong></strong><button type="button" class="button primary" data-g="view">View Shorts</button></div>
      <header class="games-head">
        <button type="button" class="link games-back" data-g="back" hidden>‹ Games</button>
        <strong class="games-title">Play while you wait</strong>
        <button type="button" class="games-min" data-g="min" aria-label="Hide games" aria-expanded="true">–</button>
      </header>
      <div class="games-body"></div>
    </section>`;
  const panel = host.firstElementChild, body = panel.querySelector('.games-body');
  let stop = null, current = null, lastSubmit = 0, opening = 0;

  function picker() {
    stop?.(); stop = null; current = null;
    panel.querySelector('.games-back').hidden = true;
    panel.querySelector('.games-title').textContent = 'Play while you wait';
    const last = read('relio-game-last');
    body.innerHTML = `<div class="games-grid">${GAMES.map((g) => {
      const best = bestOf(g);
      return `<button type="button" class="game-card" data-g="open" data-id="${g.id}">${icon(g)}<strong>${g.name}</strong>
        <span class="muted small">${best == null ? 'No score yet' : `Best: ${best}${g.unit}`}</span>${last === g.id ? '<span class="game-last small">Last played</span>' : ''}</button>`;
    }).join('')}</div>
      <button type="button" class="button ghost games-surprise" data-g="surprise">Surprise me</button>`;
  }

  async function open(id) {
    const game = GAMES.find((g) => g.id === id);
    if (!game) return;
    const ticket = ++opening;
    stop?.(); stop = null; current = game;
    write('relio-game-last', game.id);
    panel.querySelector('.games-back').hidden = false;
    panel.querySelector('.games-title').textContent = game.name;
    body.innerHTML = `<div class="game-stage"><p class="muted small">Loading…</p></div>
      <div class="leaderboard"><h4>This week’s top 10</h4><ol></ol></div>`;
    leaderboard(game);
    try {
      const module = await game.load();
      if (ticket !== opening) return; // another game was opened meanwhile
      stop = module.start(body.querySelector('.game-stage'), { onEnd: (score, playedMs) => finished(game, score, playedMs) });
    } catch {
      body.querySelector('.game-stage').innerHTML = '<p class="muted small">This game couldn’t load. Check your connection and try again.</p>';
    }
  }

  async function finished(game, score, playedMs) {
    const best = bestOf(game);
    if (best == null || (game.lower ? score < best : score > best)) write(`relio-game-best-${game.id}`, String(score));
    if (!signedIn() || !db() || Date.now() - lastSubmit < SUBMIT_GAP_MS) return;
    lastSubmit = Date.now();
    const { error } = await db().from('game_scores').insert({ game: game.id, score: Math.round(score), played_ms: Math.round(playedMs) });
    if (!error && current === game) leaderboard(game);
  }

  async function leaderboard(game) {
    const list = body.querySelector('.leaderboard ol');
    if (!list) return;
    if (!signedIn() || !db()) { list.outerHTML = '<p class="muted small">Sign in to join the weekly leaderboard.</p>'; return; }
    const { data, error } = await db().rpc('game_leaderboard', { p_game: game.id });
    if (current !== game || !list.isConnected) return;
    if (error) { list.innerHTML = '<li class="muted small">The leaderboard isn’t available right now.</li>'; return; }
    list.innerHTML = data?.length
      ? data.map((row) => `<li><span>${esc(row.username)}</span><span>${row.score}${game.unit}</span></li>`).join('')
      : '<li class="muted small">No scores this week yet. Be the first!</li>';
  }

  panel.addEventListener('click', (event) => {
    const target = event.target.closest('[data-g]');
    if (!target) return;
    const action = target.dataset.g;
    if (action === 'open') open(target.dataset.id);
    else if (action === 'surprise') open(GAMES[Math.floor(Math.random() * GAMES.length)].id);
    else if (action === 'back') picker();
    else if (action === 'view') onView();
    else if (action === 'min') {
      const hidden = panel.classList.toggle('minimized');
      target.setAttribute('aria-expanded', String(!hidden));
      target.setAttribute('aria-label', hidden ? 'Show games' : 'Hide games');
      target.textContent = hidden ? '+' : '–';
    }
  });
  picker();

  return {
    /** The Shorts are done: a banner on top of the panel says so, whatever game is open. */
    ready(count) {
      const banner = panel.querySelector('.games-ready');
      banner.querySelector('strong').textContent = count === 1 ? 'Your Short is ready!' : 'Your Shorts are ready!';
      banner.hidden = false;
      panel.classList.remove('minimized');
      banner.querySelector('button').focus({ preventScroll: true });
    },
    close() {
      opening++;
      stop?.(); stop = null;
      host.hidden = true;
      host.innerHTML = '';
    },
  };
}
