const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');

// Exercise the real ready-message handler with deterministic review results.
function harness(reviews) {
  const source=fs.readFileSync(__dirname+'/motion.js','utf8');
  const start=source.lastIndexOf("addEventListener('message', async (event) => {");
  const end=source.indexOf('\n\n/** Plays the HTML engine',start);
  assert.ok(start>=0&&end>start);
  const listeners={}, elements=new Map(), messages=[], corrections=[], saves=[];
  function $(selector){if(!elements.has(selector))elements.set(selector,{hidden:false,value:'',textContent:'',setAttribute(){},removeAttribute(){}});return elements.get(selector)}
  const player={contentWindow:{postMessage(){}}};
  const context={console,Number,Boolean,String,Math,Error,URL:{revokeObjectURL(){}},clearTimeout(){},
    addEventListener(name,fn){listeners[name]=fn},player,frameRequest:null,runToken:1,previewTimeout:0,
    scene:null,$,formatTime:()=> '0:04',updatePlayback(){},downloadUrl:null,restoring:false,
    reviewPass:0,engine:'canvas',code:'old code',pendingBrief:{originalPrompt:'Original idea',history:[],style:'flat-vector-science',request:'Original idea',isRevision:false},
    originalPrompt:'',history:[],lastGood:null,repaired:false,prompt:'Original idea',exporter:null,
    hideThinking(){},setBusy(){},showThinking(){},setStatus(){},addAssistantMessage(text){messages.push(text)},
    captureReviewFrames:async()=>['sample'],captureStyleReference:async()=> 'reference',
    reviewFrames:async()=>reviews.shift(),generate:async data=>{corrections.push(data);return {code:'corrected code'}},
    run(source){context.code=source;context.runToken++},recoverPreview(){throw Error('unexpected recovery')},
    playHtml(){},exportFailed(){},opening:false,reviewThumb:null,saveVideo(){saves.push(context.lastGood.code)},};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  return {context,listener:listeners.message,messages,corrections,saves};
}

test('visually checks, corrects once, then checks the corrected video',async()=>{
  const h=harness([['line crosses the title'],[]]);
  await h.listener({source:h.context.player.contentWindow,data:{type:'ready',fps:30,duration:4}});
  assert.equal(h.corrections.length,1);assert.match(h.corrections[0].visualFeedback,/line crosses/);assert.equal(h.context.code,'corrected code');assert.equal(h.messages.length,0);
  await h.listener({source:h.context.player.contentWindow,data:{type:'ready',fps:30,duration:4}});
  assert.equal(h.corrections.length,1);assert.match(h.messages[0],/Your video is ready\. Watch it/);assert.equal(h.context.lastGood.code,'corrected code');
  // The accepted video, and only it, is saved as a project.
  assert.deepEqual(h.saves,['corrected code']);
});

test('does not loop when the reviewer still finds an issue after the correction',async()=>{
  const h=harness([['line crosses the title'],['line still crosses the title']]);
  await h.listener({source:h.context.player.contentWindow,data:{type:'ready',fps:30,duration:4}});
  await h.listener({source:h.context.player.contentWindow,data:{type:'ready',fps:30,duration:4}});
  assert.equal(h.corrections.length,1);assert.match(h.messages[0],/may need fixing/);
});

test('reports when reference rendering fails instead of claiming a visual review',async()=>{
  const h=harness([]);
  h.context.captureStyleReference=async()=>{throw Error('The style reference could not be drawn.')};
  await h.listener({source:h.context.player.contentWindow,data:{type:'ready',fps:30,duration:4}});
  assert.equal(h.corrections.length,0);assert.match(h.messages[0],/couldn’t finish checking how it looks/);
});

test('the composer exposes one style choice and no engine picker',()=>{
  const html=fs.readFileSync(__dirname+'/index.html','utf8');
  assert.match(html,/<select id="style"/);
  assert.doesNotMatch(html,/<select id="engine"/);
  assert.match(html,/<input id="engine" type="hidden" value="canvas">/);
});
