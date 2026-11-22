// Time left for a long task whose stages run at very different speeds (transcribing is fast, refining slow).
// The speed over the last few minutes predicts the rest far better than the average since the start.

const WINDOW_MS = 150_000;

/** Adds a progress reading; keeps only what the estimate needs. */
export function addSample(samples, at, progress) {
  if (samples.length && progress <= samples.at(-1).progress) return samples;
  samples.push({ at, progress });
  while (samples.length > 2 && at - samples[1].at > WINDOW_MS) samples.shift();
  return samples;
}

/** Seconds left, or null until there is enough to go on. `previous` smooths the figure so it doesn't jump. */
export function estimateLeft(samples, now, started, previous = null) {
  const last = samples.at(-1);
  if (!last || !(last.progress >= 0.03 && last.progress < 1) || now - started < 20_000) return null;
  const first = samples.find((s) => now - s.at <= WINDOW_MS) ?? samples[0];
  const span = (last.at - first.at) / 1000, gained = last.progress - first.progress;
  // Too little recent movement to measure: fall back to the average since the start.
  const rate = span >= 20 && gained > 0 ? gained / span : last.progress / ((now - started) / 1000);
  // A stage that hasn't reported for a while is slower than its last rate said.
  const stalled = Math.max(0, (now - last.at) / 1000 - 10);
  const fresh = (1 - last.progress) / rate + stalled * 0.5;
  if (previous == null) return fresh;
  return Math.max(0, previous.seconds - (now - previous.at) / 1000) * 0.7 + fresh * 0.3;
}
