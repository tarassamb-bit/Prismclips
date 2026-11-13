// The picker's model list is the server's allowlist; zdr and the reasoning rules hold for every model.
const test = require('node:test'), assert = require('node:assert/strict');
const {MODELS, pickModel, reasoningFor, PROVIDER} = require('./_motion-provider');

test('only listed models are accepted, with a level only where the model has one', () => {
  assert.deepEqual(pickModel({}, 'env/default'), {id: 'env/default', effort: null});
  assert.throws(() => pickModel({model: 'openai/gpt-x'}), /Unknown model/);
  assert.deepEqual(pickModel({model: 'google/gemini-4-carbon:batch', reasoning: 'high'}), {id: 'google/gemini-4-carbon:batch', effort: 'high'});
  assert.deepEqual(pickModel({model: 'google/gemini-4-carbon:batch'}), {id: 'google/gemini-4-carbon:batch', effort: 'medium'});
  assert.throws(() => pickModel({model: 'google/gemini-4-carbon:batch', reasoning: 'max'}), /Unknown reasoning level/);
  assert.deepEqual(pickModel({model: 'xiaomi/mimo-v2.6-flash', reasoning: 'high'}), {id: 'xiaomi/mimo-v2.6-flash', effort: null});
  assert.throws(() => pickModel({model: 'xiaomi/mimo-v2.6-pro'}), /Unknown model/);
  assert.deepEqual(reasoningFor({effort: null}), {effort: 'medium', exclude: true});
  assert.equal(PROVIDER.zdr, true);
});

test('every entry has the picker fields', () => {
  for (const m of MODELS) {
    for (const key of ['label', 'effort']) assert.ok(key in m, `${m.id} ${key}`);
  }
});
