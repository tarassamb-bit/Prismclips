const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('./motion-review');
async function request(body, reply) {
  const oldFetch=global.fetch, oldKey=process.env.OPENROUTER_API_KEY; let upstream; const upstreams=[];
  process.env.OPENROUTER_API_KEY='test';
  global.fetch=async (_url, init)=>{assert.equal(init.headers['X-Title'],'Relio Clips');upstream=JSON.parse(init.body);upstreams.push(upstream);return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(reply)}}]})}};
  const req={method:'POST',headers:{host:'localhost:4173'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}};
  const res={setHeader(){},end(value){this.body=value}};
  try {await handler(req,res)} finally {global.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey}
  return {res,upstream,upstreams};
}
const frames=[0,1,2].map(time=>({time,image:'data:image/jpeg;base64,YWJj'}));
test('sends sampled frames and actual brief for visual review',async()=>{
  const {res,upstream,upstreams}=await request({brief:'Show the words IDEAS IN MOTION',latest:'Make it clearer',history:[],frames},{issues:['The line crosses the title.']});
  assert.equal(res.statusCode,200);assert.deepEqual(JSON.parse(res.body).issues,['At 0.0s: The line crosses the title.']);
  assert.equal(upstreams.length,3);assert.ok(upstreams.every(u=>u.messages[0].content.filter(part=>part.type==='image_url').length===1));
  assert.match(upstream.messages[0].content[0].text,/IDEAS IN MOTION/);
  assert.equal(upstream.provider.zdr,true);
  assert.equal(upstream.model, process.env.MOTION_REVIEW_MODEL || 'xiaomi/mimo-v2.6-flash');
  assert.equal(upstream.reasoning.effort,'medium');
});
test('rejects invalid frame payload before any provider call',async()=>{
  const {res,upstream}=await request({brief:'A title',frames:[{time:1,image:'https://example.com'}]},{issues:[]});
  assert.equal(res.statusCode,400);assert.equal(upstream,undefined);
});
test('rejects a malformed review instead of claiming success',async()=>{
  const {res}=await request({brief:'A title',frames},{issues:'fine'});
  assert.equal(res.statusCode,502);
});
test('includes a selected style reference as a separate image',async()=>{
  const reference='data:image/jpeg;base64,ZGVm';
  const {res,upstreams}=await request({brief:'A title',style:'watercolor-wash',frames,reference},{issues:[]});
  assert.equal(res.statusCode,200);
  assert.equal(upstreams.length,4);
  assert.equal(upstreams[0].messages[0].content[1].image_url.url,reference);
  assert.match(upstreams[0].messages[0].content[0].text,/style reference/);
  assert.ok(upstreams.slice(1).every(u=>u.messages[0].content.filter(part=>part.type==='image_url').length===1));
});
test('rejects an external style-reference URL',async()=>{
  const {res,upstream}=await request({brief:'A title',frames,reference:'https://example.com/reference.jpg'},{issues:[]});
  assert.equal(res.statusCode,400);assert.equal(upstream,undefined);
});
