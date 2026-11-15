// Shared local Motion provider transport. Retry only explicit rate limits and never
// switch models or relax provider privacy settings.
const {HttpError} = require('./_lib');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Motion has its own OpenRouter key, kept outside the Relio repo, so Motion work never spends or exposes the Relio Clips key.
// Read from MOTION_OPENROUTER_API_KEY, else from the file MOTION_ENV_FILE (default ~/.config/relio-motion/.env).
// OPENROUTER_API_KEY (the Relio Clips key) is never read here.
function motionKey() {
  if (process.env.MOTION_OPENROUTER_API_KEY) return process.env.MOTION_OPENROUTER_API_KEY;
  const file = process.env.MOTION_ENV_FILE || path.join(os.homedir(), '.config', 'relio-motion', '.env');
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('MOTION_OPENROUTER_API_KEY='));
    return line ? line.slice('MOTION_OPENROUTER_API_KEY='.length).trim().replace(/^["']|["']$/g, '') || null : null;
  } catch { return null; }
}

// Same rule as the app's AI: only providers that keep no data and don't train on it.
const PROVIDER = Object.freeze({zdr: true, data_collection: 'deny', sort: 'latency'});
const LOCAL_ORIGINS = ['http://localhost:4173', 'http://127.0.0.1:4173'];

// Motion is local-only. The Host check keeps it off the live site; the Origin check stops another
// web page (or generated code in the sandbox, whose Origin is "null") from spending the Motion key.
function assertLocal(req) {
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || ''))) throw new HttpError(404, 'Not found.');
  const origin = req.headers.origin;
  if (origin !== undefined && !LOCAL_ORIGINS.includes(origin)) throw new HttpError(403, 'Forbidden.');
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
}

// The page's model list is the allowlist. zdr stays on for every request, whatever the model.
const MODELS = require('../motion/models.json');
const EFFORTS = ['low', 'medium', 'high'];

/** The model and reasoning level for a request. No model given: the env default (old behavior). */
function pickModel(body, fallback) {
  if (body.model === undefined) return {id: fallback, effort: null};
  const model = MODELS.find((m) => m.id === body.model);
  if (!model) throw new HttpError(400, 'Unknown model.');
  if (!model.effort) return {id: model.id, effort: null};
  const effort = body.reasoning ?? 'medium';
  if (!EFFORTS.includes(effort)) throw new HttpError(400, 'Unknown reasoning level.');
  return {id: model.id, effort};
}
// Models without a level setting only switch reasoning on; "medium" is what they always got.
const reasoningFor = (choice) => ({effort: choice.effort || 'medium', exclude: true});

/** Running totals for one API call: tokens and cost over every model request it made. */
function newTally() { return {requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, usd: 0, usdKnown: true}; }
function addUsage(tally, usage) {
  tally.requests++;
  tally.promptTokens += usage?.prompt_tokens || 0;
  tally.completionTokens += usage?.completion_tokens || 0;
  tally.reasoningTokens += usage?.completion_tokens_details?.reasoning_tokens || 0;
  if (usage?.cost == null) tally.usdKnown = false; else tally.usd += usage.cost;
}

// One JSON line per run, next to the Motion key, so runs can be compared per model.
const RUN_LOG = process.env.MOTION_RUN_LOG || path.join(os.homedir(), '.config', 'relio-motion', 'runs.jsonl');
function logRun({kind, choice, tally, ms, ...extra}) {
  const entry = {at: new Date().toISOString(), kind, model: choice.id, reasoning: choice.effort || 'default', requests: tally.requests,
    promptTokens: tally.promptTokens, completionTokens: tally.completionTokens, reasoningTokens: tally.reasoningTokens,
    usd: tally.usdKnown ? Number(tally.usd.toFixed(6)) : null, ms, ...extra};
  console.log(JSON.stringify({motionRun: entry}));
  if (process.env.NODE_TEST_CONTEXT) return;
  try { fs.mkdirSync(path.dirname(RUN_LOG), {recursive: true}); fs.appendFileSync(RUN_LOG, JSON.stringify(entry) + '\n'); }
  catch (error) { console.warn(JSON.stringify({motionRunLog: 'write-failed', code: error.code})); }
}

async function readJson(req, limit) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > limit) throw new HttpError(413, 'Request too large.'); }
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'The request is not valid JSON.'); }
}

// Node fetch has its own headers/body deadlines. The native HTTPS request has
// no application deadline and remains abortable when the user presses Stop.
function providerFetch(url, init) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {method:init.method, headers:init.headers, signal:init.signal}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Provider connection closed.')));
      response.on('end', () => resolve({status:response.statusCode, ok:response.statusCode >= 200 && response.statusCode < 300, text:async () => Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

async function requestProvider(url, init, {signal, delays = [1000, 3000], fetcher = process.env.NODE_TEST_CONTEXT ? global.fetch : providerFetch, sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new HttpError(499, 'Request cancelled.');
    let response, raw;
    try {
      response = await fetcher(url, {...init, signal});
      raw = await response.text();
    } catch (error) {
      if (signal?.aborted) throw new HttpError(499, 'Request cancelled.');
      // Retry transient disconnects with the same model and privacy settings.
      // Log only the error code, never headers, prompts, or credentials.
      console.warn(JSON.stringify({motionProvider:'connection-error', code:String(error.code || error.cause?.code || error.name || 'UNKNOWN').slice(0,80), attempt:attempt + 1}));
      if (attempt < delays.length) { await sleep(delays[attempt]); continue; }
      throw new HttpError(502, 'The connection to the model provider was interrupted after automatic retries. Please try again.');
    }
    let data;
    try { data = JSON.parse(raw.split('\n').filter(line => !line.trimStart().startsWith(':')).join('\n') || '{}'); }
    catch {
      if (response.status !== 429) throw new HttpError(502, `The model provider returned an incomplete or invalid response (HTTP ${response.status}). Please try again.`);
      data = {};
    }
    const rateLimited = response.status === 429 || data.error?.code === 429 || /rate[ -]?limit/i.test(String(data.error?.message || ''));
    if (!rateLimited) return {response, data};
    if (attempt >= delays.length) throw new HttpError(429, 'The selected model is temporarily rate-limited by its provider. Please try again later.');
    await sleep(delays[attempt]);
  }
}
module.exports = {requestProvider, motionKey, PROVIDER, assertLocal, readJson, MODELS, pickModel, reasoningFor, newTally, addUsage, logRun};
