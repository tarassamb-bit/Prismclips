const test = require('node:test');
const assert = require('node:assert/strict');
const {requestProvider} = require('./_motion-provider');
const response = (status, body) => ({status, ok:status>=200 && status<300, text:async()=>JSON.stringify(body)});

test('retries an HTTP 200 response carrying an upstream rate-limit error', async () => {
  const calls=[], sleeps=[];
  const fetcher=async (url,init)=>{calls.push({url,init});return calls.length===1?response(200,{error:{message:'temporarily rate-limited upstream'}}):response(200,{choices:[{message:{content:'ok'}}]});};
  const init={method:'POST',body:JSON.stringify({model:'openai/gpt-6.1-terra',provider:{zdr:true,data_collection:'deny'}})};
  const result=await requestProvider('https://example.invalid',init,{timeoutMs:1000,delays:[1,3],fetcher,sleep:async ms=>sleeps.push(ms)});
  assert.equal(calls.length,2);assert.deepEqual(sleeps,[1]);assert.equal(result.data.choices[0].message.content,'ok');assert.equal(calls[0].init.body,calls[1].init.body);
});

test('stops after bounded retries and gives a useful 429', async () => {
  let calls=0;const fetcher=async()=>{calls++;return response(429,{error:{message:'rate limited'}})};
  await assert.rejects(()=>requestProvider('https://example.invalid',{},{timeoutMs:1000,delays:[0,0],fetcher,sleep:async()=>{}}),{status:429,message:'The selected model is temporarily rate-limited by its provider. Please try again later.'});
  assert.equal(calls,3);
});

test('does not retry unrelated provider errors', async () => {
  let calls=0;const fetcher=async()=>{calls++;return response(401,{error:{message:'Invalid credentials'}})};
  const result=await requestProvider('https://example.invalid',{},{timeoutMs:1000,delays:[0,0],fetcher,sleep:async()=>{}});
  assert.equal(calls,1);assert.equal(result.response.status,401);
});


test('passes cancellation through without imposing a model deadline', async () => {
  const controller = new AbortController();
  let receivedSignal;
  const pending = requestProvider('https://example.invalid', {}, {signal:controller.signal, fetcher:async (_url, init) => {
    receivedSignal = init.signal;
    return await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {name:'AbortError'})), {once:true}));
  }});
  assert.equal(receivedSignal, controller.signal);
  controller.abort();
  await assert.rejects(pending, {status:499, message:'Request cancelled.'});
});

test('requests without a cancellation signal have no deadline', async () => {
  await requestProvider('https://example.invalid', {}, {fetcher:async (_url, init) => {
    assert.equal(init.signal, undefined);
    return response(200, {choices:[]});
  }});
});


test('retries a temporary provider disconnect using the same request', async () => {
  const calls = [], sleeps = [];
  const init = {method:'POST', body:'same request'};
  const fetcher = async (_url, request) => {
    calls.push(request);
    if (calls.length === 1) throw Object.assign(new Error('socket reset'), {code:'ECONNRESET'});
    return response(200, {choices:[{message:{content:'ok'}}]});
  };
  const result = await requestProvider('https://example.invalid', init, {fetcher, delays:[1,3], sleep:async ms => sleeps.push(ms)});
  assert.equal(result.data.choices[0].message.content, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(sleeps, [1]);
});

test('reports a connection failure after bounded retries', async () => {
  let calls = 0;
  await assert.rejects(requestProvider('https://example.invalid', {}, {fetcher:async () => {calls++; throw Object.assign(new Error('closed'), {code:'ECONNRESET'});}, delays:[0,0], sleep:async () => {}}), {status:502, message:'The connection to the model provider was interrupted after automatic retries. Please try again.'});
  assert.equal(calls, 3);
});
