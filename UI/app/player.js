// Plays a Short live: the browser's video element supplies picture and sound from the source file, and a canvas shows the Short's
// layout and captions on top, drawn by the same code as export. No rendering wait, and edits show on the next frame.
import { drawFrame } from './engine/render.js';
import { elements, drawCaptions } from './engine/captions.js';
import { letterbox } from './engine/media.js';

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
let stop = null;

/** Mounts the player into `host`. `onFailure` is called when this browser can't play the source file. */
export function mountPlayer(host, segment, source, onFailure) {
  stop?.();
  host.innerHTML = `<div class="live">
      <canvas id="player" class="player" width="540" height="960" aria-label="Short preview"></canvas>
      <div class="transport">
        <button class="button ghost" data-play aria-label="Play">▶</button>
        <input type="range" min="0" max="${segment.duration}" step="0.01" value="0" aria-label="Position">
        <span class="mono small time">0:00 / ${clock(segment.duration)}</span>
      </div></div>`;
  const canvas = host.querySelector('canvas'), ctx = canvas.getContext('2d', { alpha: false });
  const [play, slider, time] = [host.querySelector('[data-play]'), host.querySelector('input'), host.querySelector('.time')];
  const url = URL.createObjectURL(source.file);
  const video = Object.assign(document.createElement('video'), { src: url, preload: 'auto', playsInline: true, muted: segment.isMuted === true });
  video.className = 'hidden-video';
  host.append(video);
  const layers = elements(segment);
  // The same drawing code as export, with the video element standing in for a decoded frame.
  const frame = { draw: (c, x, y, w, h) => c.drawImage(video, x, y, w, h) };
  let raf = 0, alive = true, bars;
  letterbox(source, segment.start, segment.duration).then((found) => { bars = found; if (alive) paint(); });

  const paint = () => {
    const t = Math.min(segment.duration, Math.max(0, video.currentTime - segment.start));
    ctx.setTransform(canvas.width / 1080, 0, 0, canvas.height / 1920, 0, 0);
    drawFrame(ctx, frame, segment, source.width, source.height, t, bars);
    drawCaptions(ctx, layers, t);
    slider.value = t;
    time.textContent = `${clock(t)} / ${clock(segment.duration)}`;
  };
  const tick = () => {
    if (video.currentTime >= segment.start + segment.duration - 0.03) video.currentTime = segment.start; // loops
    paint();
    raf = requestAnimationFrame(tick);
  };
  const seek = (t) => { video.currentTime = segment.start + t; };

  video.addEventListener('loadeddata', () => seek(0), { once: true });
  video.addEventListener('seeked', () => { if (video.paused) paint(); });
  video.addEventListener('play', () => { play.textContent = '⏸'; play.setAttribute('aria-label', 'Pause'); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); });
  video.addEventListener('pause', () => { play.textContent = '▶'; play.setAttribute('aria-label', 'Play'); cancelAnimationFrame(raf); paint(); });
  // Taking the player down clears the source, which raises an error too; only a live player's error means it can't play.
  video.addEventListener('error', () => { if (alive) onFailure?.(); });
  play.addEventListener('click', () => { if (video.paused) video.play().catch(() => alive && onFailure?.()); else video.pause(); });
  slider.addEventListener('input', () => seek(Number(slider.value)));

  stop = () => { alive = false; cancelAnimationFrame(raf); video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); stop = null; };
}

export const unmountPlayer = () => stop?.();
