// Choices and their wording, from Shared/Prism.Core/Models.cs. Values are the JSON names the desktop apps use.
import { ShortMakerError } from './gemini.js';

export const CAPTION_STYLES = ['auto', 'viral', 'highlightBox', 'boldCaps', 'oneWord', 'podcast', 'classic', 'minimal'];

export const STYLE_TITLES = {
  auto: 'Auto', classic: 'Simple', clean: 'Simple', viral: 'Viral highlight', highlightBox: 'Highlight box', boldCaps: 'Bold caps',
  minimal: 'Minimal', oneWord: 'One word', podcast: 'Podcast',
};

export const STYLE_DETAILS = {
  auto: 'Prism picks the style that fits this video.', classic: 'White text with a black outline.', viral: 'Each spoken word turns yellow.',
  highlightBox: 'The spoken word sits on a yellow box.', boldCaps: 'Big all-caps text, three words at a time.',
  minimal: 'Smaller text on a soft dark band.', oneWord: 'One big word at a time.', podcast: 'Soft-shadowed text; the spoken word turns green.',
};

export function resolvedStyle(style, videoType = null, splitScreen = false) {
  if (style === 'clean') return 'classic';
  if (style !== 'auto') return style ?? 'classic';
  if (splitScreen || videoType === 'podcast') return 'podcast';
  if (videoType === 'gaming') return 'boldCaps';
  if (videoType === 'tutorial') return 'minimal';
  return 'viral';
}

export const highlightsWords = (style) => style === 'viral' || style === 'highlightBox' || style === 'podcast';

/** The line a caption is centred on, in video pixels from the bottom of the 1080×1920 frame. */
export const POSITION_CENTER = { top: 1520, middle: 960, bottom: 620 };
export const SIZE_SCALE = { small: 0.8, medium: 1, large: 1.25 };

export const VIDEO_TYPES = ['auto', 'general', 'informational', 'podcast', 'tutorial', 'vlog', 'gaming'];

export const VIDEO_TYPE_TITLES = {
  auto: 'Auto-detect', general: 'Any video', informational: 'Informational / explainer', podcast: 'Podcast / interview',
  tutorial: 'Tutorial / screen', vlog: 'Vlog / talking head', gaming: 'Gaming / stream',
};

export const VIDEO_TYPE_DETAILS = {
  auto: 'Prism decides from what is said in the video.',
  general: 'No special rules. Good for mixed content.',
  informational: 'Facts and explanations. Each Short keeps one idea with its setup and payoff.',
  podcast: 'Two people talking. Split screen: one person on top, one on the bottom, captions in the middle.',
  tutorial: 'Screen recordings and lessons. The whole screen stays visible.',
  vlog: 'One person talking to camera. The crop follows them.',
  gaming: 'Gameplay and streams. The whole game stays visible.',
};

/** Screen recordings and gameplay lose their edges in a vertical crop, so they always show the whole frame. */
export const forcesFit = (type) => type === 'tutorial' || type === 'gaming';

export const SELECTION_GUIDANCE = {
  informational: "This is an informational or explainer video. Favor one clear fact, insight or explanation per clip, with the setup that makes it understandable and its payoff. Prefer the 'track' layout on the speaker.",
  podcast: "This is a podcast or interview. Favor strong opinions, surprising answers, complete stories and quotable lines; keep the question when the answer needs it. Prefer the 'track' layout so the speaker stays in frame.",
  tutorial: "This is a tutorial or screen recording. Favor one complete step, tip or result per clip, including what it achieves. Use the 'fit' layout so the whole screen stays readable.",
  vlog: "This is a vlog or talking-head video. Favor clear hooks, personal moments, reactions and payoffs told to camera. Prefer the 'track' layout on the person.",
  gaming: "This is gameplay or a stream. Favor wins, fails, clutch plays, funny reactions and hype moments, with enough lead-up to understand them. Use the 'fit' layout so the game and facecam stay visible.",
};

export const REGION_TITLES = { entireVideo: 'Entire video', firstHalf: 'First half', lastHalf: 'Last half', custom: 'Custom range' };

export function regionInterval(region, duration, customStart = null, customEnd = null) {
  if (!Number.isFinite(duration) || duration <= 0) throw new ShortMakerError('invalidRange');
  if (region === 'entireVideo') return { start: 0, end: duration };
  if (region === 'firstHalf') return { start: 0, end: duration / 2 };
  if (region === 'lastHalf') return { start: duration / 2, end: duration };
  const s = customStart, e = customEnd;
  if (Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s && e <= duration) return { start: s, end: e };
  throw new ShortMakerError('invalidRange');
}

/** Every Short is composed at 1080×1920; quality sets the file's size and codec. */
export const EXPORT_QUALITIES = {
  full: { title: '1080p · H.264', detail: 'Best quality. Plays everywhere.', width: 1080, height: 1920, codec: 'avc', bitrate: 12e6 },
  compact: { title: '1080p · HEVC', detail: 'Same quality, smaller files. Plays on recent phones and apps.', width: 1080, height: 1920, codec: 'hevc', bitrate: 6e6 },
  small: { title: '720p · H.264', detail: 'Smallest files, fastest to send.', width: 720, height: 1280, codec: 'avc', bitrate: 4e6 },
};
