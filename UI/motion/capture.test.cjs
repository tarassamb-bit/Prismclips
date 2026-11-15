const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('canvas review captures five frames without changing the current preview time', async () => {
  const source = fs.readFileSync(__dirname + '/motion.js', 'utf8');
  const literal = source.match(/const canvasRunner = \(\) => (`[\s\S]*?`);/)[1];
  const runner = vm.runInNewContext(literal, {W:1920,H:1080,Math});
  // The capture frames keep the format's shape (here 16:9), at two thirds of its size.
  assert.match(runner, /capture\.width = 1280; capture\.height = 720;/);
  const script = runner.slice(runner.indexOf('<script>') + 8, runner.lastIndexOf('</script>'));
  const sent = [], drawn = [];
  const ctx = {save(){},restore(){},setTransform(){},clearRect(){},drawImage(){}};
  const canvas = {getContext(){return ctx},toDataURL(){return 'data:image/jpeg;base64,YWJj'}};
  const document = {getElementById(){return canvas},createElement(){return {...canvas}}};
  let listener;
  const context = {document,parent:{postMessage(message){sent.push(message)}},addEventListener(name,fn){if(name==='message')listener=fn},performance:{now(){return 0}},requestAnimationFrame(){},Math,Number,String,Error,createImageBitmap(){}};
  vm.runInNewContext(script,context);
  context.drawn = drawn;
  await listener({data:{type:'load',code:'const scene = {fps:30,duration:4,draw(ctx,t){ globalThis.drawn.push(t); }};'}});
  assert.equal(sent[0]?.type, 'ready', JSON.stringify(sent));
  sent.length=0; drawn.length=0;
  await listener({data:{type:'capture-review',requestId:42}});
  assert.equal(sent[0].type,'review-frames');
  assert.equal(sent[0].requestId,42);
  assert.equal(sent[0].frames.length,5);
  assert.equal(drawn.length,6); // five samples, then restore the current frame
  assert.equal(drawn.at(-1),0);
});
