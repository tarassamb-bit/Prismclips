// Vercel function: Prism AI for the web app. A port of supabase/functions/gemini/index.ts (the Mac app still uses that one),
// moved here because Vercel lets a function run 300 s and Supabase stops at 150 s, too soon for slow Mimo answers.
// The app sends Gemini-format requests signed in with its Supabase session; this forwards them to OpenRouter and answers
// in the same format. Vercel environment variables: OPENROUTER_API_KEY, SUPABASE_SERVICE_ROLE_KEY, optional OPENROUTER_MODEL.
// Keep the two copies in step when changing models, limits or usage accounting.
const SUPABASE_URL = 'https://isdplhahgggundbohmlr.supabase.co';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AUDIO_MODELS = ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'];
const IMAGE_MODELS = ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'];
const TEXT_MODELS = ['nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT_MESSAGE = "You've reached your beta usage limit. Ask for a promo code to get more, then enter it in Settings › Usage.";
// Free models report a cost of 0; every answer counts at least this much, so the spend cap also bounds free use.
const MIN_ANSWER_USD = 0.002;
// All models together must answer before Vercel stops the function at 300 s (maxDuration in vercel.json).
// Mimo sometimes stalls on a request it answers in 10–30 s on a fresh try; after this long it gets that fresh try.
const MODEL_TIMEOUT_MS = 90_000;
const REQUEST_BUDGET_MS = 280_000;
const MIN_MODEL_TIME_MS = 20_000;

/** Gemini schemas use upper-case type names ("OBJECT"); JSON Schema uses lower-case ones. */
function lowerTypes(value) {
  if (Array.isArray(value)) return value.map(lowerTypes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, key === 'type' && typeof item === 'string' ? item.toLowerCase() : lowerTypes(item)]));
  }
  return value;
}

function audioFormat(mimeType) {
  if (/wav/i.test(mimeType)) return 'wav';
  if (/mpeg|mp3/i.test(mimeType)) return 'mp3';
  return 'm4a';
}

function toOpenRouter(body) {
  const content = [];
  let hasAudio = false, hasImage = false;
  for (const part of body.contents.flatMap((turn) => turn.parts)) {
    if (part.text !== undefined) {
      content.push({ type: 'text', text: part.text });
    } else if (part.inlineData) {
      const { mimeType, data } = part.inlineData;
      if (mimeType.startsWith('image/')) {
        content.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } });
        hasImage = true;
      } else if (mimeType.startsWith('audio/')) {
        content.push({ type: 'input_audio', input_audio: { data, format: audioFormat(mimeType) } });
        hasAudio = true;
      } else {
        throw new Error(`Unsupported attachment type ${mimeType}`);
      }
    }
  }
  const messages = [];
  const schema = body.generationConfig?.responseSchema;
  if (schema) {
    messages.push({
      role: 'system',
      content: `Reply with only one JSON object, no other text and no code fences, that matches this JSON Schema: ${JSON.stringify(lowerTypes(schema))}`,
    });
  }
  messages.push({ role: 'user', content });
  const models = hasAudio ? AUDIO_MODELS : hasImage ? IMAGE_MODELS : TEXT_MODELS;
  const request = { messages, temperature: body.generationConfig?.temperature ?? 0.2, reasoning: { effort: 'low', exclude: true } };
  return { models, wantsJSON: Boolean(schema), request };
}

function cleanJSON(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/** OpenRouter keeps a slow request alive by sending ": OPENROUTER PROCESSING" lines before the JSON answer. */
function parseOpenRouter(body) {
  return JSON.parse(body.split('\n').filter((line) => !line.startsWith(':')).join('\n'));
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(body));
}
const fail = (res, status, message) => send(res, status, { error: { message } });

function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Legacy service_role keys are JWTs and go in Authorization too; sb_secret_ keys must not.
  return { apikey: key, ...(key.startsWith('eyJ') && { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' };
}

async function rpc(name, args) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: serviceHeaders(), body: JSON.stringify(args), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  // Functions that return nothing (prism_record_beta_spend) answer with an empty body.
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/** Verifies the caller and reserves usage; returns the user id, or null after answering with a refusal. */
async function checkVideoLimit(req, res) {
  const video = req.headers['x-prism-video'] ?? '';
  const minutes = Number(req.headers['x-prism-minutes']);
  if (!/^[0-9a-f]{64}$/.test(video) || !Number.isFinite(minutes) || !(minutes > 0 && minutes <= 600)) {
    return fail(res, 400, 'Prism AI needs the video it is working on. Make Shorts from a video in the app.'), null;
  }
  const run = req.headers['x-prism-run'] ?? null;
  if (run !== null && !UUID.test(run)) return fail(res, 400, 'Prism AI got an invalid analysis run. Update Prism and try again.'), null;
  const auth = req.headers.authorization ?? '';
  const apikey = req.headers.apikey ?? '';
  if (!auth.startsWith('Bearer ') || !apikey) return fail(res, 401, 'Sign in to your Prism account to continue.'), null;
  let identity;
  try {
    identity = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return fail(res, 503, 'Prism could not verify your sign-in right now.'), null;
  }
  if (identity.status === 401 || identity.status === 403) return fail(res, 401, 'Sign in to your Prism account to continue.'), null;
  if (!identity.ok) return fail(res, 503, 'Prism could not verify your sign-in right now.'), null;
  const user = (await identity.json().catch(() => null))?.id;
  if (typeof user !== 'string' || !UUID.test(user)) return fail(res, 401, 'Sign in to your Prism account to continue.'), null;
  try {
    let allowed = (await rpc('prism_reserve_beta_usage', { p_user: user, p_video: video, p_minutes: minutes })) === true;
    // The first run is covered by the reservation; the database charges each re-analysis a share of the minutes.
    if (allowed && run !== null) allowed = (await rpc('prism_begin_analysis_run', { p_user: user, p_video: video, p_run: run, p_minutes: minutes })) === true;
    if (!allowed) return send(res, 429, { error: { code: 'usage_limit', message: LIMIT_MESSAGE } }), null;
  } catch {
    return fail(res, 503, 'Prism could not check your allowance right now. Try again shortly.'), null;
  }
  return user;
}

async function recordSpend(user, answer) {
  const reported = Number(answer?.usage?.cost ?? 0);
  await rpc('prism_record_beta_spend', { p_user: user, p_usd: Math.max(Number.isFinite(reported) ? reported : 0, MIN_ANSWER_USD) });
}

async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Use POST.');
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || !process.env.SUPABASE_SERVICE_ROLE_KEY) return fail(res, 500, 'Prism AI is not configured on the server.');
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.contents)) return fail(res, 400, 'The request is not valid JSON.');
  let converted;
  try {
    converted = toOpenRouter(body);
  } catch (error) {
    return fail(res, 400, error.message);
  }
  const user = await checkVideoLimit(req, res);
  if (!user) return;

  const chosen = process.env.OPENROUTER_MODEL;
  // The chosen model twice: a stalled request usually answers on a second try, and the free fallbacks are often rate-limited.
  const models = [...(chosen ? [chosen, chosen] : []), ...converted.models.filter((model) => model !== chosen)];
  let status = 503, reply = null;
  const failures = [];
  const started = Date.now();
  for (const model of models) {
    const left = REQUEST_BUDGET_MS - (Date.now() - started);
    if (left < MIN_MODEL_TIME_MS) { status = 504; failures.push(`no time left to try ${model}`); break; }
    let upstream, answer;
    try {
      // The timeout covers reading the body too: OpenRouter sends headers at once and the answer only when it's done.
      const signal = AbortSignal.timeout(Math.min(MODEL_TIMEOUT_MS, left));
      upstream = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://prismclips.vercel.app', 'X-Title': 'Prism Clips' },
        body: JSON.stringify({ model, ...converted.request }),
        signal,
      });
      answer = await upstream.text().then(parseOpenRouter).catch((error) => { if (signal.aborted) throw error; return {}; });
    } catch {
      status = 504;
      failures.push(`${model}: no answer within ${Math.round(Math.min(MODEL_TIMEOUT_MS, left) / 1000)} s`);
      console.error(failures.at(-1));
      continue;
    }
    if (upstream.ok && answer?.choices?.length) {
      try { await recordSpend(user, answer); } catch { return fail(res, 503, 'Prism could not record usage. Please try again later.'); }
      reply = answer; break;
    }
    status = upstream.status;
    const raw = typeof answer?.error?.metadata?.raw === 'string' ? ` (${answer.error.metadata.raw.slice(0, 200)})` : '';
    failures.push(`${model}: ${answer?.error?.message ?? `HTTP ${upstream.status}`}${raw}`);
    console.error(failures.at(-1));
    if (status === 401) break;
  }
  if (!reply) return fail(res, status, failures.join(' · ') || 'No model answered.');

  const choice = reply.choices[0];
  const raw = choice?.message?.content ?? '';
  const text = converted.wantsJSON ? cleanJSON(raw) : raw;
  send(res, 200, { candidates: [{ content: { parts: [{ text }] }, finishReason: choice?.finish_reason === 'length' ? 'MAX_TOKENS' : 'STOP' }] });
}

module.exports = handler;
module.exports.parseOpenRouter = parseOpenRouter;
