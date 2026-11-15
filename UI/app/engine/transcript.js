// Transcript windows, sentence boundaries and alignment checks, a port of Shared/Prism.Core/TranscriptSelection.cs.
// Adapted from OpenShorts clip_selection.py (MIT). See macOS/THIRD-PARTY-NOTICES.md.
// Cues and words are { text, start, duration } in seconds.

const end = (cue) => cue.start + cue.duration;
const finite = (cue) => Number.isFinite(cue.start) && Number.isFinite(cue.duration);

/** Overlapping windows aligned to caption segments; every segment is visited, including the tail. */
export function windows(cues, interval, seconds = 90, overlap = 30) {
  const segments = cues.filter((c) => finite(c) && c.duration > 0 && c.start >= interval.start && end(c) <= interval.end && c.text.trim())
    .sort((a, b) => a.start - b.start);
  const result = [];
  const size = Math.max(1, seconds);
  let i = 0;
  while (i < segments.length) {
    const start = segments[i].start;
    let j = i;
    while (j + 1 < segments.length && end(segments[j + 1]) - start <= size * 1.25) {
      j += 1;
      if (end(segments[j]) - start >= size) break;
    }
    const finish = end(segments[j]);
    result.push({ start, end: finish, text: segments.slice(i, j + 1).map((s) => s.text).join(' ') });
    if (j === segments.length - 1) break;
    const target = finish - Math.max(0, overlap);
    let k = i + 1;
    while (k <= j && segments[k].start < target) k += 1;
    i = Math.max(k, i + 1);
  }
  return result;
}

/** Share of the interval covered by speech, 0 to 1. */
export function speechCoverage(cues, interval) {
  const length = interval.end - interval.start;
  if (!(length > 0)) return 0;
  const spoken = cues.filter(finite).reduce((sum, c) => sum + Math.max(0, Math.min(end(c), interval.end) - Math.max(c.start, interval.start)), 0);
  return Math.min(1, spoken / length);
}

/** Overlapping windows on the clock, for videos with little speech: every part is judged, with whatever words fall inside. */
export function timeWindows(cues, interval, seconds = 90, overlap = 30) {
  const size = Math.max(1, seconds), step = Math.max(1, size - Math.max(0, overlap));
  const result = [];
  for (let start = interval.start; start < interval.end - 0.001; start += step) {
    const finish = Math.min(interval.end, start + size);
    const text = cues.filter((c) => finite(c) && c.start >= start && end(c) <= finish && c.text.trim()).map((c) => c.text).join(' ');
    result.push({ start, end: finish, text });
    if (finish >= interval.end) break;
  }
  return result;
}

/** Near-equal batches avoid judging a trailing singleton on its own. */
export function batches(values, size = 4) {
  if (values.length === 0) return [];
  const count = Math.ceil(values.length / Math.max(1, size));
  const base = Math.floor(values.length / count), extra = values.length % count;
  const result = [];
  let start = 0;
  for (let index = 0; index < count; index++) {
    const stop = start + base + (index < extra ? 1 : 0);
    result.push(values.slice(start, stop));
    start = stop;
  }
  return result;
}

export const tokens = (value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** A second transcription must retain the source's opening, payoff and most words. */
export function alignmentIsReliable(words, reference) {
  const expected = reference.flatMap((r) => tokens(r.text));
  const actual = words.flatMap((w) => tokens(w.text));
  if (expected.length === 0 || actual.length === 0
    || !words.every((w) => finite(w) && w.duration > 0)
    || words.some((w, index) => index > 0 && words[index - 1].start > w.start)
    || !(expected.slice(0, 3).includes(actual[0]) || actual.slice(0, 3).includes(expected[0]))
    || !(expected.slice(-3).includes(actual.at(-1)) || actual.slice(-3).includes(expected.at(-1)))
    || actual.length > Math.floor(expected.length * 3 / 2) + 3) return false;
  let previous = new Array(actual.length + 1).fill(0);
  for (const token of expected) {
    const current = new Array(actual.length + 1).fill(0);
    for (let index = 0; index < actual.length; index++)
      current[index + 1] = token === actual[index] ? previous[index] + 1 : Math.max(previous[index + 1], current[index]);
    previous = current;
  }
  if (previous.at(-1) / expected.length < 0.95) return false;
  for (const cue of reference) {
    const cueTokens = tokens(cue.text);
    if (cueTokens.length === 0) continue;
    // Each nearby word matches one cue word at most, so a repeated word can't cover a line on its own.
    const remaining = new Map();
    for (const w of words) {
      if (!(end(w) > cue.start - 0.7 && w.start < end(cue) + 0.7)) continue;
      for (const t of tokens(w.text)) remaining.set(t, (remaining.get(t) ?? 0) + 1);
    }
    let matched = 0;
    for (const token of cueTokens) if ((remaining.get(token) ?? 0) > 0) { remaining.set(token, remaining.get(token) - 1); matched++; }
    if (matched / cueTokens.length < 0.65) return false;
  }
  return true;
}

/** Sentence timing is an explicit fallback, not invented word-level precision. */
export function sentenceCaptionGroups(cues) {
  return cues.flatMap((cue) => {
    const words = cue.text.split(/\s+/).filter(Boolean);
    const groups = [];
    for (let index = 0; index < words.length; index += 6) {
      const stop = Math.min(words.length, index + 6);
      groups.push({ text: words.slice(index, stop).join(' '), start: cue.start + cue.duration * index / words.length,
        duration: cue.duration * (stop - index) / words.length });
    }
    return groups;
  });
}

export function paddedPhraseRange(start, duration, cues, interval) {
  const finish = start + duration;
  const before = cues.map(end).filter((t) => t <= start + 0.001);
  const after = cues.map((c) => c.start).filter((t) => t >= finish - 0.001);
  const lead = before.length === 0 ? 0.35 : Math.min(0.35, Math.max(0, (start - Math.max(...before)) / 2));
  const tail = after.length === 0 ? 0.45 : Math.min(0.45, Math.max(0, (Math.min(...after) - finish) / 2));
  const beginning = Math.max(interval.start, start - lead);
  return { start: beginning, duration: Math.min(interval.end, finish + tail) - beginning };
}

export function overlaps(start, duration, otherStart, otherDuration) {
  const intersection = Math.min(start + duration, otherStart + otherDuration) - Math.max(start, otherStart);
  return intersection > 0 && intersection / Math.max(0.000001, Math.min(duration, otherDuration)) >= 0.25;
}

/** Moves a range's edges out of the middle of a sentence; `cues` must be whole sentences. */
export function completeSentences(start, duration, cues, interval, minDuration, maxDuration) {
  const sentences = cues.filter((c) => finite(c) && c.duration > 0 && c.start >= interval.start - 0.001 && end(c) <= interval.end + 0.001)
    .sort((a, b) => a.start - b.start);
  const containing = (time) => sentences.find((s) => s.start + 0.3 < time && end(s) - 0.3 > time);
  let begin = start, finish = start + duration;
  const cutStart = containing(begin);
  if (cutStart) {
    const next = sentences.find((s) => s.start >= end(cutStart) - 0.05);
    if (begin - cutStart.start <= 4 && finish - cutStart.start <= maxDuration) begin = cutStart.start;
    else if (next && finish - next.start >= minDuration) begin = next.start;
    else if (finish - cutStart.start <= maxDuration) begin = cutStart.start;
  }
  const cutEnd = containing(finish);
  if (cutEnd) {
    const sentenceEnd = end(cutEnd);
    const previous = sentences.findLast((s) => end(s) <= cutEnd.start + 0.05);
    if (sentenceEnd - finish <= 8 && sentenceEnd - begin <= maxDuration) finish = sentenceEnd;
    else if (previous && end(previous) - begin >= minDuration) finish = end(previous);
    else if (sentenceEnd - begin <= maxDuration) finish = sentenceEnd;
  }
  return { start: begin, duration: Math.max(0.01, finish - begin) };
}

/** Drops filler-only cues from a range's edges while it keeps `minDuration`, so a Short opens on its hook. */
// shortcut: English filler words only; add per-language lists if non-English sources matter.
export function trimmedFiller(start, duration, cues, minDuration) {
  const openingFiller = new Set(['um', 'uh', 'erm', 'hmm', 'so', 'okay so', 'ok so']);
  const closingFiller = new Set(['thanks for watching', 'thank you for watching']);
  const normalized = (cue) => tokens(cue.text).join(' ');
  const inside = cues.filter((c) => c.start >= start - 0.05 && end(c) <= start + duration + 0.05).sort((a, b) => a.start - b.start);
  let begin = start, finish = start + duration;
  while (inside.length > 1 && openingFiller.has(normalized(inside[0])) && finish - inside[1].start >= minDuration) {
    inside.shift();
    begin = inside[0].start;
  }
  while (inside.length > 1 && closingFiller.has(normalized(inside.at(-1))) && end(inside.at(-2)) - begin >= minDuration) {
    inside.pop();
    finish = end(inside.at(-1));
  }
  return { start: begin, duration: finish - begin };
}

/** Prefers nearby phrase endings, especially punctuation or a pause. Requested lengths remain approximate. */
export function phraseRange(start, duration, cues, interval) {
  const valid = cues.filter((c) => c.start >= interval.start && end(c) <= interval.end).sort((a, b) => a.start - b.start);
  const nearStart = valid.filter((c) => Math.abs(c.start - start) <= 2).sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0];
  const beginning = nearStart?.start ?? start;
  const target = Math.min(interval.end, beginning + duration);
  const tolerance = Math.min(5, duration * 0.2);
  const quality = (index, cue) => {
    const punctuation = '.!?…'.includes(cue.text.at(-1) ?? ' ');
    const pause = index + 1 < valid.length && valid[index + 1].start - end(cue) >= 0.4;
    return Math.abs(end(cue) - target) - (punctuation || pause ? tolerance : 0);
  };
  let best = null, bestQuality = Infinity;
  valid.forEach((cue, index) => {
    if (!(Math.abs(end(cue) - target) <= tolerance && end(cue) > beginning)) return;
    const q = quality(index, cue);
    if (q < bestQuality) { best = cue; bestQuality = q; }
  });
  const ending = best ? end(best) : target;
  return { start: beginning, duration: Math.max(0.01, ending - beginning) };
}

/** The cues a saved transcript holds inside the interval, or null when it doesn't cover all of it. */
export function cuesCovering(transcript, start, finish) {
  if (!transcript || transcript.start > start + 0.01 || transcript.end < finish - 0.01) return null;
  return transcript.cues.filter((c) => c.start >= start - 0.001 && end(c) <= finish + 0.001);
}

/** Speech in 10 ms loudness frames: loud stretches of at least 0.1 s, with gaps shorter than 0.15 s (inside a phrase) closed. */
export function speechRuns(levels, from) {
  const frame = 0.01;
  const smooth = Array.from(levels, (_, i) => {
    const low = Math.max(0, i - 2), high = Math.min(levels.length - 1, i + 2);
    let sum = 0;
    for (let j = low; j <= high; j++) sum += levels[j];
    return sum / (high - low + 1);
  });
  const sorted = [...smooth].sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.1)] ?? 0, loud = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  const threshold = Math.max(0.003, quiet + (loud - quiet) * 0.2);
  const runs = [];
  smooth.forEach((value, i) => {
    if (value <= threshold) return;
    const start = from + i * frame, last = runs.at(-1);
    if (last && start - last.end < 0.15) last.end = start + frame;
    else runs.push({ start, end: start + frame });
  });
  return runs.filter((r) => r.end - r.start >= 0.1);
}

/** Words spread over the speech heard, in proportion to their length, from the first speech to the last. Ignores the AI's
 *  timestamps, which can run slow across a long chunk and make captions fall further behind as a Short goes on; here any
 *  error stays local because both ends are pinned to real speech. */
export function spreadOverSpeech(words, runs) {
  if (words.length === 0 || runs.length === 0) return words;
  const weight = words.map((w) => w.text.replace(/[^\p{L}\p{N}]/gu, '').length + 1);
  const total = weight.reduce((a, b) => a + b, 0);
  const voiced = runs.reduce((sum, r) => sum + r.end - r.start, 0);
  // Voiced seconds from the start of speech to the moment that many seconds into the speech runs.
  const at = (offset) => {
    for (const run of runs) {
      const length = run.end - run.start;
      if (offset < length) return run.start + offset;
      offset -= length;
    }
    return runs.at(-1).end;
  };
  let done = 0;
  return words.map((word, i) => {
    const start = at(done / total * voiced);
    done += weight[i];
    return { ...word, start, duration: Math.max(0.05, at(done / total * voiced) - start) };
  });
}

/** The AI's word timings are guesses. Keeps its words and order, and moves them onto the speech actually heard: consecutive
 *  words are grouped onto each stretch of speech so group lengths fit the stretch (at the clip's own speaking rate) and stay
 *  near where the AI heard them; inside a stretch, words share its time by length. Unchanged when speech can't be found. */
export function alignToSpeech(words, runs) {
  if (words.length === 0 || runs.length === 0) return words;
  const weight = words.map((w) => w.text.replace(/[^\p{L}\p{N}]/gu, '').length + 1);
  const prefix = [0];
  for (const w of weight) prefix.push(prefix.at(-1) + w);
  const voiced = runs.reduce((sum, r) => sum + r.end - r.start, 0);
  const rate = voiced / prefix.at(-1);
  const n = words.length, m = runs.length;
  // best[j][i]: cheapest way to place the first i words on the first j stretches; a stretch may stay empty (a breath, a sound).
  const best = Array.from({ length: m + 1 }, () => new Float64Array(n + 1).fill(Infinity));
  const back = Array.from({ length: m + 1 }, () => new Int32Array(n + 1).fill(-1));
  best[0][0] = 0;
  for (let j = 1; j <= m; j++) {
    const run = runs[j - 1], length = run.end - run.start, middle = (run.start + run.end) / 2;
    for (let i = 0; i <= n; i++) {
      if (best[j - 1][i] + length < best[j][i]) { best[j][i] = best[j - 1][i] + length; back[j][i] = i; }
      for (let k = 0; k < i; k++) {
        if (best[j - 1][k] === Infinity) continue;
        const heard = (words[k].start + words[i - 1].start + words[i - 1].duration) / 2;
        const cost = best[j - 1][k] + Math.abs(length - (prefix[i] - prefix[k]) * rate) + 0.5 * Math.abs(heard - middle);
        if (cost < best[j][i]) { best[j][i] = cost; back[j][i] = k; }
      }
    }
  }
  if (best[m][n] === Infinity) return words;
  const result = new Array(n);
  for (let j = m, i = n; j > 0; j--) {
    const k = back[j][i], run = runs[j - 1];
    let t = run.start;
    const scale = (run.end - run.start) / Math.max(1e-9, prefix[i] - prefix[k]);
    for (let w = k; w < i; w++) {
      const duration = weight[w] * scale;
      result[w] = { ...words[w], start: t, duration };
      t += duration;
    }
    i = k;
  }
  return result;
}
