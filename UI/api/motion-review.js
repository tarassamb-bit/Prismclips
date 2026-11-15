// Reviews only the generated video frames and user brief. Local development only.
const {HttpError, send, fail} = require('./_lib');
const {requestProvider, motionKey, PROVIDER, assertLocal, readJson, pickModel, reasoningFor, newTally, addUsage, logRun} = require('./_motion-provider');
const MODEL = process.env.MOTION_REVIEW_MODEL || 'xiaomi/mimo-v2.6-flash';
module.exports = async (req, res) => {
  let choice = null, tally = newTally(), started = Date.now();
  try {
    assertLocal(req);
    if (!motionKey()) throw new HttpError(503, 'The model key is missing.');
    const body = await readJson(req, 4_000_000);
    if (typeof body.brief !== 'string' || !body.brief.trim() || body.brief.length > 2000) throw new HttpError(400, 'A valid original brief is required.');
    if (!Array.isArray(body.frames) || body.frames.length < 3 || body.frames.length > 5 || body.frames.some(f => !f || !Number.isFinite(f.time) || typeof f.image !== 'string' || f.image.length > 600000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(f.image))) throw new HttpError(400, 'The video frames could not be reviewed.');
    if (body.reference !== undefined && (typeof body.reference !== 'string' || body.reference.length > 300000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(body.reference))) throw new HttpError(400, 'The style reference could not be reviewed.');
    choice = pickModel(body, MODEL);
    const cancellation = new AbortController();
    res.once?.('close', () => { if (!res.writableEnded) cancellation.abort(); });
    const changes = Array.isArray(body.history) ? body.history.filter(x => x?.role === 'user' && typeof x.content === 'string').slice(-8).map(x => x.content.slice(0,2000)) : [];
    if (typeof body.latest === 'string' && body.latest.trim() && body.latest !== body.brief && changes.at(-1) !== body.latest) changes.push(body.latest.slice(0,2000));
    async function inspectImage(text, image, maxTokens) {
      for(let attempt=0;attempt<2;attempt++) {
        const {response, data:payload} = await requestProvider('https://openrouter.ai/api/v1/chat/completions', {
          method:'POST',
          headers:{Authorization:`Bearer ${motionKey()}`,'Content-Type':'application/json','HTTP-Referer':'https://relioclips.com','X-Title':'Relio Clips'},
          body:JSON.stringify({model:choice.id, max_tokens:attempt ? maxTokens*2 : maxTokens, reasoning:reasoningFor(choice), provider:PROVIDER,messages:[{role:'user',content:[{type:'text',text},{type:'image_url',image_url:{url:image}}]}]}),
        }, {signal:cancellation.signal});
        if (!response.ok || !payload.choices?.length) throw new HttpError(502, `The visual review provider: ${payload.error?.message || `HTTP ${response.status}`}`);
        addUsage(tally, payload.usage);
        if (payload.choices[0].finish_reason === 'length') {
          if(attempt===0) continue;
          throw new HttpError(502, 'The visual review ran out of space before it finished.');
        }
        const content=String(payload.choices[0].message?.content || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
        if (!content) throw new HttpError(502, 'The visual review returned an empty result.');
        return {content};
      }
    }
    let styleDescription = '';
    if (body.reference) {
      const analysis = await inspectImage('Describe only the visual medium and rendering techniques of this style reference in 2–3 short sentences: colors, texture, shapes, shading and illustration quality. Do not repeat its subject, props, scene layout, or text. This describes a style, not a script.', body.reference, 1800);
      styleDescription = analysis.content.slice(0,1600);
    }
    const checks = await Promise.all(body.frames.map(async frame => {
      const instruction = `Inspect this single video frame at ${frame.time.toFixed(2)} seconds. Original brief: ${JSON.stringify(body.brief)}. Later user changes: ${JSON.stringify(changes)}. Selected style: ${JSON.stringify(String(body.style || 'default').slice(0,80))}.${styleDescription ? ` The style reference was described as: ${JSON.stringify(styleDescription)}.` : ''}
Check this exact frame for concrete visible issues: text cut off by the frame, a foreground line or shape crossing readable text, unrequested visible labels, a clearly unrelated visual subject, a clear mismatch with the requested illustration medium, main content that is small or bunched up while large parts of the frame stay empty, a headline too small to read on a phone, black bars or bands, half-faded or glitched content, or simple icons where the style calls for crafted illustration. A line crossing readable text is a defect. Do not report missing text merely because it appears in a different frame; do not infer motion, timing or unseen content. The user's subject, exact words and explicit colors take priority over the reference. Ignore minor stylistic differences. Return JSON only: {"issues":[]} if there is no obvious issue, or {"issues":["specific visible defect"]} with at most 3 short items.`;
      const result=await inspectImage(instruction,frame.image,2500);
      let parsed;try{parsed=JSON.parse(result.content)}catch{throw new HttpError(502,'The visual review returned an invalid result.');}
      if(!Array.isArray(parsed.issues)||parsed.issues.length>3||parsed.issues.some(x=>typeof x!=='string'||!x.trim()||x.length>500))throw new HttpError(502,'The visual review returned an invalid result.');
      return {issues:parsed.issues,time:frame.time};
    }));
    const seen=new Set(), issues=[];
    for(const check of checks){
      for(const issue of check.issues){const key=issue.trim().toLowerCase();if(seen.has(key))continue;seen.add(key);if(issues.length<3)issues.push(`At ${check.time.toFixed(1)}s: ${issue.trim()}`);}
    }
    const result={issues};
    const usd=tally.usdKnown?tally.usd:null;
    logRun({kind:'review', choice, tally, ms:Date.now()-started, frames:body.frames.length, issues:issues.length});
    choice=null;
    send(res,200,{issues:result.issues, usd});
  } catch (error) {
    if (choice) logRun({kind:'review', choice, tally, ms:Date.now()-started, failed:String(error.message || error).slice(0,200)});
    if (!res.destroyed) fail(res,error);
  }
};
