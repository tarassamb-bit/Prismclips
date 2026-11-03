// Reading the source video in the browser with WebCodecs (Mediabunny): probe, frames, gray grids for cut detection, audio
// for Prism AI and audio levels. The browser counterpart of Shared/Prism.Core/Media.cs; the video never leaves the computer.
import { Input, ALL_FORMATS, BlobSource, CanvasSink, AudioSampleSink } from '../../vendor/mediabunny-1.61.5.min.mjs';
import { ShortMakerError, GeminiError } from './gemini.js';

/** Decoding runs a couple at a time; the AI requests around it still run six side by side. */
let running = 0;
const waiting = [];
async function decoding(work) {
  if (running >= 2) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try { return await work(); } finally { running--; waiting.shift()?.(); }
}

/** Opens a File. `video` and `audio` are Mediabunny tracks; width and height are as displayed (rotation applied). */
export async function openSource(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !(await video.canDecode())) throw new ShortMakerError('noVideo');
    const audio = await input.getPrimaryAudioTrack();
    const hasAudio = Boolean(audio && (await audio.canDecode()));
    const duration = await input.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0) throw new ShortMakerError('noVideo');
    return { file, input, video, audio: hasAudio ? audio : null, duration, width: video.displayWidth, height: video.displayHeight, hasAudio };
  } catch (error) {
    if (error instanceof ShortMakerError) throw error;
    throw new ShortMakerError('noVideo');
  }
}

function fitWithin(source, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  return { width: Math.max(2, Math.round(source.width * scale / 2) * 2), height: Math.max(2, Math.round(source.height * scale / 2) * 2) };
}

export async function jpegBytes(canvas, quality = 0.8) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/** One frame as JPEG, or null when nothing decodes there. */
export async function frameJpeg(source, time, maxSize = 640) {
  return (await framesAt(source, [Math.max(0, time)], maxSize))[0]?.jpeg ?? null;
}

/** Frames every `step` seconds across a range. Times are from the range start. */
export async function framesJpeg(source, start, duration, step, maxSize = 512) {
  const times = [];
  for (let t = 0; t < duration; t += step) times.push(Math.min(duration - 0.001, t));
  const frames = await framesAt(source, times.map((t) => start + t), maxSize);
  return frames.map((frame, index) => frame && { time: times[index], jpeg: frame.jpeg }).filter(Boolean);
}

async function framesAt(source, timestamps, maxSize) {
  return decoding(async () => {
    const sink = new CanvasSink(source.video, { ...fitWithin(source, maxSize), fit: 'fill' });
    const result = [];
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) result.push(wrapped ? { jpeg: await jpegBytes(wrapped.canvas) } : null);
    return result;
  });
}

/** A small preview image of the video, as a data URL for project cards. */
/** One decoded frame as a canvas (not encoded to JPEG), for drawing into thumbnails. */
export async function frameImage(source, time, maxSize = 480) {
  return decoding(async () => {
    const sink = new CanvasSink(source.video, { ...fitWithin(source, maxSize), fit: 'fill' });
    // A file's first frame can come after time 0, and asking for a time before it gives nothing; start at the first frame at the earliest.
    const first = await source.video.getFirstTimestamp().catch(() => 0);
    return (await sink.getCanvas(Math.max(time, first)))?.canvas ?? null;
  });
}

export async function thumbnail(source, time, maxSize = 480) {
  const jpeg = await frameJpeg(source, time, maxSize);
  if (!jpeg) return null;
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(new Blob([jpeg], { type: 'image/jpeg' }));
  });
}

/** 32×18 luminance grids at 10 fps across a range, for scene-cut detection. */
export async function grayGrids(source, start, duration) {
  return decoding(async () => {
    const sink = new CanvasSink(source.video, { width: 32, height: 18, fit: 'fill' });
    const times = [];
    for (let i = 0; i < Math.floor(duration * 10); i++) times.push(start + i / 10);
    const grids = [];
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (!wrapped) { grids.push(grids.at(-1) ?? new Uint8Array(576)); continue; }
      const pixels = wrapped.canvas.getContext('2d').getImageData(0, 0, 32, 18).data;
      const grid = new Uint8Array(576);
      for (let i = 0; i < 576; i++) grid[i] = Math.round(0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]);
      grids.push(grid);
    }
    return grids;
  });
}

const SPEECH_RATE = 16000;

/** A stretch of audio for Prism AI as 16 kHz mono 16-bit WAV: { mime, bytes }. Plain PCM needs no encoder, so it is identical in every
 * browser and every AI provider can read it. Throws audioExport when it can't be prepared. */
export async function audioChunk(source, start, length, signal) {
  if (!source.audio) throw new GeminiError('audioExport');
  signal?.throwIfAborted();
  const decoded = await monoSamples(source, start, Math.min(source.duration, start + length)).catch(() => null);
  signal?.throwIfAborted();
  if (!decoded) throw new GeminiError('audioExport');
  return { mime: 'audio/wav', bytes: wav(resample(decoded.samples, decoded.sampleRate, SPEECH_RATE), SPEECH_RATE) };
}

/** Averages each stretch of input into one output sample, which also filters what the lower rate can't hold. */
export function resample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to, count = Math.floor(samples.length / ratio), out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += samples[j];
    out[i] = sum / (b - a);
  }
  return out;
}

/** A mono 16-bit PCM WAV file. */
export function wav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return bytes;
}

/** Mono samples of a range at the track's own rate: { samples, sampleRate }, or null without audio. */
export async function monoSamples(source, from, to) {
  if (!source.audio || to <= from) return null;
  return decoding(async () => {
    const sink = new AudioSampleSink(source.audio);
    let mono = null, rate = 0;
    for await (const sample of sink.samples(from, to)) {
      if (!mono) { rate = sample.sampleRate; mono = new Float32Array(Math.ceil((to - from) * rate)); }
      const channel = new Float32Array(sample.numberOfFrames);
      const offset = Math.round((sample.timestamp - from) * rate);
      for (let c = 0; c < sample.numberOfChannels; c++) {
        sample.copyTo(channel, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < channel.length; i++) {
          const at = offset + i;
          if (at >= 0 && at < mono.length) mono[at] += channel[i] / sample.numberOfChannels;
        }
      }
      sample.close();
    }
    return mono ? { samples: mono, sampleRate: rate } : null;
  });
}

/** Loudness (RMS) of the audio in 10 ms frames; null when the file has no readable audio. */
export async function audioLevels(source, from, to) {
  const audio = await monoSamples(source, from, to).catch(() => null);
  if (!audio) return null;
  const frame = Math.max(1, Math.round(audio.sampleRate / 100));
  const levels = new Float32Array(Math.ceil(audio.samples.length / frame));
  for (let index = 0; index < levels.length; index++) {
    let sum = 0;
    const first = index * frame, count = Math.min(frame, audio.samples.length - first);
    for (let i = 0; i < count; i++) sum += audio.samples[first + i] ** 2;
    levels[index] = Math.sqrt(sum / Math.max(1, count));
  }
  return levels;
}
