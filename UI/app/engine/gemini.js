// Prism AI requests (Gemini's generateContent shape) with structured JSON output and retries, a port of Shared/Prism.Core/Gemini.cs.
// Requests go through Prism's server with the signed-in person's session; the server holds the AI key and picks the model.

export const PROJECT_URL = 'https://isdplhahgggundbohmlr.supabase.co/';
export const PUBLISHABLE_KEY = 'sb_publishable_ATTcp2-mrca0swMStHHdYQ_Le851b8l';
// On localhost the call goes through the dev server's /gateway, which forwards it; the function itself allows browsers once deployed.
export const GATEWAY_URL = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname) ? '/gateway' : PROJECT_URL + 'functions/v1/gemini';

const MESSAGES = {
  signIn: 'Sign in to your Prism account to use Prism AI.',
  usageLimit: "You've reached your beta usage limit. Ask for a promo code to get more, then enter it in Settings › Usage.",
  audioExport: 'Could not prepare audio for Prism AI. Your existing Shorts were kept.',
  requestTooLarge: 'This Prism AI request exceeds the safe upload size. Choose a shorter source region.',
  noDistinctClips: 'No new distinct moments were found in this range. Try another region or length. Your existing clips were kept.',
  noStrongClips: 'Prism could not find a strong, self-contained Short in this part of the video. Try another part of the video or a different clip length.',
  invalidTiming: 'Prism AI returned speech timestamps that could not be aligned safely.',
  invalidResponse: 'Prism AI returned an incomplete or invalid response. Your existing edits were kept.',
};

function requestMessage(status) {
  if (status === 401 || status === 403) return 'Your Prism sign-in was not accepted. Sign in again in Settings › Account.';
  if (status === 429) return 'Prism AI is handling too many requests right now. Wait a moment, then try again.';
  if (status === 503) return 'Prism AI is overloaded right now (HTTP 503). Wait a moment, then try again.';
  return `Prism AI could not complete the request (HTTP ${status}). Please try again.`;
}

export class GeminiError extends Error {
  /** @param {keyof MESSAGES | 'request'} failure  @param {string} [reason] the server's own explanation */
  constructor(failure, status = 0, reason = null) {
    super(reason ?? (failure === 'request' ? requestMessage(status) : MESSAGES[failure]));
    this.failure = failure;
    this.status = status;
  }
}

/** A failure in one stage of a long run, kept whole so the app can tell a busy server from a sign-in problem. */
export class StageFailure extends Error {
  constructor(stage, underlying) {
    super(`${stage}: ${underlying.message} Your existing clips were kept.`);
    this.stage = stage;
    this.underlying = underlying;
  }
}

export class ShortMakerError extends Error {
  constructor(failure, detail = null) {
    super({
      noVideo: 'No playable video track was found.',
      cannotExport: 'The video encoder could not complete the render.' + (detail ? ' ' + detail : ''),
      invalidRange: 'The edit contains an invalid time range. Choose a range within the source video.',
    }[failure]);
    this.failure = failure;
  }
}

/** Seconds to wait before each retry of a server error. Tests shorten these. */
export const retry = { waits: [2, 4, 8, 15, 30] };

export const text = (value) => ({ text: value });
export const inline = (mimeType, bytes) => ({ inlineData: { mimeType, data: base64(bytes) } });

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const sleep = (seconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, seconds * 1000);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/**
 * @typedef {{ video: string, minutes: number, day: string, run?: string }} Usage
 * @typedef {{ accessToken: () => Promise<string|null>, usage: Usage, onRetry?: (message: string) => void, fetch?: typeof fetch }} Configuration
 */

/** Sends one request and decodes the JSON answer. */
export async function generate(parts, schema, configuration, signal) {
  const answer = await generateText(parts, schema, configuration, signal);
  try { return JSON.parse(answer); } catch { throw new GeminiError('invalidResponse'); }
}

/** Sends one request and returns the answer's text as the model wrote it. */
export async function generateText(parts, schema, configuration, signal) {
  // Every request names its video, so the server can count it against the limit. No video, no request.
  if (!configuration.usage.video) throw new GeminiError('signIn');
  const token = await configuration.accessToken();
  if (!token) throw new GeminiError('signIn');
  const body = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
  });
  if (body.length > 19_000_000) throw new GeminiError('requestTooLarge');
  const response = await send(token, body, configuration, signal);
  signal?.throwIfAborted();
  if (!response) throw new GeminiError('invalidResponse');
  if (response.status !== 200) {
    // The reason is in the body; show it instead of guessing from the status code.
    const { code, message } = serverError(response.body);
    throw new GeminiError(code === 'usage_limit' ? 'usageLimit' : 'request', response.status, message);
  }
  try {
    const candidate = JSON.parse(response.body).candidates[0];
    if (candidate.finishReason !== 'STOP') throw new GeminiError('invalidResponse');
    return candidate.content.parts.filter((part) => part.thought !== true).map((part) => part.text ?? '').join('');
  } catch (error) {
    throw error instanceof GeminiError ? error : new GeminiError('invalidResponse');
  }
}

/** Server errors and short rate-limit waits are retried; the last response is returned as is. */
async function send(token, body, configuration, signal) {
  const { usage } = configuration;
  const waits = retry.waits;
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    signal?.throwIfAborted();
    const canRetry = attempt < waits.length;
    // A little randomness keeps the batches that run side by side from retrying in lockstep.
    const wait = canRetry ? waits[attempt] * (1 + Math.random() * 0.25) : 0;
    const timeout = AbortSignal.timeout(180_000);
    try {
      const headers = {
        'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: PUBLISHABLE_KEY,
        'x-prism-video': usage.video, 'x-prism-minutes': String(usage.minutes), 'x-prism-day': usage.day,
      };
      if (usage.run) headers['x-prism-run'] = usage.run;
      const response = await (configuration.fetch ?? fetch)(GATEWAY_URL, {
        method: 'POST', headers, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const responseText = await response.text();
      const status = response.status;
      if (canRetry && [500, 502, 503, 504, 546].includes(status)) {
        const pause = Math.min(60, Math.max(wait, retryDelay(response, responseText) ?? 0));
        configuration.onRetry?.(`Prism AI is busy (HTTP ${status}) · retrying in ${Math.round(pause)} s`);
        await sleep(pause, signal);
        continue;
      }
      // A per-minute limit says how long to wait; a usage limit or a daily limit doesn't, so it still fails.
      const delay = status === 429 ? retryDelay(response, responseText) : null;
      if (canRetry && delay !== null && delay <= 60) {
        configuration.onRetry?.(`Prism AI rate limit · retrying in ${Math.round(delay) + 1} s`);
        await sleep(delay + 1, signal);
        continue;
      }
      return { status, body: responseText };
    } catch (error) {
      if (signal?.aborted) throw error;
      // The browser says only "Failed to fetch"; give the person something they can act on.
      if (attempt >= 2) throw new GeminiError('request', 0, 'Could not reach Prism AI. Check your internet connection and try again.');
      // Requests may run three minutes before timing out, so lost connections get only two more tries.
      configuration.onRetry?.(`Connection to Prism AI dropped · retrying in ${Math.round(wait)} s`);
      await sleep(wait, signal);
    }
  }
  return null;
}

function serverError(body) {
  try {
    const root = JSON.parse(body);
    const read = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return { code: read(root?.error?.code), message: read(root?.error?.message) ?? read(root?.message) ?? read(root?.msg) };
  } catch {
    return { code: null, message: null };
  }
}

/** Seconds the server asks us to wait, from Retry-After or the error's RetryInfo ("37s"). */
export function retryDelay(response, body) {
  const header = Number(response.headers.get('Retry-After'));
  if (response.headers.has('Retry-After') && Number.isFinite(header) && header >= 0) return header;
  try {
    for (const detail of JSON.parse(body).error.details) {
      const value = detail.retryDelay;
      if (typeof value === 'string' && value.endsWith('s')) {
        const parsed = Number(value.slice(0, -1));
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      }
    }
  } catch { /* no RetryInfo */ }
  return null;
}

/** Runs `transform` on every item, at most `limit` at a time, results in the items' order. The first failure stops the rest. */
export async function map(items, transform, signal, limit = 6, onEach) {
  const controller = new AbortController();
  const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const results = new Array(items.length);
  let next = 0, failure = null;
  async function worker() {
    try {
      while (next < items.length) {
        const index = next++;
        linked.throwIfAborted();
        results[index] = await transform(items[index], linked);
        onEach?.(index, results[index]);
      }
    } catch (error) {
      // Only a stop caused by another worker's failure is skipped.
      if (!controller.signal.aborted && failure === null) failure = error;
      controller.abort();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  signal?.throwIfAborted();
  if (failure) throw failure;
  return results;
}
