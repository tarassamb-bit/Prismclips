// Subtitles and the text overlay, drawn on a canvas the way the desktop apps draw them, in 1080×1920 video pixels.
// A port of Shared/Prism.Core/Captions.cs. The same drawing serves the live preview and the export, so they match.
import { resolvedStyle, highlightsWords, POSITION_CENTER, SIZE_SCALE } from './models.js';
import { tokens } from './transcript.js';

const FONT = '"Relio Captions", Sora, system-ui, sans-serif';
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const layerHeight = (style, scale) => Math.round((style === 'boldCaps' ? 300 : 210) * scale);
const sameTokens = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
// A caption shown exactly as its word starts reads as late; subtitles conventionally lead the speech a little.
export const CAPTION_LEAD = 0.15;
const HIGHLIGHT = '#FFE135';

/** Every caption layer of a Short with its timing: subtitles per the Short's style, then the text overlay. */
export function elements(segment) {
  const result = [];
  const captions = segment.captionsHidden === true ? [] : segment.captions ?? [];
  if (captions.length === 0 && !segment.caption) return result;
  const total = segment.duration;
  const position = segment.captionPosition ?? 'bottom';
  const center = POSITION_CENTER[position];
  const scale = SIZE_SCALE[segment.captionSize ?? 'medium'];
  const pops = segment.captionAnimated === true;
  // The on-screen text overlay moves out of the subtitles' way.
  const overlayCenter = captions.length === 0 ? 330 : position === 'top' ? 470 : 1560;
  const style = resolvedStyle(segment.captionStyle ?? 'classic', segment.videoType, segment.splitScreen === true);
  const add = (text, start, duration, centerY, layerStyle, layerScale, highlighted, pop) => {
    if (![start, duration, total].every(Number.isFinite) || total <= 0 || start >= total || duration <= 0) return;
    const from = clamp(start, 0, total), to = Math.min(total, start + duration);
    if (to <= from) return;
    const height = layerHeight(layerStyle, layerScale);
    result.push({ text, start: from, duration: to - from, y: clamp(centerY - height / 2, 0, 1920 - height), style: layerStyle, scale: layerScale, highlighted, pops: pop });
  };
  for (const page of pages(captions, segment.speechWords ?? [], style)) {
    if (!highlightsWords(style) || page.words.length < 2) { add(page.text, page.start - CAPTION_LEAD, page.end - page.start, center, style, scale, null, pops); continue; }
    page.words.forEach((word, index) => {
      const from = (index === 0 ? page.start : word.start) - CAPTION_LEAD;
      const to = index + 1 < page.words.length ? page.words[index + 1].start : page.end;
      // Only a new page pops; the moving highlight inside it must not bounce on every word.
      add(page.text, from, Math.max(0.01, to - from), center, style, scale, index, pops && index === 0);
    });
  }
  if (segment.caption) {
    add(segment.caption, segment.captionStart ?? 0, segment.captionDuration ?? segment.duration, overlayCenter, 'classic', 1, null, false);
    if (result.at(-1)?.text === segment.caption) result.at(-1).overlay = true;
  }
  return result;
}

/** Splits captions into short pages: a few words at a time, breaking at sentence ends, commas and pauses. */
export function pages(cues, words, style) {
  const [maxWords, maxCharacters] = { oneWord: [1, 16], boldCaps: [2, 16], viral: [3, 20], highlightBox: [3, 20], podcast: [4, 26], minimal: [7, 40] }[style] ?? [5, 26];
  const result = [];
  for (const cue of cues) {
    const exact = words.filter((w) => w.start >= cue.start - 0.02 && w.start + w.duration <= cue.start + cue.duration + 0.02).sort((a, b) => a.start - b.start);
    const cueWords = exact.length > 0 && sameTokens(exact.flatMap((w) => tokens(w.text)), tokens(cue.text)) ? exact : spokenWords(cue, words);
    let group = [];
    const flush = () => {
      if (group.length === 0) return;
      const last = group.at(-1);
      result.push({ words: group, start: group[0].start, end: last.start + last.duration, text: pageText(group.map((w) => w.text), style) });
      group = [];
    };
    for (const word of cueWords) {
      if (group.length > 0) {
        const characters = [...group.map((w) => w.text), word.text].join(' ').length;
        const last = group.at(-1);
        if (group.length >= maxWords || characters > maxCharacters || word.start - (last.start + last.duration) > 0.45) flush();
      }
      group.push(word);
      const mark = word.text.at(-1) ?? '';
      if ('.!?'.includes(mark) && mark || (',;:'.includes(mark) && mark && group.length >= 2)) flush();
    }
    flush();
  }
  // In time order, so each page closes when the next opens and two lines never show at once.
  result.sort((a, b) => a.start - b.start);
  // Each page stays up until the next one starts, so there is never a gap between captions; the last one lingers briefly.
  result.forEach((page, index) => {
    page.end = index + 1 < result.length ? Math.max(page.start + 0.05, result[index + 1].start) : page.end + 0.35;
  });
  return result;
}

/** A line whose text no longer matches the word timings (edited, or numbers written differently): its words follow the
 *  speech heard in its time, one for one when the counts match, else spread over just the spoken part, not its silences. */
function spokenWords(cue, words) {
  const heard = words.filter((w) => w.start < cue.start + cue.duration && w.start + w.duration > cue.start).sort((a, b) => a.start - b.start);
  if (heard.length === 0) return estimatedWords(cue);
  const texts = cue.text.split(/\s+/).filter(Boolean);
  if (texts.length === heard.length) return texts.map((text, i) => ({ text, start: heard[i].start, duration: heard[i].duration }));
  const start = Math.max(cue.start, heard[0].start), end = Math.min(cue.start + cue.duration, heard.at(-1).start + heard.at(-1).duration);
  return end > start ? estimatedWords({ text: cue.text, start, duration: end - start }) : estimatedWords(cue);
}

/** Word timings spread across a line by length, for lines without exact timings. */
export function estimatedWords(cue) {
  const texts = cue.text.split(/\s+/).filter(Boolean);
  const weights = texts.map((t) => t.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || cue.duration <= 0) return [];
  let start = cue.start;
  return texts.map((value, index) => {
    const duration = cue.duration * weights[index] / total;
    const word = { text: value, start, duration };
    start += duration;
    return word;
  });
}

/** Short punchy pages drop trailing commas and periods; questions and exclamations keep their mark. */
function pageText(words, style) {
  const value = words.join(' ');
  return style === 'classic' || style === 'minimal' ? value : value.replace(/^[.,;:]+|[.,;:]+$/g, '');
}

/** The pop-in scale at a moment: 0.8 → 1.08 → 1 over the first 0.2 s. */
export function popScale(element, time) {
  if (!element.pops) return 1;
  const t = (time - element.start) / Math.min(0.2, element.duration);
  if (t < 0 || t >= 1) return 1;
  return t < 0.6 ? 0.8 + 0.28 * t / 0.6 : 1.08 - 0.08 * (t - 0.6) / 0.4;
}

/** Draws the layers showing at `time` into a context already scaled to 1080×1920. */
export function drawCaptions(ctx, layers, time) {
  const showing = layers.filter((element) => element.start <= time && time < element.start + element.duration);
  // One subtitle at a time: when two pages overlap, the newer one wins, so lines never stack into a garbled word.
  const subtitle = showing.filter((element) => !element.overlay).sort((a, b) => b.start - a.start)[0];
  for (const element of showing) {
    if (!element.overlay && element !== subtitle) continue;
    const height = layerHeight(element.style, element.scale);
    const scale = popScale(element, time);
    ctx.save();
    ctx.translate(70, 1920 - (element.y + height));
    if (Math.abs(scale - 1) > 0.001) { ctx.translate(470, height / 2); ctx.scale(scale, scale); ctx.translate(-470, -height / 2); }
    ctx.drawImage(layerBitmap(element, height), 0, 0);
    ctx.restore();
  }
}

/** A layer looks the same every frame it shows (the pop-in is a transform), so its text and outline are drawn once and reused. */
const layerCache = new Map();
function layerBitmap(element, height) {
  const key = `${element.style}|${element.scale}|${element.highlighted}|${element.text}`;
  let canvas = layerCache.get(key);
  if (!canvas) {
    canvas = new OffscreenCanvas(940, height);
    drawLayer(canvas.getContext('2d'), element.text, element.style, element.scale, element.highlighted);
    layerCache.set(key, canvas);
    if (layerCache.size > 300) layerCache.delete(layerCache.keys().next().value);
  }
  return canvas;
}

/** A caption layer, 940 px wide, with its top-left at the context origin. */
export function drawLayer(ctx, value, style, k, highlighted) {
  style = resolvedStyle(style);
  const shown = style === 'boldCaps' ? value.toLocaleUpperCase() : value;
  const top = 15 * k, left = 24, width = 892;
  ctx.textBaseline = 'alphabetic';
  if (style === 'minimal') {
    // Calm text on a soft dark band sized to the words.
    ctx.font = `500 ${46 * k}px ${FONT}`;
    const lines = wrap(ctx, shown, width - 48 * k);
    const metrics = fontMetrics(ctx);
    const textWidth = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 2;
    const bandX = left + width / 2 - textWidth / 2 - 24 * k;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    roundRect(ctx, bandX, top, textWidth + 48 * k, metrics.lineHeight * lines.length + 20 * k, 18 * k);
    drawLines(ctx, lines, left + width / 2, top + 10 * k, metrics, () => '#fff');
    return;
  }
  if (style === 'podcast') {
    // White text with a soft shadow; the spoken word in green.
    ctx.font = `800 ${56 * k}px ${FONT}`;
    const lines = wrap(ctx, shown, width);
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 10 * k;
    ctx.shadowOffsetY = 2 * k;
    drawLines(ctx, lines, left + width / 2, top, fontMetrics(ctx), (index) => (index === highlighted ? 'rgb(56,227,125)' : '#fff'));
    ctx.shadowColor = 'transparent';
    return;
  }
  // Heavy white text with a black outline: the text repeated in black around the edge, so the counters of e and a stay open.
  const size = (style === 'oneWord' ? 104 : style === 'boldCaps' ? 76 : 66) * k;
  const radius = (style === 'oneWord' ? 5 : style === 'boldCaps' ? 4 : 3) * k;
  ctx.font = `800 ${size}px ${FONT}`;
  const lines = wrap(ctx, shown, width);
  const metrics = fontMetrics(ctx);
  // One soft shadow under the outline lifts the words off busy footage.
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 14 * k;
  ctx.shadowOffsetY = 5 * k;
  drawLines(ctx, lines, left + width / 2, top + radius, metrics, () => '#000');
  ctx.shadowColor = 'transparent';
  for (let step = 0; step < 16; step++) {
    const angle = step * Math.PI / 8;
    drawLines(ctx, lines, left + width / 2 + radius * Math.cos(angle), top + radius * Math.sin(angle), metrics, () => '#000');
  }
  const boxed = style === 'highlightBox' ? highlighted : null;
  drawLines(ctx, lines, left + width / 2, top, metrics,
    (index) => (index === highlighted ? (style === 'highlightBox' ? '#000' : HIGHLIGHT) : '#fff'), boxed, HIGHLIGHT);
}

function fontMetrics(ctx) {
  const m = ctx.measureText('Hg');
  const size = parseFloat(ctx.font.split(' ')[1]) || 16;
  const ascent = m.fontBoundingBoxAscent ?? size * 0.95;
  const descent = m.fontBoundingBoxDescent ?? size * 0.3;
  return { ascent, lineHeight: ascent + descent };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  ctx.fill();
}

/** Greedy word wrap, keeping each word's index in the whole caption for highlighting. */
function wrap(ctx, value, width) {
  const words = value.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = [];
  words.forEach((word, index) => {
    const candidate = [...current.map((w) => w.word), word].join(' ');
    if (current.length > 0 && ctx.measureText(candidate).width > width) {
      lines.push({ text: current.map((w) => w.word).join(' '), words: current });
      current = [];
    }
    current.push({ word, index });
  });
  if (current.length > 0) lines.push({ text: current.map((w) => w.word).join(' '), words: current });
  if (lines.length === 0) lines.push({ text: '', words: [] });
  return lines;
}

/** Centered lines, word by word, so one word can have its own color or a box behind it. */
function drawLines(ctx, lines, centerX, top, metrics, colorFor, boxedWord = null, boxColor = null) {
  const space = ctx.measureText(' ').width;
  let y = top;
  for (const line of lines) {
    let x = centerX - ctx.measureText(line.text).width / 2;
    for (const { word, index } of line.words) {
      const advance = ctx.measureText(word).width;
      if (boxedWord === index && boxColor) {
        const fill = ctx.fillStyle;
        ctx.fillStyle = boxColor;
        const pad = metrics.lineHeight * 0.12;
        roundRect(ctx, x - pad, y + pad * 0.5, advance + 2 * pad, metrics.lineHeight - pad, pad * 1.4);
        ctx.fillStyle = fill;
      }
      ctx.fillStyle = colorFor(index, word);
      ctx.fillText(word, x, y + metrics.ascent);
      x += advance + space;
    }
    y += metrics.lineHeight;
  }
}

/** A sample of a subtitle style on a canvas, drawn by the same code as exported captions so the picker matches the video. */
export function stylePreview(canvas, style) {
  const resolved = resolvedStyle(style);
  const sample = resolved === 'oneWord' ? 'Hello' : 'Hello everyone';
  const highlighted = ['viral', 'highlightBox', 'podcast'].includes(resolved) ? 0 : null;
  const height = layerHeight(resolved, 1);
  canvas.width = 940;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 940, height);
  drawLayer(ctx, sample, resolved, 1, highlighted);
}
