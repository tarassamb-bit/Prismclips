// Scoring for the "Play while you wait" games. Pure functions, so they are unit-tested (scoring.test.mjs) and the games
// stay thin. The server repeats the limits below (supabase/migrations/202611140001_game_scores.sql); keep both in step.

export const LIMITS = {
  minReactionMs: 100,   // faster than any human answer to a colour change: rejected
  stackDropMs: 300,     // the tower accepts at most one drop per this many ms, so height is bounded by time played
  drawMinPlayedMs: 3000, // the logo alone is shown for 3 s
};

// MARK: Stack the tower

/** The part of `block` resting on `below` (both { x, w }), or null when it missed entirely. The overhang is cut off. */
export function cutBlock(below, block) {
  const left = Math.max(below.x, block.x);
  const right = Math.min(below.x + below.w, block.x + block.w);
  return right - left > 0 ? { x: left, w: right - left } : null;
}

/** The highest tower that time allows: one block per drop interval. The server applies the same rule. */
export const maxStack = (playedMs) => Math.floor(playedMs / LIMITS.stackDropMs) + 1;

// MARK: Reaction test

/** Best (lowest) time of the rounds, in whole ms. Fails (null: tapped early) don't count; null when every round failed.
 *  Times under the human limit are treated as fails too. */
export function reactionScore(rounds) {
  const valid = rounds.filter((ms) => Number.isFinite(ms) && ms >= LIMITS.minReactionMs);
  return valid.length ? Math.round(Math.min(...valid)) : null;
}

/** A random wait of 1–4 s before the screen turns blue. `random` is injectable for tests. */
export const reactionDelay = (random = Math.random) => 1000 + random() * 3000;

// MARK: Draw the logo

/** Points spaced evenly along each stroke (a stroke is an array of [x, y]), `count` in total over all strokes. */
export function resample(strokes, count = 96) {
  const segments = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const [ax, ay] = stroke[i - 1], [bx, by] = stroke[i];
      segments.push({ ax, ay, bx, by, length: Math.hypot(bx - ax, by - ay) });
    }
  }
  const total = segments.reduce((sum, s) => sum + s.length, 0);
  if (total === 0) return strokes.flat().slice(0, 1);
  const points = [];
  let segment = 0, walked = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (segment < segments.length - 1 && walked + segments[segment].length < target) walked += segments[segment++].length;
    const s = segments[segment], t = s.length ? Math.min(1, (target - walked) / s.length) : 0;
    points.push([s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t]);
  }
  return points;
}

/** Centres the points on their bounding box and scales its larger side to 1, so size and position don't matter. */
export function normalize(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return points.map(([x, y]) => [(x - cx) / size, (y - cy) / size]);
}

const meanNearest = (from, to) => from.reduce((sum, [x, y]) => sum + Math.min(...to.map(([u, v]) => Math.hypot(x - u, y - v))), 0) / from.length;

/** 0–100: how closely the drawing's outline matches the logo's, by the average distance between the two outlines both ways
 *  (a missing part and an extra scribble both cost). Position and size don't matter; a drawing with almost no ink scores 0. */
export function shapeScore(drawn, template) {
  const ink = drawn.filter((stroke) => stroke.length > 1);
  if (!ink.length) return 0;
  const a = normalize(resample(ink)), b = normalize(resample(template));
  if (a.length < 2) return 0;
  const distance = (meanNearest(a, b) + meanNearest(b, a)) / 2;
  // 0 distance is a perfect copy; 0.12 of the shape's size off on average is a miss.
  return Math.round(Math.max(0, Math.min(100, 100 * (1 - distance / 0.12))));
}
