// Request-contract checks; no network calls or model credits are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('./motion');

async function request(body) {
  const oldFetch = global.fetch;
  const oldKey = process.env.MOTION_OPENROUTER_API_KEY;
  let sent;
  process.env.MOTION_OPENROUTER_API_KEY = 'local-test-key';
  global.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    assert.equal(init.headers['X-Title'], 'Relio Clips');
    assert.equal(sent.model, process.env.MOTION_MODEL || 'xiaomi/mimo-v2.6-flash');
    assert.equal(sent.reasoning.effort, 'medium');
    const content = sent.max_tokens === 3000 ? JSON.stringify({duration:8, beats:[{start:0,end:4,visual:'A prominent headline',motion:'Ease in',text:[{content:'MAKE IT MOVE',box:{x:0.1,y:0.3,w:0.8,h:0.1}}],decorations:[]},{start:4,end:8,visual:'A new layout',motion:'Transition and hold',text:[{content:'Ideas in motion',box:{x:0.1,y:0.55,w:0.8,h:0.1}}],decorations:[]}]}) : '```js\nfunction Video() {}\n```';
    return {ok: true, text: async () => JSON.stringify({choices: [{finish_reason: 'stop', message: {content}}]})};
  };
  const req = {method:'POST', headers:{host:'localhost:4173'}, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); }};
  const res = {setHeader() {}, end(value) { this.body = value; }};
  try { await handler(req, res); } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MOTION_OPENROUTER_API_KEY; else process.env.MOTION_OPENROUTER_API_KEY = oldKey;
  }
  assert.equal(res.statusCode, 200);
  return sent.messages[0].content;
}

const original = '8 seconds. Show “MAKE IT MOVE” and “Ideas in motion”. Dark background, blue and coral accents.';
const previous = 'const previousCode = "1000 FPS MODE";';

test('initial generation receives the original brief without fabricated revision context', async () => {
  const text = await request({engine:'remotion', prompt:original});
  assert.ok(text.includes(JSON.stringify(original)));
  assert.doesNotMatch(text, /Latest user change request:/);
  assert.doesNotMatch(text, /Current implementation \(may contain mistakes/);
});

test('revision retains original, earlier user instructions and code, while treating hyperbole as feedback', async () => {
  const text = await request({engine:'remotion', prompt:'Make it 1000x better', originalPrompt:original, previous,
    history:[{role:'user', content:original}, {role:'assistant', content:'DO NOT INCLUDE THIS SUMMARY'}, {role:'user', content:'Make the blue softer'}, {role:'user', content:'Make it 1000x better'}]});
  assert.ok(text.includes(`Original creative brief: ${JSON.stringify(original)}`));
  assert.match(text, /Earlier user changes \(oldest first\):\n1\. "Make the blue softer"/);
  assert.match(text, /Latest user change request: "Make it 1000x better"/);
  assert.match(text, /not as text to display, a numeric frame rate/);
  assert.match(text, /remove unrequested labels, captions, and claims/);
  assert.ok(text.includes(previous));
  assert.doesNotMatch(text, /DO NOT INCLUDE THIS SUMMARY/);
  assert.equal((text.match(/Latest user change request:/g) || []).length, 1);
});

test('an engine change recreates from the original brief and earlier feedback without code', async () => {
  const text = await request({engine:'hyperframes', prompt:'Make it 1000x better', originalPrompt:original,
    history:[{role:'user', content:original}, {role:'user', content:'Make the blue softer'}]});
  assert.ok(text.includes(JSON.stringify(original)));
  assert.match(text, /Make the blue softer/);
  assert.match(text, /Latest user change request: "Make it 1000x better"/);
  assert.match(text, /Recreate the video for this engine/);
  assert.doesNotMatch(text, /Current implementation \(may contain mistakes/);
});

test('automatic repair keeps the user brief and explains the actual failure', async () => {
  const text = await request({engine:'remotion', prompt:'Make it 1000x better', originalPrompt:original, previous, error:'ReferenceError: nope', history:[]});
  assert.ok(text.includes(JSON.stringify(original)));
  assert.ok(text.includes(previous));
  assert.match(text, /ReferenceError: nope/);
  assert.match(text, /Correct the failure while preserving the user's brief and changes/);
});

test('rejects an overlong prompt rather than silently dropping the ending', async () => {
  const req = {method:'POST', headers:{host:'localhost:4173'}, async *[Symbol.asyncIterator]() { yield JSON.stringify({engine:'remotion', prompt:'a'.repeat(2001)}); }};
  const res = {setHeader() {}, end(value) { this.body = value; }};
  const oldKey = process.env.MOTION_OPENROUTER_API_KEY;
  process.env.MOTION_OPENROUTER_API_KEY = 'local-test-key';
  try { await handler(req, res); } finally { if (oldKey === undefined) delete process.env.MOTION_OPENROUTER_API_KEY; else process.env.MOTION_OPENROUTER_API_KEY = oldKey; }
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /2,000/);
});

test('revision carries the full previous implementation instead of silently truncating it', async () => {
  const longCode = '/*' + 'a'.repeat(21000) + '*/ const END_MARKER = 1;';
  const text = await request({engine:'remotion', prompt:'Adjust the blue', originalPrompt:original, previous:longCode});
  assert.ok(text.includes(longCode));
});

test('selected style adds its reference privately and preserves the user brief', async () => {
  const text = await request({engine:'remotion', prompt:original, style:'watercolor-wash'});
  assert.match(text, /Selected visual style/);
  assert.match(text, /Name: Watercolor Wash/);
  assert.match(text, /REFERENCE STYLE TECHNIQUES/);
  assert.match(text, /function deform\(/);
  assert.doesNotMatch(text, /How does AI learn\?/);
  assert.ok(text.includes(JSON.stringify(original)));
  assert.doesNotMatch(text, /STORYBOARD FIRST/);
  assert.doesNotMatch(text, /SOUND KIT \(lib\/sound\.js\)/);
});

test('all three styles include the corresponding visual reference on revisions', async () => {
  for (const [style, name] of [['flat-vector-science','Flat-Vector Science'], ['watercolor-wash','Watercolor Wash'], ['shadow-puppet-theatre','Shadow Puppet Theatre']]) {
    const text = await request({engine:'canvas', prompt:'Make it gentler', originalPrompt:original, previous, style});
    assert.ok(text.includes(`Name: ${name}`));
    assert.match(text, /Latest user change request: "Make it gentler"/);
    assert.doesNotMatch(text, /Private production plan/); // a revision keeps the current layout, no fresh plan
  }
});

test('rejects unrecognized style keys', async () => {
  const req = {method:'POST', headers:{host:'localhost:4173'}, async *[Symbol.asyncIterator]() { yield JSON.stringify({engine:'remotion', prompt:original, style:'../../.env.local'}); }};
  const res = {setHeader() {}, end(value) { this.body = value; }};
  const oldKey = process.env.MOTION_OPENROUTER_API_KEY;
  process.env.MOTION_OPENROUTER_API_KEY = 'local-test-key';
  try { await handler(req, res); } finally { if (oldKey === undefined) delete process.env.MOTION_OPENROUTER_API_KEY; else process.env.MOTION_OPENROUTER_API_KEY = oldKey; }
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Unknown video style/);
});

test('flat vector keeps the user-provided style and full visual drawing reference', async () => {
  const text = await request({engine:'remotion', prompt:original, style:'flat-vector-science'});
  assert.match(text, /Flat-Vector Science/);
  assert.match(text, /deep navy-to-violet space gradients/);
  assert.match(text, /function planet\(/);
  assert.match(text, /function robot\(/);
  assert.match(text, /selected style supersedes conflicting generic instructions/i);
  assert.match(text, /AI-learning example is not the user's script/);
  assert.doesNotMatch(text, /Do not draw planets, orbital rings/);
});


test('styled generation includes a validated, private production plan', async () => {
  const text = await request({engine:'remotion', prompt:original, style:'flat-vector-science'});
  assert.match(text, /Private production plan/);
  assert.match(text, /A prominent headline/);
  assert.match(text, /user brief takes priority/i);
});

test('rejects an invalid style plan instead of generating without it', async () => {
  const oldFetch = global.fetch, oldKey = process.env.MOTION_OPENROUTER_API_KEY;
  let calls = 0;
  process.env.MOTION_OPENROUTER_API_KEY = 'local-test-key';
  global.fetch = async () => { calls++; return {ok:true, text:async () => JSON.stringify({choices:[{finish_reason:'stop', message:{content:'{"duration":8,"beats":[]}'}}]})}; };
  const req = {method:'POST', headers:{host:'localhost:4173'}, async *[Symbol.asyncIterator]() {yield JSON.stringify({engine:'remotion', prompt:original, style:'flat-vector-science'});}};
  const res = {setHeader() {}, end(value) {this.body = value;}};
  try { await handler(req, res); } finally { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.MOTION_OPENROUTER_API_KEY; else process.env.MOTION_OPENROUTER_API_KEY = oldKey; }
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /plan needs another try/);
  assert.equal(calls, 2);
});


test('rejects a plan that puts a decorative rule through text', async () => {
  const oldFetch = global.fetch, oldKey = process.env.MOTION_OPENROUTER_API_KEY;
  let calls = 0;
  const plan = {duration:8,beats:[{start:0,end:4,visual:'Headline with a line',motion:'Reveal',text:[{content:'IDEAS',box:{x:0.2,y:0.4,w:0.6,h:0.1}}],decorations:[{x:0.1,y:0.45,w:0.8,h:0.01}]},{start:4,end:8,visual:'Final scene',motion:'Hold',text:[],decorations:[]}]};
  process.env.MOTION_OPENROUTER_API_KEY = 'local-test-key';
  global.fetch = async () => { calls++; return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan)}}]})}; };
  const req = {method:'POST',headers:{host:'localhost:4173'},async *[Symbol.asyncIterator](){yield JSON.stringify({engine:'remotion',prompt:original,style:'flat-vector-science'});}};
  const res = {setHeader(){},end(value){this.body=value}};
  try { await handler(req,res); } finally { global.fetch=oldFetch; if (oldKey === undefined) delete process.env.MOTION_OPENROUTER_API_KEY; else process.env.MOTION_OPENROUTER_API_KEY=oldKey; }
  assert.equal(res.statusCode,502);
  assert.match(JSON.parse(res.body).error,/must not overlap/);
  assert.equal(calls,2);
});

test('visual corrections receive the prior code and specific observed issues without replanning', async () => {
  const text = await request({engine:'remotion',prompt:'Make it clearer',originalPrompt:original,previous,style:'flat-vector-science',visualFeedback:'At 2 seconds a line crosses the subtitle.'});
  assert.match(text, /visual review of sampled frames/i);
  assert.match(text, /line crosses the subtitle/);
  assert.ok(text.includes(previous));
  assert.doesNotMatch(text, /Private production plan/);
});

test('retries a truncated animation once with a higher limit and includes both attempt costs', async () => {
  const oldFetch=global.fetch, oldKey=process.env.MOTION_OPENROUTER_API_KEY; const requests=[];
  process.env.MOTION_OPENROUTER_API_KEY='test';
  global.fetch=async (_url,init)=>{const body=JSON.parse(init.body);requests.push(body);return {ok:true,text:async()=>JSON.stringify({usage:{cost:requests.length===1?0.004:0.006},choices:[{finish_reason:requests.length===1?'length':'stop',message:{content:requests.length===1?'unfinished':'```js\nfunction Video() {}\n```'}}]})}};
  const req={method:'POST',headers:{host:'localhost:4173'},async *[Symbol.asyncIterator](){yield JSON.stringify({engine:'remotion',prompt:original})}};
  const res={setHeader(){},end(v){this.body=v}};
  try {await handler(req,res)} finally {global.fetch=oldFetch;if(oldKey===undefined)delete process.env.MOTION_OPENROUTER_API_KEY;else process.env.MOTION_OPENROUTER_API_KEY=oldKey}
  assert.equal(res.statusCode,200);assert.deepEqual(requests.map(x=>x.max_tokens),[24000,32000]);assert.equal(JSON.parse(res.body).usd,0.01);assert.ok(requests.every(x=>x.reasoning.effort==='medium'));
});

test('retries a truncated planning response before requesting animation code', async () => {
  const oldFetch=global.fetch, oldKey=process.env.MOTION_OPENROUTER_API_KEY; const requests=[];
  const plan={duration:8,beats:[{start:0,end:4,visual:'Headline',motion:'Move',text:[{content:'MAKE IT MOVE',box:{x:0.1,y:0.3,w:0.8,h:0.1}}],decorations:[]},{start:4,end:8,visual:'Finish',motion:'Hold',text:[],decorations:[]}]};
  process.env.MOTION_OPENROUTER_API_KEY='test';
  global.fetch=async (_url,init)=>{const body=JSON.parse(init.body);requests.push(body);const n=requests.length;return {ok:true,text:async()=>JSON.stringify({usage:{cost:0.001},choices:[{finish_reason:n===1?'length':'stop',message:{content:n===1?'unfinished':n===2?JSON.stringify(plan):'```js\nfunction Video() {}\n```'}}]})}};
  const req={method:'POST',headers:{host:'localhost:4173'},async *[Symbol.asyncIterator](){yield JSON.stringify({engine:'remotion',prompt:original,style:'flat-vector-science'})}};
  const res={setHeader(){},end(v){this.body=v}};
  try {await handler(req,res)} finally {global.fetch=oldFetch;if(oldKey===undefined)delete process.env.MOTION_OPENROUTER_API_KEY;else process.env.MOTION_OPENROUTER_API_KEY=oldKey}
  assert.equal(res.statusCode,200);assert.deepEqual(requests.map(x=>x.max_tokens),[3000,6000,24000]);assert.equal(JSON.parse(res.body).usd,0.003);
});

test('stops after one output-limit retry and reports the failed phase', async () => {
  const oldFetch=global.fetch, oldKey=process.env.MOTION_OPENROUTER_API_KEY;let calls=0;process.env.MOTION_OPENROUTER_API_KEY='test';
  global.fetch=async ()=>{calls++;return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'length',message:{content:'unfinished'}}]})}};
  const req={method:'POST',headers:{host:'localhost:4173'},async *[Symbol.asyncIterator](){yield JSON.stringify({engine:'remotion',prompt:original})}};
  const res={setHeader(){},end(v){this.body=v}};
  try {await handler(req,res)} finally {global.fetch=oldFetch;if(oldKey===undefined)delete process.env.MOTION_OPENROUTER_API_KEY;else process.env.MOTION_OPENROUTER_API_KEY=oldKey}
  assert.equal(calls,2);assert.equal(res.statusCode,502);assert.match(JSON.parse(res.body).error,/writing the animation/);
});
