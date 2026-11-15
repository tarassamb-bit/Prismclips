// The picker's model list is the server's allowlist; zdr and the reasoning rules hold for every model.
const test = require('node:test'), assert = require('node:assert/strict');
const {MODELS, pickModel, reasoningFor, PROVIDER} = require('./_motion-provider');

test('only listed models are accepted, with a level only where the model has one', () => {
  assert.deepEqual(pickModel({}, 'env/default'), {id: 'env/default', effort: null});
  assert.throws(() => pickModel({model: 'openai/gpt-x'}), /Unknown model/);
  assert.deepEqual(pickModel({model: 'google/gemini-4-carbon', reasoning: 'high'}), {id: 'google/gemini-4-carbon', effort: 'high'});
  assert.deepEqual(pickModel({model: 'google/gemini-4-carbon'}), {id: 'google/gemini-4-carbon', effort: 'medium'});
  assert.throws(() => pickModel({model: 'google/gemini-4-carbon', reasoning: 'max'}), /Unknown reasoning level/);
  assert.deepEqual(pickModel({model: 'xiaomi/mimo-v2.6-flash', reasoning: 'high'}), {id: 'xiaomi/mimo-v2.6-flash', effort: null});
  assert.throws(() => pickModel({model: 'xiaomi/mimo-v2.6-pro'}), /Unknown model/);
  // Batch IDs only work with OpenRouter's batch API, not chat/completions.
  assert.ok(MODELS.every((m) => !m.id.endsWith(':batch')));
  assert.deepEqual(reasoningFor({effort: null}), {effort: 'medium', exclude: true});
  assert.equal(PROVIDER.zdr, true);
});

test('every entry has the picker fields', () => {
  for (const m of MODELS) {
    for (const key of ['label', 'effort']) assert.ok(key in m, `${m.id} ${key}`);
  }
});

test('a planning model outside the list is refused before any model call', async () => {
  const handler = require('./motion');
  const old = process.env.MOTION_OPENROUTER_API_KEY; process.env.MOTION_OPENROUTER_API_KEY = 'local-test-key';
  const oldFetch = global.fetch; global.fetch = async () => { throw new Error('no model call expected'); };
  const req = {method: 'POST', headers: {host: 'localhost:4173'}, async *[Symbol.asyncIterator]() { yield JSON.stringify({engine: 'canvas', prompt: 'x', style: 'watercolor-wash', plan: {model: 'openai/gpt-x'}}); }};
  const res = {setHeader() {}, end(value) { this.body = value; }};
  try { await handler(req, res); } finally { global.fetch = oldFetch; if (old === undefined) delete process.env.MOTION_OPENROUTER_API_KEY; else process.env.MOTION_OPENROUTER_API_KEY = old; }
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Unknown model/);
});

test('a model with a backup lists both, in order', () => {
  const {modelsFor} = require('./_motion-provider');
  assert.deepEqual(modelsFor('openai/gpt-6-luna-pro'), ['openai/gpt-6-luna-pro', 'openai/gpt-6-luna']);
  assert.deepEqual(modelsFor('meta/muse-ember'), ['meta/muse-ember']);
});
