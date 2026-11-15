// The kit path: the model writes a small JSON spec that picks ready-made pieces from motion/kit.js (looks, fonts, text
// animations, blocks, decorations, transitions) instead of drawing code. The names here must match kit.js.
const Kit = require('../motion/kit.js');

const STYLE_THEME = {'flat-vector-science': 'space', 'watercolor-wash': 'paper', 'shadow-puppet-theatre': 'shadow'};
const BLOCKS = ['headline', 'sub', 'kicker', 'list', 'stat', 'bars', 'quote', 'button', 'icon', 'cards', 'media', 'character', 'planet', 'flow'];
const PREFIX = 'const scene = Kit.build(';
const isKit = (code) => typeof code === 'string' && code.trimStart().startsWith(PREFIX);
const specOf = (code) => { try { return JSON.parse(code.trim().slice(PREFIX.length).replace(/\);?\s*$/, '')); } catch { return null; } };

const GUIDE = `You are a motion designer. You do not write code: you fill in a JSON spec, and a rendering library draws and animates it. Everything is laid out, sized and kept on screen automatically, so spend your effort on the story, the words and good choices.

SPEC
{"duration": 8, "theme": "...", "palette": {"bg","bg2","text","accent","accent2"}, "font": {"head","body"}, "scenes": [{"seconds": 3, "transition": "...", "align": "center", "decor": ["..."], "blocks": [ ... ]}]}

THEMES (the whole look: background, texture, lighting)
- neon: dark, glowing color clouds. Tech, apps, modern ads.
- space: navy-to-violet starfield. Science, big ideas, explainers.
- paper: cream paper with watercolor washes. Soft, human, educational.
- shadow: amber backlit shadow theatre; text hangs on dark cut-paper signs. Stories, fables.
- clean: light background, bold dark type, simple shapes. Business, minimal.
- sunset: warm purple-to-coral gradient with a glowing sun. Lifestyle, motivation.

PALETTE (optional): five #rrggbb colors. Give one only when the user names colors or a brand; otherwise leave it out and the theme's own colors are used. Keep text readable against bg. (Ignored by the shadow theme.)
FONTS (optional, {"head","body"}): ${Kit.FONTS.join(', ')}. Loud: Anton, Bebas Neue, Archivo Black. Friendly: Fredoka, Baloo 2, Nunito. Modern: Sora, Space Grotesk, Poppins, Inter. Elegant: Playfair Display, DM Serif Display, Fraunces. Handmade: Caveat, Permanent Marker.

SCENES: 2 to 5, played in order; "seconds" share out the duration. Each scene shows 1 to 3 blocks stacked top to bottom (4 at most). One idea per scene.
- transition (how the scene arrives): ${Kit.TRANSITIONS.join(', ')}.
- align: center (default), top or bottom.
- decor (0 to 2 moving decorations behind the blocks): ${Kit.DECOR.join(', ')}. galaxy and flare work in the space theme only. Pick ones that fit the idea (orbits/planet for ideas and science, confetti for wins, rays for reveals, waves for calm, grid for tech, rings for emphasis, particles for energy).

BLOCKS
- {"type":"headline","text":"Make it *move*","anim":"words"}: big title, 2 to 6 words. Wrap 1 or 2 key words in *stars* to color them. anim: ${Kit.ANIMS.join(', ')} (words = pop in one by one, letters = letter cascade, rise = lines slide up, type = typewriter, slam = hits hard, fade = soft).
- {"type":"sub","text":"...","anim":"fade"}: a supporting line under a headline.
- {"type":"kicker","text":"NEW"}: small label pill above a headline, 1 to 3 words.
- {"type":"list","items":["...","..."]}: 2 to 4 short points that tick in one by one.
- {"type":"stat","value":3,"prefix":"","suffix":"x","label":"..."}: a big number that counts up.
- {"type":"bars","items":[{"label":"2024","value":1.2}],"prefix":"$","suffix":"M"}: an animated bar chart, 2 to 6 bars.
- {"type":"quote","text":"...","by":"..."}: a quotation.
- {"type":"button","text":"Try it free"}: a call-to-action pill; good as the last block of the last scene.
- {"type":"icon","name":"..."}: a round icon badge. Names: ${Kit.ICONS.join(', ')}.
- {"type":"cards","count":3}: a row of floating short-video cards (for video, clips, content, social posts).
- {"type":"flow","items":["Guess","Check","Adjust"]}: 2 to 4 short step labels joined by dotted arrows that draw on. Use it to show a process or cause and effect.
- {"type":"character","name":"robot","mood":"happy","says":"cat!"}: space theme only. A cute illustrated character (${Kit.CHARACTERS.join(', ')}) that pops in and bobs; mood is neutral, happy or worry; "says" (optional, 1 to 3 words) appears in a speech bubble. Characters make explainers feel alive: use one in most space scenes, and let its mood follow the story.
- {"type":"planet","color":"teal"}: space theme only. A big shaded planet (${Kit.PLANETS.join(', ')}; magenta and teal have rings).
- {"type":"media","id":"..."}: one of the user's own photos or videos (only ids listed under USER MEDIA).

RULES
- If the user gives exact words, show exactly those words, in their order, and add no other sentences. Otherwise write short, punchy copy: headlines of 2 to 6 words.
- Every scene must look different from the one before: change the blocks, the decor and the transition.
- Start strong: the first scene is a headline. End with a clear last scene (the takeaway, plus a button when it is an ad).
- Duration: what the user asks for; otherwise 6 to 12 seconds, about 2 to 3.5 seconds per scene.
- Use only the names listed above. Output only the JSON object, with no code fence and no comments.`;

/** The whole instruction for one kit call. */
function kitPrompt({prompt, originalPrompt, history, style, previous, visualFeedback, media, seconds}) {
  const earlier = Array.isArray(history) ? history.filter((h) => h?.role === 'user' && typeof h.content === 'string').slice(-8).map((h) => h.content.slice(0, 2000)) : [];
  const theme = STYLE_THEME[style];
  const current = previous ? specOf(previous) : null;
  return `${GUIDE}${theme ? `\n\nThe user chose a style: use "theme": "${theme}".` : ''}${seconds ? `\n\nLength: ${seconds} seconds, unless the brief names another duration.` : ''}${media?.length ? `\n\nUSER MEDIA (use them where they fit the story):\n${media.map((m) => `- id "${m.id}" (${m.kind}): ${m.description}`).join('\n')}` : ''}

Original brief: ${JSON.stringify(originalPrompt || prompt)}${earlier.length ? `\nEarlier changes: ${JSON.stringify(earlier)}` : ''}${current ? `\n\nCurrent spec:\n${JSON.stringify(current)}\n\nLatest request: ${JSON.stringify(prompt)}${visualFeedback ? `\nA check of the rendered frames found: ${JSON.stringify(visualFeedback)}` : ''}\nReturn the whole spec with the change applied. Keep what the user did not ask to change.` : ''}`;
}

/** The model's JSON as a safe spec for this format and style, or an error message to send back to the model. */
function normalize(text, {format, style, media}) {
  let spec;
  try { spec = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return {problem: 'Return one valid JSON object and nothing else.'}; }
  if (!spec || !Array.isArray(spec.scenes) || !spec.scenes.length) return {problem: 'The spec needs a "scenes" array.'};
  const ids = new Set((media || []).map((m) => m.id));
  const scenes = spec.scenes.slice(0, 6).map((s) => ({
    seconds: Number(s?.seconds) > 0 ? Number(s.seconds) : 2.5,
    transition: Kit.TRANSITIONS.includes(s?.transition) ? s.transition : 'fade',
    align: ['top', 'bottom'].includes(s?.align) ? s.align : 'center',
    decor: (Array.isArray(s?.decor) ? s.decor : []).filter((d) => Kit.DECOR.includes(d)).slice(0, 2),
    blocks: (Array.isArray(s?.blocks) ? s.blocks : []).filter((b) => b && BLOCKS.includes(b.type) && (b.type !== 'media' || ids.has(b.id))).slice(0, 4),
  })).filter((s) => s.blocks.length);
  if (!scenes.length) return {problem: `Every scene needs blocks with a "type" from: ${BLOCKS.join(', ')}.`};
  const [width, height] = format;
  const theme = STYLE_THEME[style] || (Kit.THEMES.includes(spec.theme) ? spec.theme : 'neon');
  const total = scenes.reduce((n, s) => n + s.seconds, 0);
  const out = {width, height, duration: Math.min(30, Math.max(3, Number(spec.duration) || total)), theme, scenes};
  if (spec.palette && typeof spec.palette === 'object') out.palette = Object.fromEntries(Object.entries(spec.palette).filter(([k, v]) => ['bg', 'bg2', 'text', 'accent', 'accent2'].includes(k) && /^#[0-9a-f]{6}$/i.test(v)));
  if (spec.font && typeof spec.font === 'object') out.font = Object.fromEntries(Object.entries(spec.font).filter(([k, v]) => ['head', 'body'].includes(k) && Kit.FONTS.includes(v)));
  return {code: `${PREFIX}${JSON.stringify(out, null, 1)});`};
}

module.exports = {isKit, kitPrompt, normalize, GUIDE, STYLE_THEME};
