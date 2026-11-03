// Turns a long video into Shorts: transcript, selection, exact boundaries and framing. A port of Shared/Prism.Core/ShortMaker.cs.
import { GeminiError, map } from './gemini.js';
import * as T from './transcript.js';
import * as S from './selection.js';
import * as Framing from './framing.js';
import { audioLevels } from './media.js';
import { regionInterval, forcesFit, SELECTION_GUIDANCE, VIDEO_TYPE_TITLES } from './models.js';

export const MAX_SHORTS = 20;
/** How many Shorts Auto makes room for: one per minute of the analyzed part, 1 to 20. */
export const autoCount = (seconds) => Math.min(MAX_SHORTS, Math.max(1, Math.floor(seconds / 60)));

const truncate = (value, length) => (value.length > length ? value.slice(0, length) : value);

/**
 * @param options { duration, count, region, customStart, customEnd, excluding, videoType, cachedTranscript, onTranscript, progress, signal }
 * @returns Shorts as { start, duration, captions, cropKeyframes, speechWords, warning, title, reason, fit, videoType, score, description }
 */
export async function analyze(source, configuration, options) {
  const { excluding = [], cachedTranscript = null, onTranscript = () => {}, progress = () => {}, signal } = options;
  let videoType = options.videoType ?? 'general';
  const interval = regionInterval(options.region, source.duration, options.customStart, options.customEnd);
  if (excluding.some((e) => e.start <= interval.start && e.end >= interval.end)) throw new GeminiError('noDistinctClips');
  // 0 is Auto length; Prism AI sizes each clip within lengthRange.
  const clipDuration = options.duration > 0 ? Math.min(Math.max(1, options.duration), interval.end - interval.start) : 0;
  // A count of 0 means Auto: room for one Short per minute, and only clips Prism AI scores as strong fill it.
  const targetCount = options.count > 0 ? Math.min(options.count, MAX_SHORTS) : autoCount(interval.end - interval.start);
  progress(0, 'Preparing audio for Prism AI');
  let transcript;
  const saved = T.cuesCovering(cachedTranscript, interval.start, interval.end);
  if (!source.hasAudio) transcript = [];
  else if (saved) {
    // Saved by an earlier run on this video: no audio upload and no transcription cost.
    progress(0.55, 'Using the saved transcript');
    transcript = saved;
  } else {
    // An earlier run that failed partway saved the stretch it finished; only the rest is transcribed again.
    const partial = cachedTranscript;
    const kept = partial && partial.start <= interval.start + 0.01 && partial.end > interval.start + 1 && partial.end < interval.end
      ? T.cuesCovering(partial, interval.start, partial.end) : null;
    const from = kept ? partial.end : interval.start;
    const keptCues = kept ?? [];
    const fresh = await S.transcribeSentences(source, { start: from, end: interval.end }, configuration, (fraction) => {
      const overall = (from - interval.start + fraction * (interval.end - from)) / (interval.end - interval.start);
      progress(0.55 * overall, `Prism AI · transcribing audio · ${Math.floor(overall * 100)}%`);
    }, (cues, end) => onTranscript({ start: interval.start, end, cues: [...keptCues, ...cues] }), signal);
    transcript = [...keptCues, ...fresh];
    onTranscript({ start: interval.start, end: interval.end, cues: transcript });
  }
  progress(0.55, 'Selecting distinct moments');
  if (videoType === 'auto') {
    progress(0.55, 'Prism AI · recognizing the kind of video');
    videoType = transcript.length === 0 ? 'general' : await S.detectVideoType(transcript, configuration, signal);
    progress(0.55, `Prism AI · ${VIDEO_TYPE_TITLES[videoType]}`);
  }
  progress(0.55, 'Prism AI · choosing complete stories and layouts');
  let clips = await S.select(source, transcript, interval, clipDuration, targetCount, configuration, excluding, SELECTION_GUIDANCE[videoType] ?? '',
    (fraction, stage) => progress(0.55 + 0.15 * fraction, stage), signal);
  // Auto keeps only strong picks; when Prism AI found none, the single best weaker one beats failing.
  const strong = clips.filter((c) => !c.reason?.startsWith('Weaker pick'));
  if (!(options.count > 0)) clips = strong.length === 0 ? clips.slice(0, 1) : strong;
  // Screens and gameplay lose their edges in a vertical crop, whatever the picker suggested.
  // Only screens and gameplay are forced to the whole frame. The picker's own 'fit' guess is ignored: from a few sparse frames it
  // calls too many talking heads "slides". Framing looks at every second and still shows the whole frame when it really is a screen.
  const picks = clips.map((c) => ({ ...c, duration: c.end - c.start, fit: forcesFit(videoType) }));
  let steps = 0;
  const reportStep = (stage) => { steps++; progress(0.7 + 0.29 * Math.min(1, steps / (targetCount * 2)), stage); };
  // Picks are prepared a wave at a time; a pick that now overlaps an earlier one gives way to the next backup.
  const accepted = [];
  let aligning = true, next = 0;
  while (accepted.length < targetCount && next < picks.length) {
    signal?.throwIfAborted();
    const wave = [];
    for (let i = next; i < Math.min(picks.length, next + targetCount - accepted.length); i++) wave.push(i);
    next += wave.length;
    const prepared = await map(wave, async (index, token) => {
      const shot = await prepareShort(source, picks[index].start, picks[index].duration, transcript, interval, clipDuration, aligning, configuration, token);
      reportStep(`Aligning speech and pauses · Short ${index + 1}`);
      return { index, shot };
    }, signal);
    for (const { index, shot } of prepared) {
      if (shot.alignmentFailed) aligning = false;
      const clash = (other) => T.overlaps(shot.start, shot.duration, other.start, other.duration);
      if (excluding.some((e) => clash({ start: e.start, duration: e.end - e.start })) || accepted.some((a) => clash(a.shot))) continue;
      accepted.push({ index, shot });
      if (accepted.length === targetCount) break;
    }
  }
  const results = await map(accepted, async ({ index, shot }, token) => {
    const candidate = picks[index];
    const { start, duration } = shot;
    const source_ = shot.words.length > 0 ? S.captionCues(shot.words, { start, end: start + duration }) : T.sentenceCaptionGroups(shot.referenceCues);
    const captions = clipCaptions(source_, start, duration);
    const words = shot.words.filter((w) => w.start >= start - 0.01 && w.start + w.duration <= start + duration + 0.01).map((w) => ({ ...w, start: w.start - start }));
    const cropKeyframes = candidate.fit
      ? [{ time: 0, position: 0.5, preserveWholeFrame: true }, { time: duration, position: 0.5, preserveWholeFrame: true }]
      : await Framing.analyze(source, start, duration, 1.08, configuration, captions, token);
    reportStep('Prism AI · framing the subject');
    return {
      start, duration, captions, cropKeyframes, speechWords: words,
      warning: shot.referenceCues.length === 0 || shot.words.length > 0 ? null : S.SENTENCE_TIMING_NOTICE,
      title: candidate.title ? truncate(candidate.title, 100) : captions[0] ? truncate(captions[0].text, 100) : null,
      reason: candidate.reason ? truncate(candidate.reason, 400) : null, fit: candidate.fit, videoType,
      score: Math.round(candidate.score * 10), description: candidate.description ? truncate(candidate.description, 1000) : null,
    };
  }, signal);
  // Keep existing edits intact and ask for another range instead of silently inventing a selection.
  if (results.length === 0) throw new GeminiError(excluding.length > 0 ? 'noDistinctClips' : 'noStrongClips');
  signal?.throwIfAborted();
  progress(1, 'Shorts ready');
  return results.sort((a, b) => a.start - b.start);
}

/** Turns a rough clip into exact boundaries: whole sentences, no filler at the edges, breathing room, no cut word, a strong first
 * word, and both ends moved into the nearest pause in the audio. */
export async function prepareShort(source, start, duration, transcript, interval, clipDuration, aligning, configuration, signal) {
  const range = S.lengthRange(clipDuration);
  const phraseCut = T.phraseRange(start, duration, transcript, interval);
  const sentences = T.completeSentences(phraseCut.start, phraseCut.duration, transcript, interval, range.min, range.max);
  const snapped = T.trimmedFiller(sentences.start, sentences.duration, transcript, range.min);
  const phrase = T.paddedPhraseRange(snapped.start, snapped.duration, transcript, interval);
  const referenceCues = transcript.filter((c) => {
    const middle = c.start + c.duration / 2;
    return middle >= snapped.start && middle <= snapped.start + snapped.duration;
  });
  let clipWords = [], alignmentFailed = false;
  if (referenceCues.length > 0 && aligning) {
    try {
      const proposed = await S.transcribe(source, { start: Math.max(interval.start, phrase.start - 0.5), end: Math.min(interval.end, phrase.start + phrase.duration + 0.5) },
        configuration, { reference: referenceCues, signal });
      const inside = proposed.filter((w) => w.start >= phrase.start - 0.01 && w.start + w.duration <= phrase.start + phrase.duration + 0.01);
      if (T.alignmentIsReliable(inside, referenceCues)) clipWords = inside;
    } catch {
      signal?.throwIfAborted();
      alignmentFailed = true;
    }
  }
  const whole = speechSafeRange(phrase.start, phrase.duration, clipWords, interval);
  const safe = strongOpening(whole.start, whole.duration, clipWords, range.min);
  const quiet = await silenceSnapped(source, safe.start, safe.duration, interval, clipWords);
  return { start: quiet.start, duration: quiet.duration, words: clipWords, referenceCues, alignmentFailed };
}

/** Moves a Short's start and end into the nearest pause in its audio, so it never opens or closes on a clipped sound. */
export async function silenceSnapped(source, start, duration, interval, words = []) {
  const end = start + duration;
  const from = Math.max(interval.start, start - 0.6), to = Math.min(interval.end, end + 0.6);
  const levels = to > from ? await audioLevels(source, from, to) : null;
  return snapToQuiet(levels, from, start, duration, interval, words);
}

export function snapToQuiet(levels, from, start, duration, interval, words = []) {
  if (!levels || levels.length <= 20) return { start, duration };
  const end = start + duration;
  const frame = 0.01;
  // 50 ms smoothing ignores the tiny gaps inside a word.
  const smooth = Array.from(levels, (_, index) => {
    const low = Math.max(0, index - 2), high = Math.min(levels.length - 1, index + 2);
    let sum = 0;
    for (let i = low; i <= high; i++) sum += levels[i];
    return sum / (high - low + 1);
  });
  const median = [...smooth].sort((a, b) => a - b)[Math.floor(smooth.length / 2)];
  const threshold = Math.max(0.003, median * 0.2);
  const time = (index) => from + (index + 0.5) * frame;
  const insideWord = (t) => words.some((w) => w.start + 0.02 < t && w.start + w.duration - 0.02 > t);
  const nearestQuiet = (target, low, high) => {
    let best = null;
    for (let i = 0; i < smooth.length; i++) {
      const t = time(i);
      if (t >= low && t <= high && smooth[i] <= threshold && !insideWord(t) && (best === null || Math.abs(t - target) < Math.abs(best - target))) best = t;
    }
    return best;
  };
  const newStart = nearestQuiet(start, Math.max(interval.start, start - 0.5), start + 0.15) ?? start;
  const newEnd = nearestQuiet(end, end - 0.15, Math.min(interval.end, end + 0.5)) ?? end;
  return newEnd - newStart > 0.5 ? { start: newStart, duration: newEnd - newStart } : { start, duration };
}

/** The Shorts as listed: in the order of the video, or best score first (ties keep their order in the video). */
export function orderedShorts(segments, byScore) {
  const inVideo = [...segments].sort((a, b) => a.start - b.start);
  return byScore ? inVideo.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : inVideo;
}

/** Shift captions into the clip's timeline without extending them beyond its end. */
export function clipCaptions(cues, start, duration) {
  return cues.map((c) => ({ text: c.text, from: Math.max(0, c.start - start), to: Math.min(duration, c.start + c.duration - start) }))
    .filter((c) => c.to > c.from).map((c) => ({ text: c.text, start: c.from, duration: c.to - c.from }));
}

/** Drops unmistakable hesitation ("um", "uh") from a Short's first line, so it opens on its hook. */
// shortcut: English filler words only; add per-language lists if non-English sources matter.
export function strongOpening(start, duration, words, minDuration) {
  const hesitation = new Set(['um', 'uh', 'erm']);
  const end = start + duration;
  const spoken = words.filter((w) => w.start >= start - 0.05 && w.start < end).sort((a, b) => a.start - b.start);
  const bare = (word) => [...word.text.toLowerCase()].filter((c) => /\p{L}/u.test(c)).join('');
  let dropped = 0;
  if (spoken.length > 1 && bare(spoken[0]) === 'so' && hesitation.has(bare(spoken[1]))) dropped = 1;
  while (dropped < Math.min(3, spoken.length - 1) && hesitation.has(bare(spoken[dropped]))) dropped++;
  if (dropped === 0) return { start, duration };
  const newStart = Math.max(start, spoken[dropped].start - 0.08);
  return end - newStart >= minDuration ? { start: newStart, duration: end - newStart } : { start, duration };
}

export function speechSafeRange(start, duration, words, interval) {
  if (words.length === 0) return { start, duration };
  let safeStart = start;
  const cutStart = words.find((w) => w.start + 0.02 < safeStart && w.start + w.duration - 0.02 > safeStart);
  if (cutStart) safeStart = cutStart.start >= interval.start ? Math.max(interval.start, cutStart.start - 0.025) : Math.min(interval.end, cutStart.start + cutStart.duration + 0.025);
  let safeEnd = Math.min(interval.end, start + duration);
  const cutEnd = words.find((w) => w.start + 0.02 < safeEnd && w.start + w.duration - 0.02 > safeEnd);
  if (cutEnd) {
    const wordEnd = cutEnd.start + cutEnd.duration;
    safeEnd = wordEnd <= interval.end ? Math.min(interval.end, wordEnd + 0.04) : Math.max(safeStart + 0.1, cutEnd.start);
  }
  return safeEnd > safeStart ? { start: safeStart, duration: safeEnd - safeStart } : { start, duration };
}
