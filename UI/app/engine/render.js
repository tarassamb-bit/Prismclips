// Renders a Short to an MP4 in the browser: layout (crop, Fit or split screen), camera path and captions, one frame at a time.
// A port of the layout and encode steps of Shared/Prism.Core/Renderer.cs. Previews use the same code at a smaller size.
import { ShortMakerError } from './gemini.js';
import { letterbox, mediabunny } from './media.js';
import { eased } from './framing.js';
import { elements, drawCaptions } from './captions.js';
import { EXPORT_QUALITIES } from './models.js';

const FPS = 30;

// The watermark on every exported Short: the logo badge is always there; each round the name types out of it, stays, folds
// back, and the badge glides to the next corner, so it can't simply be cropped away. Units are 1080×1920.
// Each spot is the badge's top left and the side the name opens to (1 right, -1 left), clear of the captions in the middle.
// Inside the safe zone of YouTube Shorts, TikTok and Reels: below their top tabs (~250), left of their side buttons (~160 from
// the right), above their name and description (~480 from the bottom), and between the caption and title positions.
const MARK_SPOTS = [[72, 480, 1], [788, 480, -1], [788, 1090, -1], [72, 1090, 1]];
const MARK_SIZE = 112, MARK_TEXT = 'Relio Clips';
const MARK_OPEN = 1.5, MARK_HOLD = 2.5, MARK_CLOSE = 0.8, MARK_GLIDE = 0.9;
let markLogo = null, markFont = null;

/** At `time` seconds: the badge's top left, which side it opens to, and how far the name is typed out (0 to 1). */
export function watermarkAt(time) {
  const cycle = MARK_OPEN + MARK_HOLD + MARK_CLOSE + MARK_GLIDE;
  const index = Math.floor(time / cycle) % MARK_SPOTS.length;
  const [ax, ay, side] = MARK_SPOTS[index], [bx, by] = MARK_SPOTS[(index + 1) % MARK_SPOTS.length];
  const t = time % cycle;
  const open = t < MARK_OPEN ? t / MARK_OPEN : t < MARK_OPEN + MARK_HOLD ? 1 : Math.max(0, 1 - (t - MARK_OPEN - MARK_HOLD) / MARK_CLOSE);
  const g = Math.max(0, t - MARK_OPEN - MARK_HOLD - MARK_CLOSE) / MARK_GLIDE;
  const k = g * g * (3 - 2 * g);
  return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k, side, open };
}

export async function loadWatermark() {
  markLogo ??= await fetch(new URL('../../icon-192.png', import.meta.url)).then((r) => r.blob()).then(createImageBitmap);
  markFont ??= new FontFace('Relio Mark', `url(${new URL('../../fonts/SpaceGrotesk-Medium.woff2', import.meta.url)})`, { weight: '500' }).load()
    .then((face) => (globalThis.document?.fonts ?? globalThis.fonts)?.add(face));
  await markFont;
}

/** The brand badge: dark, with a sky-to-sun-to-coral border and the logo; the name types out beside it. */
export function drawWatermark(ctx, time) {
  const { x, y, side, open } = watermarkAt(time);
  ctx.save();
  ctx.font = '500 58px "Relio Mark", sans-serif';
  ctx.letterSpacing = '-2.3px';
  ctx.textBaseline = 'middle';
  // Typed and deleted one letter at a time; the pill is exactly as wide as what's typed so far.
  const shown = MARK_TEXT.slice(0, Math.floor(MARK_TEXT.length * open + 0.001));
  const typing = open > 0;
  const width = MARK_SIZE + (typing ? ctx.measureText(shown).width + 44 : 0);
  const left = side > 0 ? x : x + MARK_SIZE - width;
  const border = ctx.createLinearGradient(left, 0, left + width, 0);
  border.addColorStop(0, '#3fa9f5'); border.addColorStop(0.5, '#ffd36b'); border.addColorStop(1, '#ff8a79');
  ctx.fillStyle = 'rgba(14,16,22,.85)';
  ctx.beginPath();
  ctx.roundRect(left, y, width, MARK_SIZE, MARK_SIZE / 2);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = border;
  ctx.stroke();
  const logoX = side > 0 ? left : left + width - MARK_SIZE;
  if (markLogo) ctx.drawImage(markLogo, logoX + 16, y + 16, 80, 80);
  if (typing) {
    let pen = side > 0 ? left + MARK_SIZE - 6 : left + 26;
    for (const char of shown) {
      ctx.fillStyle = '#fff';
      ctx.fillText(char, pen, y + 58);
      pen += ctx.measureText(char).width;
    }
    // Blinking cursor while the name is out.
    if (Math.floor(time * 2.5) % 2 === 0 || open < 1) {
      ctx.fillStyle = '#3fa9f5';
      ctx.fillRect(pen + 4, y + 30, 5, 54);
    }
  }
  ctx.restore();
}

/** Keep only PCM frames inside the edit, then express their timestamp relative to its start. */
export function trimAudioSample(sample, start, duration) {
  const first = Math.max(0, Math.ceil((start - sample.timestamp) * sample.sampleRate - 1e-7));
  const end = Math.min(sample.numberOfFrames, Math.floor((start + duration - sample.timestamp) * sample.sampleRate + 1e-7));
  if (end <= first) return null;
  const trimmed = sample.trim(first, end);
  trimmed.setTimestamp(Math.max(0, trimmed.timestamp - start));
  return trimmed;
}

/** The camera's left edge in source pixels for one time: the eased path, offset by the framing bias, holding until each scene cut. */
export function cropPositionAt(path, time, bias) {
  const points = path.map((p) => ({ ...p, position: Math.min(1, Math.max(0, p.position + bias)) }));
  if (points.length === 1) return points[0].position;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (time > b.time) continue;
    if (b.isSceneCut || b.time <= a.time) return a.position;
    const s = Math.min(1, Math.max(0, (time - a.time) / (b.time - a.time)));
    return a.position + (b.position - a.position) * s;
  }
  return points.at(-1).position;
}

/** Where a source frame goes on the 1080×1920 canvas: a list of draw operations for one moment. */
/** The eased camera path is the same for every frame of a render, so it's worked out once per path. */
const easedPaths = new WeakMap();
function easedPath(original, usable) {
  let path = easedPaths.get(original);
  if (!path) easedPaths.set(original, path = eased(usable));
  return path;
}

export function layoutAt(segment, time, sourceWidth, sourceHeight, bars = { top: 0, bottom: 0 }) {
  // Crops use the picture between any burned-in black bars; Fit still shows the whole frame.
  const top = bars.top ?? 0;
  const ow = sourceWidth, oh = Math.max(1, sourceHeight - top - (bars.bottom ?? 0));
  const keyframes = (segment.cropKeyframes ?? []).filter((k) => Number.isFinite(k.time) && Number.isFinite(k.position));
  // A tracked path Gemini marked as screens or slides shows the whole frame, like Fit.
  const wholeFrame = keyframes.length > 0 && keyframes.every((k) => k.preserveWholeFrame === true);
  if (segment.splitScreen === true) {
    const half = ow / 2;
    const centers = segment.splitCenters?.length === 2 ? segment.splitCenters : null;
    const windowX = (center) => Math.min(ow - half, Math.max(0, center * ow - half / 2));
    return [
      { kind: 'crop', sx: centers ? windowX(centers[0]) : 0, sy: top, sw: half, sh: oh, dx: 0, dy: 0, dw: 1080, dh: 960 },
      { kind: 'crop', sx: centers ? windowX(centers[1]) : half, sy: top, sw: half, sh: oh, dx: 0, dy: 960, dw: 1080, dh: 960 },
    ];
  }
  if (segment.fitToFrame === true || wholeFrame) {
    const scale = Math.min(1080 / ow, 1920 / sourceHeight);
    const dw = ow * scale, dh = sourceHeight * scale;
    return [{ kind: 'fit', sx: 0, sy: 0, sw: ow, sh: sourceHeight, dx: (1080 - dw) / 2, dy: (1920 - dh) / 2, dw, dh }];
  }
  const scale = Math.max(1080 / ow, 1920 / oh) * Math.min(2, Math.max(1, segment.cropZoom ?? 1.08));
  const scaledWidth = ow * scale, scaledHeight = oh * scale;
  const pan = ow / oh < 1.2 ? 0 : Math.max(0, scaledWidth - 1080);
  const y = Math.max(0, (scaledHeight - 1920) / 2);
  let x;
  if (pan <= 2) x = Math.max(0, (scaledWidth - 1080) / 2);
  else if (keyframes.length === 0) x = pan * Math.min(1, Math.max(0, segment.cropPosition ?? 0.5));
  else x = pan * cropPositionAt(easedPath(segment.cropKeyframes, keyframes), time, (segment.cropPosition ?? 0.5) - 0.5);
  return [{ kind: 'crop', sx: x / scale, sy: top + y / scale, sw: 1080 / scale, sh: 1920 / scale, dx: 0, dy: 0, dw: 1080, dh: 1920 }];
}

/** The whole-frame layouts sit on a soft copy of the picture. It is drawn at 1/16 size, blurred there by hand (a canvas blur filter is slow
 * and Safari ignores it), then scaled up: heavy blur at that size is cheap, and the scale-up shows no blocks because neighbours match. */
const SOFT_W = 68, SOFT_H = 120;
let softCanvas = null, softContext = null;

/** Box blur of the colour channels, `passes` times; edges repeat their nearest pixel. */
export function boxBlur(data, width, height, radius, passes) {
  const line = new Float32Array(Math.max(width, height));
  const run = (start, step, count) => {
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < count; i++) line[i] = data[start + i * step * 4 + c];
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += line[Math.min(count - 1, Math.max(0, k))];
      for (let i = 0; i < count; i++) {
        data[start + i * step * 4 + c] = sum / (2 * radius + 1);
        sum += line[Math.min(count - 1, i + radius + 1)] - line[Math.max(0, i - radius)];
      }
    }
  };
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) run(y * width * 4, 1, width);
    for (let x = 0; x < width; x++) run(x * 4, width, height);
  }
}

function drawSoftBackground(ctx, sample, sourceWidth, sourceHeight) {
  if (!softCanvas) {
    softCanvas = new OffscreenCanvas(SOFT_W, SOFT_H);
    softContext = softCanvas.getContext('2d', { willReadFrequently: true });
  }
  const cover = Math.max(SOFT_W / sourceWidth, SOFT_H / sourceHeight), w = sourceWidth * cover, h = sourceHeight * cover;
  sample.draw(softContext, (SOFT_W - w) / 2, (SOFT_H - h) / 2, w, h);
  const pixels = softContext.getImageData(0, 0, SOFT_W, SOFT_H);
  boxBlur(pixels.data, SOFT_W, SOFT_H, 4, 3);
  softContext.putImageData(pixels, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(softCanvas, 0, 0, 1080, 1920);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, 1080, 1920);
  ctx.restore();
}

/** Draws one frame into the 1080×1920 context (already scaled to the output size). `sample` has draw(ctx, x, y, w, h): a decoded
 * frame when exporting, a video element in the live player. */
export function drawFrame(ctx, sample, segment, sourceWidth, sourceHeight, time, bars) {
  // A vertical crop enlarges the picture about 2×; the default "low" smoothing makes that visibly soft.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1080, 1920);
  for (const op of layoutAt(segment, time, sourceWidth, sourceHeight, bars)) {
    if (op.kind === 'fit' && (op.dw < 1080 || op.dh < 1920)) {
      drawSoftBackground(ctx, sample, sourceWidth, sourceHeight);
    }
    if (op.kind === 'crop') {
      // Cover: the source window fills the destination, centred on its middle.
      const s = Math.max(op.dw / op.sw, op.dh / op.sh);
      ctx.save();
      ctx.beginPath();
      ctx.rect(op.dx, op.dy, op.dw, op.dh);
      ctx.clip();
      sample.draw(ctx, op.dx - op.sx * s - (op.sw * s - op.dw) / 2, op.dy - op.sy * s - (op.sh * s - op.dh) / 2, sourceWidth * s, sourceHeight * s);
      ctx.restore();
    } else {
      sample.draw(ctx, op.dx, op.dy, op.dw, op.dh);
    }
  }
}

/**
 * Renders the Short to a Blob. `options`: { width, height, quality, codec, bitrate, metadata, progress, signal }.
 * The video's audio is kept unless the Short is muted.
 */
export async function render(source, segment, options) {
  const { width = 1080, height = 1920, codec = 'avc', bitrate = 12e6, metadata = {}, progress = () => {}, step = () => {}, signal, watermark = true } = options;
  signal?.throwIfAborted();
  if (![segment.start, segment.duration].every(Number.isFinite) || segment.start < 0 || segment.duration <= 0 || segment.start + segment.duration > source.duration + 0.05) {
    throw new ShortMakerError('invalidRange');
  }
  const {
    Output, BufferTarget, Mp4OutputFormat, CanvasSource, AudioSampleSource, VideoSampleSink, AudioSampleSink, canEncodeVideo,
  } = await mediabunny();
  step('checking the video encoder');
  if (!(await canEncodeVideo(codec, { width, height, bitrate }).catch(() => false))) {
    throw new ShortMakerError('cannotExport', width > 1080 ? "This browser or computer can't encode 4K; choose 1080p · H.264." : codec === 'hevc' ? "This browser can't encode HEVC; choose 1080p · H.264." : 'This browser cannot encode H.264 video.');
  }
  const bars = await letterbox(source, segment.start, segment.duration);
  await loadWatermark();
  signal?.throwIfAborted();
  // Layout and captions are drawn in 1080×1920 units and scaled onto the output canvas.
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const layers = elements(segment);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  if (metadata.title || metadata.description) output.setMetadataTags({ title: metadata.title || undefined, description: metadata.description || undefined });
  // Safari's encoder in the default "quality" mode takes a few frames and then never answers; "realtime" encodes every frame.
  // Other browsers keep "quality": realtime gives up picture quality for speed.
  const safari = /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);
  const videoSource = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2, ...(safari ? { latencyMode: 'realtime' } : {}) });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  const keepAudio = segment.isMuted !== true && source.audio;
  const audioSource = keepAudio ? new AudioSampleSource({ codec: 'aac', bitrate: 160_000 }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  const count = Math.max(1, Math.round(segment.duration * FPS));
  const start = segment.start;
  const cancelled = () => signal?.throwIfAborted();
  const emit = async (sample, index) => {
    cancelled();
    const time = index / FPS;
    ctx.setTransform(width / 1080, 0, 0, height / 1920, 0, 0);
    drawFrame(ctx, sample, segment, source.width, source.height, time, bars);
    drawCaptions(ctx, layers, time);
    if (watermark) drawWatermark(ctx, time);
    await videoSource.add(time, 1 / FPS);
    cancelled();
    progress(Math.min(1, (index + 1) / count));
    cancelled();
  };
  const videoSink = new VideoSampleSink(source.video);
  let next = 0, previous = null;
  try {
    step('starting the encoder');
    cancelled();
    await output.start();
    step('reading the first frame');
    cancelled();
    // Output frame k shows the latest decoded frame at or before its time.
    for await (const sample of videoSink.samples(start, start + segment.duration)) {
      try {
        cancelled();
        const at = sample.timestamp - start;
        while (next < count && next / FPS < at) {
          await emit(previous ?? sample, next);
          next++;
        }
      } catch (error) {
        sample.close();
        throw error;
      }
      previous?.close();
      previous = sample;
    }
    while (next < count && previous) { await emit(previous, next); next++; }
    previous?.close(); previous = null;
    if (next === 0) throw new ShortMakerError('noVideo');
    if (audioSource) {
      step('adding the sound');
      const audioSink = new AudioSampleSink(source.audio);
      for await (const sample of audioSink.samples(start, start + segment.duration)) {
        let copy;
        try {
          cancelled();
          copy = trimAudioSample(sample, start, segment.duration);
          if (copy) await audioSource.add(copy);
          cancelled();
        } finally {
          copy?.close();
          sample.close();
        }
      }
    }
    videoSource.close();
    audioSource?.close();
    step('finishing the file');
    cancelled();
    await output.finalize();
    cancelled();
  } catch (error) {
    await output.cancel().catch(() => {});
    if (error instanceof ShortMakerError) throw error;
    if (signal?.aborted) throw error;
    throw new ShortMakerError('cannotExport', error?.message);
  } finally {
    previous?.close();
  }
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

/** The export settings for a chosen quality. */
export function exportSettings(quality) {
  const q = EXPORT_QUALITIES[quality] ?? EXPORT_QUALITIES.full;
  return { width: q.width, height: q.height, codec: q.codec, bitrate: q.bitrate };
}

/** A fast small render for the editor's player, cached by everything that changes the picture or sound. */
const previews = new Map();
export async function preview(source, segment, signal) {
  const key = JSON.stringify([source.file.name, source.file.size, source.file.lastModified, segment]);
  if (previews.has(key)) return previews.get(key);
  const blob = await render(source, segment, { width: 540, height: 960, codec: 'avc', bitrate: 2.5e6, signal });
  const url = URL.createObjectURL(blob);
  previews.set(key, url);
  while (previews.size > 24) {
    const oldest = previews.keys().next().value;
    URL.revokeObjectURL(previews.get(oldest));
    previews.delete(oldest);
  }
  return url;
}
