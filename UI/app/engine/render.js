// Renders a Short to an MP4 in the browser: layout (crop, Fit or split screen), camera path and captions, one frame at a time.
// A port of the layout and encode steps of Shared/Prism.Core/Renderer.cs. Previews use the same code at a smaller size.
import {
  Output, BufferTarget, Mp4OutputFormat, CanvasSource, AudioSampleSource, VideoSampleSink, AudioSampleSink, canEncodeVideo,
} from '../../vendor/mediabunny-1.61.5.min.mjs';
import { ShortMakerError } from './gemini.js';
import { eased } from './framing.js';
import { elements, drawCaptions } from './captions.js';
import { EXPORT_QUALITIES } from './models.js';

const FPS = 30;

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

export function layoutAt(segment, time, sourceWidth, sourceHeight) {
  const ow = sourceWidth, oh = sourceHeight;
  const keyframes = (segment.cropKeyframes ?? []).filter((k) => Number.isFinite(k.time) && Number.isFinite(k.position));
  // A tracked path Gemini marked as screens or slides shows the whole frame, like Fit.
  const wholeFrame = keyframes.length > 0 && keyframes.every((k) => k.preserveWholeFrame === true);
  if (segment.splitScreen === true) {
    const half = ow / 2;
    const centers = segment.splitCenters?.length === 2 ? segment.splitCenters : null;
    const windowX = (center) => Math.min(ow - half, Math.max(0, center * ow - half / 2));
    return [
      { kind: 'crop', sx: centers ? windowX(centers[0]) : 0, sy: 0, sw: half, sh: oh, dx: 0, dy: 0, dw: 1080, dh: 960 },
      { kind: 'crop', sx: centers ? windowX(centers[1]) : half, sy: 0, sw: half, sh: oh, dx: 0, dy: 960, dw: 1080, dh: 960 },
    ];
  }
  if (segment.fitToFrame === true || wholeFrame) {
    const scale = Math.min(1080 / ow, 1920 / oh);
    const dw = ow * scale, dh = oh * scale;
    return [{ kind: 'fit', sx: 0, sy: 0, sw: ow, sh: oh, dx: (1080 - dw) / 2, dy: (1920 - dh) / 2, dw, dh }];
  }
  const scale = Math.max(1080 / ow, 1920 / oh) * Math.min(2, Math.max(1, segment.cropZoom ?? 1.08));
  const scaledWidth = ow * scale, scaledHeight = oh * scale;
  const pan = ow / oh < 1.2 ? 0 : Math.max(0, scaledWidth - 1080);
  const y = Math.max(0, (scaledHeight - 1920) / 2);
  let x;
  if (pan <= 2) x = Math.max(0, (scaledWidth - 1080) / 2);
  else if (keyframes.length === 0) x = pan * Math.min(1, Math.max(0, segment.cropPosition ?? 0.5));
  else x = pan * cropPositionAt(easedPath(segment.cropKeyframes, keyframes), time, (segment.cropPosition ?? 0.5) - 0.5);
  return [{ kind: 'crop', sx: x / scale, sy: y / scale, sw: 1080 / scale, sh: 1920 / scale, dx: 0, dy: 0, dw: 1080, dh: 1920 }];
}

/** Draws one source frame into the 1080×1920 context (already scaled to the output size). */
function drawFrame(ctx, sample, segment, sourceWidth, sourceHeight, time) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1080, 1920);
  for (const op of layoutAt(segment, time, sourceWidth, sourceHeight)) {
    if (op.kind === 'fit' && (op.dw < 1080 || op.dh < 1920)) {
      // The whole source over a blurred, zoomed copy of itself.
      ctx.save();
      ctx.filter = 'blur(40px) saturate(0.7) brightness(0.92)';
      const cover = Math.max(1080 / sourceWidth, 1920 / sourceHeight);
      const bw = sourceWidth * cover, bh = sourceHeight * cover;
      sample.draw(ctx, (1080 - bw) / 2, (1920 - bh) / 2, bw, bh);
      ctx.restore();
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
  const { width = 1080, height = 1920, codec = 'avc', bitrate = 12e6, metadata = {}, progress = () => {}, signal } = options;
  if (![segment.start, segment.duration].every(Number.isFinite) || segment.start < 0 || segment.duration <= 0 || segment.start + segment.duration > source.duration + 0.05) {
    throw new ShortMakerError('invalidRange');
  }
  if (!(await canEncodeVideo(codec, { width, height, bitrate }).catch(() => false))) {
    throw new ShortMakerError('cannotExport', codec === 'hevc' ? "This browser can't encode HEVC; choose 1080p · H.264." : 'This browser cannot encode H.264 video.');
  }
  // Layout and captions are drawn in 1080×1920 units and scaled onto the output canvas.
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const layers = elements(segment);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  if (metadata.title || metadata.description) output.setMetadataTags({ title: metadata.title || undefined, description: metadata.description || undefined });
  const videoSource = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  const keepAudio = segment.isMuted !== true && source.audio;
  const audioSource = keepAudio ? new AudioSampleSource({ codec: 'aac', bitrate: 160_000 }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();
  const count = Math.max(1, Math.round(segment.duration * FPS));
  const start = segment.start;
  const cancelled = () => signal?.throwIfAborted();
  const emit = async (sample, index) => {
    const time = index / FPS;
    ctx.setTransform(width / 1080, 0, 0, height / 1920, 0, 0);
    drawFrame(ctx, sample, segment, source.width, source.height, time);
    drawCaptions(ctx, layers, time);
    await videoSource.add(time, 1 / FPS);
    progress(Math.min(1, (index + 1) / count));
  };
  const videoSink = new VideoSampleSink(source.video);
  let next = 0, previous = null;
  try {
    // Output frame k shows the latest decoded frame at or before its time.
    for await (const sample of videoSink.samples(start, start + segment.duration)) {
      cancelled();
      const at = sample.timestamp - start;
      while (next < count && next / FPS < at) {
        await emit(previous ?? sample, next);
        next++;
      }
      previous?.close();
      previous = sample;
    }
    while (next < count && previous) { await emit(previous, next); next++; }
    previous?.close();
    if (next === 0) throw new ShortMakerError('noVideo');
    if (audioSource) {
      const audioSink = new AudioSampleSink(source.audio);
      for await (const sample of audioSink.samples(start, start + segment.duration)) {
        cancelled();
        // Stop at the Short's end; a sample that starts just before its start is moved to 0.
        if (sample.timestamp - start >= segment.duration) { sample.close(); break; }
        const copy = sample.clone();
        copy.setTimestamp(Math.max(0, sample.timestamp - start));
        await audioSource.add(copy);
        copy.close();
        sample.close();
      }
    }
    videoSource.close();
    audioSource?.close();
    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => {});
    if (error instanceof ShortMakerError) throw error;
    if (signal?.aborted) throw error;
    throw new ShortMakerError('cannotExport', error?.message);
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
