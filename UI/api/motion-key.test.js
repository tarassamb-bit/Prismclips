// The Motion functions must never use the Relio Clips key.
const test = require('node:test'), assert = require('node:assert');
const {motionKey} = require('./_motion-provider');

test('Motion ignores OPENROUTER_API_KEY and reads only its own key', () => {
  const saved = {r: process.env.OPENROUTER_API_KEY, m: process.env.MOTION_OPENROUTER_API_KEY, f: process.env.MOTION_ENV_FILE};
  try {
    process.env.OPENROUTER_API_KEY = 'relio-key';
    delete process.env.MOTION_OPENROUTER_API_KEY;
    process.env.MOTION_ENV_FILE = '/nonexistent/motion.env';
    assert.equal(motionKey(), null);
    process.env.MOTION_OPENROUTER_API_KEY = 'motion-key';
    assert.equal(motionKey(), 'motion-key');
  } finally {
    for (const [k, v] of [['OPENROUTER_API_KEY', saved.r], ['MOTION_OPENROUTER_API_KEY', saved.m], ['MOTION_ENV_FILE', saved.f]]) v === undefined ? delete process.env[k] : process.env[k] = v;
  }
});
