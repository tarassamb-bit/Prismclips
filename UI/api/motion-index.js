// Describes one uploaded photo or video from 1–3 small frames, so the code model knows what the user's media shows. Local development only.
//   POST { hash, kind: 'image'|'video', frames: [jpeg data URL] } -> { description, tags }
// Results are cached by file hash next to the Motion key, so the same file is never described twice.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {HttpError, send, fail} = require('./_lib');
const {requestProvider, motionKey, PROVIDER, assertLocal, readJson, pickModel, reasoningFor, newTally, addUsage, logRun} = require('./_motion-provider');
const MODEL = process.env.MOTION_INDEX_MODEL || 'xiaomi/mimo-v2.6-flash';
const CACHE = process.env.MOTION_INDEX_CACHE || path.join(os.homedir(), '.config', 'relio-motion', 'media-index.json');

const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } };

function validate(body) {
  if (typeof body.hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.hash)) throw new HttpError(400, 'A valid file hash is required.');
  if (!['image', 'video'].includes(body.kind)) throw new HttpError(400, 'Unknown media kind.');
  const max = body.kind === 'image' ? 1 : 3;
  if (!Array.isArray(body.frames) || !body.frames.length || body.frames.length > max || body.frames.some((f) => typeof f !== 'string' || f.length > 300000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(f))) throw new HttpError(400, 'The media frames could not be read.');
}

module.exports = async (req, res) => {
  let choice = null; const tally = newTally(), started = Date.now();
  try {
    assertLocal(req);
    const body = await readJson(req, 1_000_000);
    validate(body);
    const cached = readCache()[body.hash];
    if (cached) return send(res, 200, {...cached, cached: true});
    if (!motionKey()) throw new HttpError(503, 'The model key is missing.');
    choice = pickModel(body, MODEL);
    const text = `${body.kind === 'video' ? `These are ${body.frames.length} frames from one video, in order.` : 'This is one photo.'} Describe what it shows for a motion designer who will place it in an animation: one plain sentence (under 25 words) naming the main subject, setting and any readable text, then up to 6 short lowercase tags. Return JSON only: {"description":"...","tags":["..."]}`;
    const {response, data} = await requestProvider('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {Authorization: `Bearer ${motionKey()}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://relioclips.com', 'X-Title': 'Relio Clips'},
      body: JSON.stringify({model: choice.id, max_tokens: 1500, reasoning: reasoningFor(choice), provider: PROVIDER, messages: [{role: 'user', content: [{type: 'text', text}, ...body.frames.map((url) => ({type: 'image_url', image_url: {url}}))]}]}),
    });
    if (!response.ok || !data.choices?.length) throw new HttpError(502, `The media description provider: ${data.error?.message || `HTTP ${response.status}`}`);
    addUsage(tally, data.usage);
    let parsed;
    try { parsed = JSON.parse(String(data.choices[0].message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { throw new HttpError(502, 'The media description came back unreadable.'); }
    if (typeof parsed.description !== 'string' || !parsed.description.trim()) throw new HttpError(502, 'The media description came back empty.');
    const result = {description: parsed.description.trim().slice(0, 300), tags: (Array.isArray(parsed.tags) ? parsed.tags : []).filter((t) => typeof t === 'string').slice(0, 6).map((t) => t.slice(0, 30))};
    // Re-read before writing, so two uploads described at once both stay in the cache.
    fs.mkdirSync(path.dirname(CACHE), {recursive: true});
    fs.writeFileSync(CACHE, JSON.stringify({...readCache(), [body.hash]: result}));
    logRun({kind: 'index', choice, tally, ms: Date.now() - started, media: body.kind});
    choice = null;
    send(res, 200, {...result, usd: tally.usdKnown ? tally.usd : null});
  } catch (error) {
    if (choice) logRun({kind: 'index', choice, tally, ms: Date.now() - started, failed: String(error.message || error).slice(0, 200)});
    if (!res.destroyed) fail(res, error);
  }
};
