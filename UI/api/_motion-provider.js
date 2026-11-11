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
module.exports = {requestProvider, motionKey};
