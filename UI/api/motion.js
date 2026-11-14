// Relio Motion (dev only): the configured model writes a motion-graphics scene from a prompt. Answers only on localhost, with
// the Motion key (MOTION_OPENROUTER_API_KEY, see _motion-provider.js); the live site refuses, so nothing here costs money or leaks a key in production.
//   POST { prompt, engine, originalPrompt?, history?, previous?, error? } -> { code }
const { HttpError, send, fail } = require('./_lib');
const {requestProvider, motionKey, PROVIDER, assertLocal, readJson, pickModel, reasoningFor, newTally, addUsage, logRun} = require('./_motion-provider');
const fs = require('fs');
const path = require('path');

const STYLE_FILES = Object.freeze({
  'flat-vector-science': {file:'flat-vector-science.txt', name:'Flat-Vector Science', useFullVisualReference:true},
  'watercolor-wash': {file:'watercolor-wash.txt', name:'Watercolor Wash', look:'Translucent layered pigment on textured cold-press paper, with soft edges, subtle pooling, natural blooms and faint pencil detail. Reveal paint with gentle organic motion. Use only illustrations that fit the user’s subject.', extracts:[['  function deform(', '  function cachedExplainer(']]},
  'shadow-puppet-theatre': {file:'shadow-puppet-theatre.txt', name:'Shadow Puppet Theatre', look:'A backlit textured cloth stage with dark cut-paper silhouettes, fine cutwork and warm amber light. Animate subject-appropriate silhouettes with physical, jointed motion and a gently breathing light. Do not introduce reference characters or props unless the subject calls for them.', extracts:[['  const STOPS =', '  function valance(']]},
});

function styleReference(style) {
  if (!style) return '';
  const config = STYLE_FILES[style];
  const text = fs.readFileSync(path.join(__dirname, '_motion-styles', config.file), 'utf8');
  const referenceStart = text.indexOf('REFERENCE STYLE SOURCE');
  if (referenceStart < 0) throw new Error('The selected style reference is incomplete.');
  const reference = text.slice(referenceStart);
  if (config.useFullVisualReference) {
    const cardStart = text.indexOf('STYLE CARD');
    const helperStart = text.indexOf('H HELPER LIBRARY');
    const soundStart = text.indexOf('SOUND KIT');
    const soundMethod = reference.indexOf('    explainerSound(k)');
    if (cardStart < 0 || helperStart < 0 || soundStart < 0 || soundMethod < 0) throw new Error('The selected style reference is incomplete.');
    const card = text.slice(cardStart, helperStart);
    const helpers = text.slice(helperStart, soundStart);
    const visual = reference.slice(0, soundMethod);
    return `Selected visual style: the following user-supplied style card and original visual reference are the primary visual direction. Follow the reference’s vivid space gradients, rounded dimensional illustration, playful appealing characters, glow, texture, big scale changes and animation energy, where they suit the user’s topic. The selected style supersedes conflicting generic instructions to avoid stars, gradients, characters, or playful elements. Respect any specific style or color choices in the user's request. Use the user’s own subject and words: the reference’s AI-learning example is not the user's script. Do not reproduce its claims or add labels and captions the user did not request. Interpret its example props as visual inspiration, not mandatory content.\n\nThe reference code is written for a different canvas harness and aspect ratio. Adapt its visual and animation techniques to the requested engine, dimensions, and brief; do not emit its player, registry, storyboard, sound kit or sample script. Inline or reimplement any helpers you need.\n\n${card}\n\n${helpers}\n\n${visual}\n\nEnd of reference excerpt.`;
  }
  const excerpts = config.extracts.map(([start, end]) => {
    const from = reference.indexOf(start);
    const to = reference.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error('The selected style reference is incomplete.');
    return reference.slice(from, to).split('\n').filter((line) => !line.includes('How does AI learn?')).join('\n').trim();
  });
  return `Selected visual style (takes priority over generic editorial defaults; explicit user choices still take priority):\nName: ${config.name}\n${config.look}\n\nThe following snippets from the user-provided style reference show medium-specific techniques. They are not a template for content. Adapt them to the requested subject and engine, rather than copying example props, labels, layout or subject. If code relies on H or other helpers, implement only the necessary pieces in the generated code. Do not produce a storyboard, external assets, sound, a player, or a different aspect ratio.\n\nREFERENCE STYLE TECHNIQUES:\n${excerpts.join('\n\n')}`;
}

const MODEL = process.env.MOTION_MODEL || 'xiaomi/mimo-v2.6-flash';

// Shared creative direction gives each engine the same brand and visual standards. A user's explicit
// creative choices always win; the defaults apply only when the brief leaves them open.
// The frame sizes a video can have. The instructions below are written for 9:16; forFormat rewrites them for the others.
const FORMATS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '3:4': [1080, 1440] };
function forFormat(text, format = '9:16') {
  if (format === '9:16') return text;
  const [w, h] = FORMATS[format];
  return text.replaceAll('1080x1920', `${w}x${h}`).replaceAll('width: 1080, height: 1920', `width: ${w}, height: ${h}`)
    .replaceAll('data-width="1080"', `data-width="${w}"`).replaceAll('data-height="1920"', `data-height="${h}"`).replaceAll('9:16', format)
    .replace('Design for a small vertical screen', `Design for a ${w}x${h} (${format}) frame and use its whole shape`)
    .replace('at least 120 px from each side and 220 px from top and bottom', `at least ${Math.round(w * 0.08)} px from each side and ${Math.round(h * 0.08)} px from top and bottom`);
}

const ART_DIRECTION = `Creative direction:
- Follow the user's requested subject, mood, duration, colors and exact wording. When the user provides exact on-screen wording, use only those words: do not invent taglines, section headings, corner labels, footer text, filler labels, issue numbers, dates, or additional captions unless asked. Before returning code, check every piece of visible text against the user’s requested copy and remove any other visible words. If no on-screen words are provided, invent only a few short, relevant words when the concept calls for them; never display the user's instructions as the script and never invent claims, prices, testimonials, or logos.
- For an open-ended Relio-branded brief, use a contemporary editorial style: near-black #1a1c22 or warm off-white #f3f0e9, sky blue #3fa9f5 as the main accent, and coral #ff8a79 or amber #ffc233 sparingly. Prefer one dominant accent per scene. Use a clean geometric sans-serif similar to Space Grotesk, with a system sans-serif fallback.
- First plan a visual story: a compelling first frame, a clear development, and a resolved final frame. Start with the primary subject or headline already visible at frame 0; do not begin with a blank screen, a thin line, a loading symbol, or a fade from black. Use 2–4 intentional scenes for a typical 8–12 second video, but respect a different requested duration or structure. Each scene needs a distinct layout or focal point and a meaningful connection to the subject. Avoid defaulting to floating shapes, decorative particles, neon gradients, or a stack of generic titles. Do not use stick figures, simplistic smiley faces, or unrelated symbols unless specifically requested. Create visuals that communicate the actual subject using polished typography, visual metaphors, and detailed self-contained graphic compositions; abstract shapes should support an idea rather than stand in for one.
- Design for a small vertical screen: prioritize one idea per scene, few words at once, strong contrast, large type, consistent alignment and generous negative space. Keep important text and graphics within the central area, at least 120 px from each side and 220 px from top and bottom. Use wrapping or responsive sizing for long text; never crop important copy.
- Give copy enough time to read and hold the resolved frame before changing scenes. Ensure there is a clear focal point on every frame; keep the outgoing scene visible until the next scene is visible, with no accidental empty gaps. Vary the pace with purposeful eased movement, smooth transitions, and subtle motion; avoid constant bouncing or moving everything at once. Resolve every transition so old text does not overlap new text unintentionally.
- Prefer a few polished elements over a busy composition. Use a consistent grid, intentional scale, and a coherent palette throughout. Do not claim to have used images, footage, music or voiceover when those assets are unavailable.`;

const RULES = {
  remotion: `Write a Remotion React video composition as JavaScript with JSX, not a complete web page.
- Do not write imports, exports, markdown prose, network requests, external assets or libraries. React and Remotion are provided as globals.
- Define const durationInFrames = 300 (or another integer between 120 and 450) and function Video() { ... }.
- Access Remotion APIs as Remotion.useCurrentFrame(), Remotion.useVideoConfig(), Remotion.interpolate(), Remotion.spring(), Remotion.AbsoluteFill, Remotion.Sequence. Use React.createElement or JSX.
- 1080x1920, 30fps. Animate deterministically from the current frame. No CSS animation, timers, random, DOM access or video/audio.
- The host provides fonts "Space Grotesk" and "Sora" and optional React components Relio.Logo({size, style}), Relio.ShortCard({width, heading, caption, style}), and Relio.CaptionBars({width, color, style}). Use these only when appropriate to the user’s subject; avoid inventing branding.
- Keep the composition entirely self-contained and fully deterministic.`,
  hyperframes: `Write a complete HTML document for a 1080x1920 HyperFrames video composition. GSAP and the HyperFrames runtime are injected by the host; do not import any scripts or assets.
- The host provides the fonts "Space Grotesk" and "Sora".
- The root element must have data-composition-id="main", data-start="0", data-width="1080", data-height="1920", and data-duration of 4 to 15 seconds.
- Each timed element has class="clip", data-start, data-duration and data-track-index. Use unique IDs.
- Create a paused gsap.timeline({paused:true}), animate with absolute timeline positions, and register it as window.__timelines = {main: tl}. Add a tween at the end if necessary to make the timeline match the composition duration.
- No network requests, DOM access outside this composition, external assets, CSS animations, timers, randomness, video or audio.
- Keep the composition entirely self-contained and fully deterministic.`,
  canvas: `Write one JavaScript program that defines a constant named scene, exactly in this shape:
const scene = { width: 1080, height: 1920, fps: 30, duration: SECONDS, draw(ctx, t) { ... } };
- duration is between 4 and 15 seconds. draw(ctx, t) paints the whole frame at time t seconds with the Canvas 2D API.
- Deterministic: the same t always draws the same frame. No Math.random (write a small seeded random if needed), no Date,
  no requestAnimationFrame, no setTimeout, no fetch, no DOM, no images, no external libraries.
- Paint the full background every frame. Fonts: "Helvetica Neue", Arial, system-ui only.
- Measure each line with ctx.measureText, wrap where needed, and scale the type to fit inside the safe area.`,
  html: `Write one complete HTML document (<!doctype html> ... </html>) for a 1080x1920 motion-graphics video.
- Load GSAP only from https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js. Build ONE paused gsap.timeline() and
  assign it to window.timeline. Its total duration (4 to 15 seconds) is the video length. Never call play().
- Everything visible is driven by that timeline, so seeking it to any time shows that exact frame. No CSS animations,
  no transitions, no setTimeout, no requestAnimationFrame, no Math.random, no video or audio, no images from the web.
- body is exactly 1080x1920 px, margin 0, overflow hidden, with its own background. Fonts: "Helvetica Neue", Arial, system-ui.
- Keep the composition fully deterministic and preserve the safe area around important content.`,
};

function prompt({ prompt: idea, engine, previous, error, originalPrompt, history, style, creativePlan, visualFeedback }) {
  const latest = String(idea || '').slice(0, 2000);
  const original = typeof originalPrompt === 'string' && originalPrompt.trim()
    ? originalPrompt.slice(0, 2000) : latest;
  // Only prior user-authored requests are context. Never treat an assistant reply as
  // the user's brief. Keep the original even when pruning a long conversation.
  const earlier = Array.isArray(history) ? history
    .filter((entry) => entry && entry.role === 'user' && typeof entry.content === 'string' && entry.content.trim())
    .map((entry) => entry.content.slice(0, 2000))
    .slice(-10) : [];
  if (earlier[0]?.trim() === original.trim()) earlier.shift();
  if (earlier.at(-1)?.trim() === latest.trim()) earlier.pop();
  const feedback = earlier.length ? `\nEarlier user changes (oldest first):\n${earlier.map((item, i) => `${i + 1}. ${JSON.stringify(item)}`).join('\n')}` : '';
  const hasRevision = original.trim() !== latest.trim() || earlier.length > 0;
  const request = hasRevision
    ? `Original creative brief: ${JSON.stringify(original)}${feedback}\nLatest user change request: ${JSON.stringify(latest)}\n\nRevision instructions:
- The original creative brief remains in force, including its subject, wording, duration and style. Apply subsequent user changes in order; a later specific instruction overrides the earlier one only where they conflict.
- Treat qualitative feedback such as "make it 1000x better" as a request for higher design quality, not as text to display, a numeric frame rate, a product name, or a literal visual element. Never add labels, captions, claims, or numbers from feedback unless the user specifically asks to show them.
- If the user supplied exact on-screen copy, retain it exactly and do not add or alter copy unless a later user instruction specifically requests a change. Treat the previous code as editable implementation, not authority for invented text; remove unrequested labels, captions, and claims from it.
- For vague quality feedback, make concrete visual and motion-design improvements while preserving the brief: refine composition, scale, contrast, transitions and pacing, rather than adding filler.\n${previous ? '' : '- Recreate the video for this engine using the original brief and user changes; no prior implementation was provided.'}`
    : `Original creative brief: ${JSON.stringify(original)}`;
  const review = visualFeedback ? `\n\nA visual review of sampled frames found these specific defects. Correct them while preserving the user’s actual brief and requested style; do not introduce new text or change unrelated content: ${JSON.stringify(visualFeedback)}` : '';
  const codeContext = previous
    ? `\n\n${error ? `The current implementation failed with this error: ${JSON.stringify(String(error).slice(0, 800))}\nCorrect the failure while preserving the user's brief and changes.\n` : 'Revise the current implementation according to the latest request.\n'}Current implementation (may contain mistakes or invented text):\n${String(previous)}\nReturn the whole corrected implementation.`
    : '';
  return `${RULES[engine]}\n\n${ART_DIRECTION}\n\n${styleReference(style)}\n\nReturn only the complete code, in one fenced code block. Keep the implementation concise and avoid lengthy comments.\n\n${request}${creativePlan ? `\n\nPrivate production plan (not on-screen copy; the user brief takes priority). Keep each text block fully inside its planned box for its entire visible lifetime, including entrances and exits. Do not cross text with a line or foreground graphic, and do not crop text. Follow the planned positions and spacing:\n${creativePlan}` : ''}${review}${codeContext}`;
}

/** The code inside the answer's first fenced block, or the whole answer when there is none. */
function extractCode(text) {
  const match = /```[a-z]*\n([\s\S]*?)```/i.exec(text);
  return (match ? match[1] : text).trim();
}

// Validate the proposed composition before asking the model to implement it.
// Coordinates are normalized to the output frame; backgrounds are not decorations.
function validatePlan(plan) {
  const beats = plan?.beats, duration = plan?.duration;
  if (!Number.isFinite(duration) || duration < 4 || duration > 15 || !Array.isArray(beats) || beats.length < 2 || beats.length > 4) return 'Use 2–4 beats and a duration from 4 to 15 seconds.';
  const validBox = (b) => b && ['x','y','w','h'].every((key) => Number.isFinite(b[key])) && b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1 && b.y + b.h <= 1;
  const overlap = (a, b, gap = 0) => a.x - gap < b.x + b.w && a.x + a.w + gap > b.x && a.y - gap < b.y + b.h && a.y + a.h + gap > b.y;
  let end = 0;
  for (const beat of beats) {
    if (!beat || !Number.isFinite(beat.start) || !Number.isFinite(beat.end) || beat.end <= beat.start || Math.abs(beat.start - end) > 0.001 || typeof beat.visual !== 'string' || !beat.visual.trim() || typeof beat.motion !== 'string' || !beat.motion.trim() || !Array.isArray(beat.text) || !Array.isArray(beat.decorations)) return 'Provide continuous beats with visual, motion, text and decorations.';
    for (const text of beat.text) {
      const b = text?.box;
      if (typeof text?.content !== 'string' || !text.content.trim() || !validBox(b) || b.x < 0.06 || b.y < 0.08 || b.x + b.w > 0.94 || b.y + b.h > 0.92) return 'Keep every text box completely inside the safe area (x 0.06–0.94, y 0.08–0.92).';
    }
    if (beat.decorations.some((box) => !validBox(box))) return 'Use valid normalized boxes for foreground decorations.';
    for (let i = 0; i < beat.text.length; i++) {
      const b = beat.text[i].box;
      if (beat.text.slice(i + 1).some((other) => overlap(b, other.box, 0.015)) || beat.decorations.some((decoration) => overlap(b, decoration, 0.015))) return 'Text boxes must not overlap one another or foreground graphics; leave at least 0.015 frame width and height of space.';
    }
    end = beat.end;
  }
  return Math.abs(end - duration) > 0.001 ? 'The last beat must end at the video duration.' : '';
}

class OutputLimitError extends Error {}

async function callModel(instruction, maxTokens, signal, pick, tally) {
    const {response, data:answer} = await requestProvider('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST',
      headers:{Authorization:`Bearer ${motionKey()}`, 'Content-Type':'application/json', 'HTTP-Referer':'https://relioclips.com', 'X-Title':'Relio Clips'},
      body:JSON.stringify({model:pick.id, max_tokens:maxTokens, reasoning:reasoningFor(pick), provider:PROVIDER, messages:[{role:'user',content:instruction}]}),
    }, {signal});
    if (!response.ok || !answer.choices?.length) throw new HttpError(502, `The model provider: ${answer.error?.message || `HTTP ${response.status}`}`);
    addUsage(tally, answer.usage);
    const choice = answer.choices[0];
    const content = choice.message?.content ?? '';
    const code = extractCode(content);
    console.log(JSON.stringify({ motion: true, finish: choice.finish_reason, contentChars: (choice.message?.content ?? '').length, reasoningChars: (choice.message?.reasoning ?? '').length, completion: answer.usage?.completion_tokens }));
    if (choice.finish_reason === 'length') throw new OutputLimitError('Model output limit reached');
    if (!code) throw new HttpError(502, 'The model returned an empty response. Please try again.');
    return {code, model: answer.model, provider: answer.provider};
}

// A length stop can happen during either the plan or the code. Retry once with a
// modestly larger ceiling; it is a ceiling, so short outputs do not cost more.
async function callWithLengthRetry(instruction, firstLimit, retryLimit, phase, signal, choice, tally) {
  try { return await callModel(instruction, firstLimit, signal, choice, tally); }
  catch (error) {
    if (!(error instanceof OutputLimitError)) throw error;
    try {
      return await callModel(`${instruction}\n\nComplete the entire response. Keep it concise and avoid repetitive code or commentary.`, retryLimit, signal, choice, tally);
    } catch (retryError) {
      if (retryError instanceof OutputLimitError) throw new HttpError(502, `The model ran out of space while ${phase}, even after a retry. Try a simpler request.`);
      throw retryError;
    }
  }
}

module.exports = async (req, res) => {
  let run = null;
  try {
    assertLocal(req);
    if (!motionKey()) throw new HttpError(503, 'Add MOTION_OPENROUTER_API_KEY to ~/.config/relio-motion/.env (the Motion key, not the Relio Clips one).');
    const body = await readJson(req, 200_000);
    if (!Object.hasOwn(RULES, body.engine)) throw new HttpError(400, 'Unknown engine.');
    if (body.style !== undefined && body.style !== '' && !Object.hasOwn(STYLE_FILES, body.style)) throw new HttpError(400, 'Unknown video style.');
    if (body.format !== undefined && !Object.hasOwn(FORMATS, body.format)) throw new HttpError(400, 'Unknown video format.');
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new HttpError(400, 'Describe the video first.');
    if (body.prompt.length > 2000) throw new HttpError(400, 'Keep your message to 2,000 characters or fewer.');
    if (typeof body.originalPrompt === 'string' && body.originalPrompt.length > 2000) throw new HttpError(400, 'Keep the original brief to 2,000 characters or fewer.');
    if (body.visualFeedback !== undefined && (typeof body.visualFeedback !== 'string' || body.visualFeedback.length > 2000 || !body.previous)) throw new HttpError(400, 'Invalid visual review feedback.');
    if (body.previous != null && (typeof body.previous !== 'string' || body.previous.length > 100000)) throw new HttpError(413, 'The existing video code is too large to revise.');
    const choice = pickModel(body, MODEL), tally = newTally();
    // Planning can use its own model (the page's per-step defaults); without one it uses the code model.
    if (body.plan !== undefined && (typeof body.plan !== 'object' || body.plan === null)) throw new HttpError(400, 'Invalid planning model.');
    const planChoice = body.plan ? pickModel(body.plan, choice.id) : choice, planTally = newTally();
    const cancellation = new AbortController();
    res.once?.('close', () => { if (!res.writableEnded) cancellation.abort(); });
    const started = Date.now();
    run = {kind: body.visualFeedback ? 'correction' : body.error ? 'repair' : body.previous ? 'revision' : 'generation', choice, tally, started, style: body.style || null};
    let planResult = null;
    if (body.style && !body.previous) {
      const config = STYLE_FILES[body.style];
      const reference = fs.readFileSync(path.join(__dirname, '_motion-styles', config.file), 'utf8');
      const styleCard = reference.slice(reference.indexOf('STYLE CARD'), reference.indexOf('H HELPER LIBRARY'));
      const earlier = Array.isArray(body.history) ? body.history.filter((item) => item?.role === 'user' && typeof item.content === 'string').slice(-8).map((item) => item.content.slice(0, 2000)) : [];
      const planningPrompt = forFormat(`You are a motion-design director. Produce a concise production plan for a short 9:16 animation. This plan will be used by a code generator, not shown on screen.\nOriginal user brief: ${JSON.stringify(body.originalPrompt || body.prompt)}\nEarlier user changes: ${JSON.stringify(earlier)}\nLatest request: ${JSON.stringify(body.prompt)}\nSelected reference style:\n${styleCard}\n\nPlan 2–4 timed beats with a specific subject-relevant visual composition, its motion, transitions and exact visible words for each. Define how the first frame is already visually engaging and the ending resolves. Give concrete layout and scale, not vague adjectives, random decoration, or invented claims. Treat qualitative feedback as direction, never literal text. The user's explicit wording, requested duration and colors override the style example. When exact words are supplied, do not invent any other visible words. The reference example is a style reference, not a script; do not borrow its topic or props unless relevant. Use only artwork the generator can draw with code; no photographs, external assets, sound, or unsupported libraries. Avoid generic title cards. Give each visible text block and each foreground decorative graphic a bounding box using normalized frame coordinates 0 to 1. Text boxes must remain inside x=0.06 to 0.94 and y=0.08 to 0.92, and stay at least 0.015 apart from other text and foreground graphics. Do not put a rule, line or shape through text. A full-frame background is not a foreground decoration. Keep text in its safe box throughout transitions, do not crop headlines. Output only valid JSON with this shape: {"duration":8,"beats":[{"start":0,"end":2,"visual":"...","motion":"...","text":[{"content":"...","box":{"x":0.1,"y":0.3,"w":0.8,"h":0.1}}],"decorations":[{"x":0.2,"y":0.6,"w":0.6,"h":0.02}]}]}. The decorations array contains bounding box objects directly, never strings or nested boxes. If there are no foreground lines or shapes, use an empty decorations array. All four coordinates are numbers. Use 2–4 beats; they must start at zero, be continuous and finish exactly at duration. Duration must be between 4 and 15 seconds. Include no markdown or code.`, body.format);
      let plan, problem = '';
      const planStarted = Date.now();
      try {
      for (let attempt = 0; attempt < 2; attempt++) {
        planResult = await callWithLengthRetry(planningPrompt + (problem ? `\n\nCorrect this problem in your previous plan: ${problem}` : ''), 3000, 6000, 'planning the video', cancellation.signal, planChoice, planTally);
        try { plan = JSON.parse(planResult.code); problem = planResult.code.length > 10000 ? 'Keep the plan concise.' : validatePlan(plan); }
        catch { problem = 'Return valid JSON in the specified format.'; }
        if (!problem) break;
      }
      if (problem) throw new HttpError(502, `The video plan needs another try: ${problem}`);
      } catch (error) {
        logRun({kind: 'plan', choice: planChoice, tally: planTally, ms: Date.now() - planStarted, style: body.style, failed: String(error.message || error).slice(0, 200)});
        run = null;
        throw error;
      }
      logRun({kind: 'plan', choice: planChoice, tally: planTally, ms: Date.now() - planStarted, style: body.style});
      run.started = Date.now();
      planResult.code = JSON.stringify({duration:plan.duration, beats:plan.beats});
    }
    const result = await callWithLengthRetry(forFormat(prompt({...body, creativePlan: planResult?.code}), body.format), 24000, 32000, 'writing the animation', cancellation.signal, choice, tally);
    const {code, model, provider} = result;
    const usd = tally.usdKnown && planTally.usdKnown ? tally.usd + planTally.usd : null;
    const ms = Date.now() - started;
    logRun({...run, started: undefined, ms: Date.now() - run.started, provider, planned: Boolean(planResult)});
    run = null;
    send(res, 200, { code, model, provider, usd, ms });
  } catch (error) {
    if (run) logRun({...run, started: undefined, ms: Date.now() - run.started, failed: String(error.message || error).slice(0, 200)});
    if (!res.destroyed) fail(res, error);
  }
};

module.exports.extractCode = extractCode;
module.exports.STYLE_FILES = STYLE_FILES;
module.exports.forFormat = forFormat;
