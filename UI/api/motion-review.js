// Reviews only the generated video frames and user brief. Local development only.
const {HttpError, send, fail} = require('./_lib');
const {requestProvider} = require('./_motion-provider');
const MODEL = process.env.MOTION_REVIEW_MODEL || 'xiaomi/mimo-v2.6-flash';
async function readJson(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 4_000_000) throw new HttpError(413, 'Video frames are too large to review.'); }
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid review request.'); }
}
module.exports = async (req, res) => {
  try {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || ''))) throw new HttpError(404, 'Not found.');
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
    if (!process.env.OPENROUTER_API_KEY) throw new HttpError(503, 'The model key is missing.');
    const body = await readJson(req);
    if (typeof body.brief !== 'string' || !body.brief.trim() || body.brief.length > 2000) throw new HttpError(400, 'A valid original brief is required.');
    if (!Array.isArray(body.frames) || body.frames.length < 3 || body.frames.length > 5 || body.frames.some(f => !f || !Number.isFinite(f.time) || typeof f.image !== 'string' || f.image.length > 600000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(f.image))) throw new HttpError(400, 'The video frames could not be reviewed.');
    if (body.reference !== undefined && (typeof body.reference !== 'string' || body.reference.length > 300000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(body.reference))) throw new HttpError(400, 'The style reference could not be reviewed.');
    const cancellation = new AbortController();
    res.once?.('close', () => { if (!res.writableEnded) cancellation.abort(); });
    const changes = Array.isArray(body.history) ? body.history.filter(x => x?.role === 'user' && typeof x.content === 'string').slice(-8).map(x => x.content.slice(0,2000)) : [];
    if (typeof body.latest === 'string' && body.latest.trim() && body.latest !== body.brief && changes.at(-1) !== body.latest) changes.push(body.latest.slice(0,2000));
    async function inspectImage(text, image, maxTokens) {
      let cost=0, costKnown=true;
      for(let attempt=0;attempt<2;attempt++) {
        const {response, data:payload} = await requestProvider('https://openrouter.ai/api/v1/chat/completions', {
          method:'POST',
          headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://relioclips.com','X-Title':'Relio Clips'},
          body:JSON.stringify({model:MODEL, max_tokens:attempt ? maxTokens*2 : maxTokens, reasoning:{effort:'medium',exclude:true}, provider:{zdr:true,data_collection:'deny',sort:'latency'},messages:[{role:'user',content:[{type:'text',text},{type:'image_url',image_url:{url:image}}]}]}),
        }, {signal:cancellation.signal});
        if (!response.ok || !payload.choices?.length) throw new HttpError(502, `The visual review provider: ${payload.error?.message || `HTTP ${response.status}`}`);
        if(payload.usage?.cost == null) costKnown=false; else cost+=payload.usage.cost;
        if (payload.choices[0].finish_reason === 'length') {
          if(attempt===0) continue;
          throw new HttpError(502, 'The visual review ran out of space before it finished.');
        }
        const content=String(payload.choices[0].message?.content || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
        if (!content) throw new HttpError(502, 'The visual review returned an empty result.');
        return {content,usd:costKnown?cost:null};
      }
    }
    let styleDescription = '', reviewCost = 0, costKnown = true;
    if (body.reference) {
      const analysis = await inspectImage('Describe only the visual medium and rendering techniques of this style reference in 2–3 short sentences: colors, texture, shapes, shading and illustration quality. Do not repeat its subject, props, scene layout, or text. This describes a style, not a script.', body.reference, 1800);
      styleDescription = analysis.content.slice(0,1600);
      if (analysis.usd == null) costKnown = false; else reviewCost += analysis.usd;
    }
    const checks = await Promise.all(body.frames.map(async frame => {
      const instruction = `Inspect this single video frame at ${frame.time.toFixed(2)} seconds. Original brief: ${JSON.stringify(body.brief)}. Later user changes: ${JSON.stringify(changes)}. Selected style: ${JSON.stringify(String(body.style || 'default').slice(0,80))}.${styleDescription ? ` The style reference was described as: ${JSON.stringify(styleDescription)}.` : ''}
Check this exact frame for concrete visible issues: text cut off by the frame, a foreground line or shape crossing readable text, unrequested visible labels, a clearly unrelated visual subject, or a clear mismatch with the requested illustration medium. A line crossing readable text is a defect. Do not report missing text merely because it appears in a different frame; do not infer motion, timing or unseen content. The user's subject, exact words and explicit colors take priority over the reference. Ignore minor stylistic differences. Return JSON only: {"issues":[]} if there is no obvious issue, or {"issues":["specific visible defect"]} with at most 3 short items.`;
      const result=await inspectImage(instruction,frame.image,2500);
      let parsed;try{parsed=JSON.parse(result.content)}catch{throw new HttpError(502,'The visual review returned an invalid result.');}
      if(!Array.isArray(parsed.issues)||parsed.issues.length>3||parsed.issues.some(x=>typeof x!=='string'||!x.trim()||x.length>500))throw new HttpError(502,'The visual review returned an invalid result.');
      return {issues:parsed.issues,time:frame.time,usd:result.usd};
    }));
    const seen=new Set(), issues=[];
    for(const check of checks){
      if(check.usd==null)costKnown=false;else reviewCost+=check.usd;
      for(const issue of check.issues){const key=issue.trim().toLowerCase();if(seen.has(key))continue;seen.add(key);if(issues.length<3)issues.push(`At ${check.time.toFixed(1)}s: ${issue.trim()}`);}
    }
    const result={issues};
    const usd=costKnown?reviewCost:null;
    send(res,200,{issues:result.issues, usd});
  } catch (error) {if (!res.destroyed) fail(res,error);}
};
