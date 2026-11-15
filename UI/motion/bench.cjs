// Motion bench (dev only): generate canvas scenes through a local /api/motion, render them in headless Chrome, and score them.
//   node bench.cjs gen    --arm NAME [--base http://localhost:4173] [--models a,b] [--prompts a,b,c] [--max-requests N]
//   node bench.cjs render --arm NAME [--kit kit.js]      (free: re-renders cached code, writes metrics + contact sheets)
//   node bench.cjs repair --arm NAME --to NAME2 [--base URL] [--kit kit.js]   (one repair call per lint/safe-area failure)
//   node bench.cjs pairs  --a ARM --b ARM                (blind A/B sheets; the side mapping goes to pairs-key.json)
//   node bench.cjs selftest                              (no model calls)
// Output: $BENCH_OUT or ./bench-out. Needs Google Chrome; Node 22+ (global WebSocket).
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const args = Object.fromEntries(process.argv.slice(3).reduce((pairs, value, i, all) => (value.startsWith('--') ? pairs.concat([[value.slice(2), all[i + 1]]]) : pairs), []));
const OUT = process.env.BENCH_OUT || path.join(__dirname, 'bench-out');
const RUN_LOG = path.join(os.homedir(), '.config', 'relio-motion', 'runs.jsonl');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FORMATS = {'9:16': [1080, 1920], '16:9': [1920, 1080], '3:4': [1080, 1440]};
const PROMPTS = {
  a: {prompt: 'How vaccines train the immune system, 10 s', style: 'flat-vector-science', format: '9:16'},
  b: {prompt: "Relio Clips: turn long videos into shorts, exact text: 'Long video in. Viral shorts out.'", format: '9:16'},
  c: {prompt: 'Our revenue grew 3x in 2026: animated bar chart with counter', format: '16:9'},
};
const FRAMES = 8;

// Same safe area the API asks for (see forFormat in api/motion.js).
const safeArea = ([w, h]) => (w === 1080 && h === 1920 ? {x: 120, y: 220} : {x: Math.round(w * 0.08), y: Math.round(h * 0.08)});

function lint(code) {
  const count = (re) => (code.match(re) || []).length;
  return {chars: code.length, random: count(/Math\.random\s*\(/g), date: count(/\bDate\b|performance\.now/g), timers: count(/requestAnimationFrame|setTimeout|setInterval|fetch\s*\(/g), kitCalls: count(/\bK\.\w+/g), hCalls: count(/\bH\.\w+/g)};
}

// ---------- headless Chrome over CDP ----------
async function chrome() {
  const port = 9300 + Math.floor(Math.random() * 500), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', 'about:blank'], {stdio: 'ignore'});
  for (let i = 0; i < 150; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  // Chrome may still be writing its profile on exit; the OS temp dir is cleaned anyway.
  return {port, close: () => { proc.kill(); try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} }};
}
async function page(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: 'PUT'})).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (event) => { const m = JSON.parse(event.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); ws.send(JSON.stringify({id, method, params})); });
  const evaluate = async (expression, timeout = 30000) => {
    const m = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, timeout});
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text);
    return m.result?.result?.value;
  };
  return {send, evaluate, close: () => { ws.close(); fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}); }};
}

// Records the box of every visible fillText/strokeText (after the current transform) while __rec is on.
const INSTRUMENT = `(() => {
  window.__texts = []; window.__rec = false; window.__status = null;
  addEventListener('message', (e) => { const m = e.data || {}; if (m.type === 'ready' || m.type === 'error') window.__status = m; });
  const P = CanvasRenderingContext2D.prototype;
  for (const name of ['fillText', 'strokeText']) {
    const original = P[name];
    P[name] = function (text, x, y, ...rest) {
      if (window.__rec && String(text).trim() && this.globalAlpha > 0.05) {
        const m = this.measureText(text), t = this.getTransform();
        const xs = [], ys = [];
        for (const [px, py] of [[x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent], [x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent], [x - m.actualBoundingBoxLeft, y + m.actualBoundingBoxDescent], [x + m.actualBoundingBoxRight, y - m.actualBoundingBoxAscent]]) { xs.push(t.a * px + t.c * py + t.e); ys.push(t.b * px + t.d * py + t.f); }
        window.__texts.push({text: String(text).slice(0, 40), x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys)});
      }
      return original.call(this, text, x, y, ...rest);
    };
  }
})();`;

function runnerHtml(root, [W, H]) {
  const source = fs.readFileSync(path.join(root, 'motion.js'), 'utf8');
  const literal = source.match(/const canvasRunner = \(\) => (`[\s\S]*?`);/)[1];
  return require('node:vm').runInNewContext(literal, {W, H, Math});
}

/** Loads code in the real runner, samples FRAMES frames, and measures crash, safe-area text and motion energy. */
async function render(port, code, size, {kit, root = __dirname} = {}) {
  const file = path.join(os.tmpdir(), `bench-runner-${process.pid}.html`);
  fs.writeFileSync(file, runnerHtml(root, size));
  const p = await page(port);
  try {
    await p.send('Page.enable');
    await p.send('Page.addScriptToEvaluateOnNewDocument', {source: INSTRUMENT + (kit ? '\n' + fs.readFileSync(kit, 'utf8') : '')});
    await p.send('Page.navigate', {url: 'file://' + file});
    for (let i = 0; i < 50 && !(await p.evaluate('typeof frame === "function"').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));
    await p.evaluate(`postMessage({type:'load', code:${JSON.stringify(code)}}, '*'); true`);
    let status = null;
    for (let i = 0; i < 300 && !status; i++) { await new Promise((r) => setTimeout(r, 100)); status = await p.evaluate('window.__status').catch(() => null); }
    if (!status) return {crash: 'load timeout'};
    if (status.type === 'error') return {crash: status.message.split('\n')[0].slice(0, 200)};
    const [W, H] = size, safe = safeArea(size);
    return await p.evaluate(`(() => {
      playing = false;
      const small = document.createElement('canvas'); small.width = 96; small.height = Math.round(96 * ${H / W});
      const sctx = small.getContext('2d', {willReadFrequently: true});
      const thumb = document.createElement('canvas'); thumb.width = 270; thumb.height = Math.round(270 * ${H / W});
      const frames = [], energies = []; let previous = null, unsafeFrames = 0, worst = 0, offenders = [], crash = null;
      for (let i = 0; i < ${FRAMES}; i++) {
        const time = scene.duration * (i + 0.5) / ${FRAMES};
        __texts = []; __rec = true;
        try { frame(time); } catch (e) { crash = crash || ('t=' + time.toFixed(2) + ' ' + String(e.message || e)); }
        __rec = false;
        let bad = 0;
        for (const b of __texts) {
          const over = Math.max(${safe.x} - b.x0, b.x1 - ${W - safe.x}, ${safe.y} - b.y0, b.y1 - ${H - safe.y});
          if (over > 8) { bad++; worst = Math.max(worst, over); if (offenders.length < 4) offenders.push(b.text + ' +' + Math.round(over) + 'px'); }
        }
        if (bad) unsafeFrames++;
        sctx.drawImage(c, 0, 0, small.width, small.height);
        const data = sctx.getImageData(0, 0, small.width, small.height).data;
        if (previous) { let sum = 0; for (let k = 0; k < data.length; k += 4) sum += Math.abs(data[k] - previous[k]) + Math.abs(data[k+1] - previous[k+1]) + Math.abs(data[k+2] - previous[k+2]); energies.push(sum / (data.length / 4 * 3)); }
        previous = data;
        thumb.getContext('2d').drawImage(c, 0, 0, thumb.width, thumb.height);
        frames.push(thumb.toDataURL('image/png'));
      }
      return {crash, duration: scene.duration, unsafeFrames, worstOverPx: Math.round(worst), offenders,
        energy: +(energies.reduce((a, b) => a + b, 0) / energies.length).toFixed(2), staticPairs: energies.filter((e) => e < 0.05).length, frames};
    })()`);
  } catch (error) { return {crash: String(error.message || error).split('\n')[0].slice(0, 200)}; }
  finally { p.close(); }
}

async function contactSheet(frames, file, label = '') {
  const tiles = frames.map((f) => Buffer.from(f.split(',')[1], 'base64'));
  const {width, height} = await sharp(tiles[0]).metadata(), cols = 4, gap = 6, top = label ? 40 : 0;
  const composite = tiles.map((input, i) => ({input, left: gap + (i % cols) * (width + gap), top: top + gap + Math.floor(i / cols) * (height + gap)}));
  if (label) composite.push({input: Buffer.from(`<svg width="600" height="40"><text x="10" y="30" font-size="28" font-family="Arial" fill="#fff">${label}</text></svg>`), left: 0, top: 0});
  await sharp({create: {width: gap + cols * (width + gap), height: top + gap + 2 * (height + gap), channels: 3, background: '#333'}}).composite(composite).png().toFile(file);
}

const runLines = () => { try { return fs.readFileSync(RUN_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
function requestsSpent() { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'spent.json'), 'utf8')); } catch { return {requests: 0, usd: 0}; } }

async function post(base, body, maxRequests) {
  const spent = requestsSpent();
  if (spent.requests >= maxRequests) throw new Error(`Request budget reached (${spent.requests}/${maxRequests}).`);
  const before = runLines().length, started = Date.now();
  // node:http, not fetch: fetch drops a response after 300 s, and slow reasoning models take longer.
  const response = await new Promise((resolve, reject) => {
    const request = require('node:http').request(base + '/api/motion', {method: 'POST', headers: {'Content-Type': 'application/json'}}, (r) => { let text = ''; r.on('data', (d) => (text += d)); r.on('end', () => resolve({status: r.statusCode, text})); });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
  let data = {}; try { data = JSON.parse(response.text); } catch {}
  const runs = runLines().slice(before).map((l) => JSON.parse(l));
  spent.requests += runs.reduce((n, r) => n + (r.requests || 0), 0); spent.usd += runs.reduce((n, r) => n + (r.usd || 0), 0);
  fs.writeFileSync(path.join(OUT, 'spent.json'), JSON.stringify(spent));
  return {status: response.status, code: data.code, error: data.error || data.message, usd: data.usd, ms: Date.now() - started, runs,
    completionTokens: runs.reduce((n, r) => n + (r.completionTokens || 0), 0), requests: runs.reduce((n, r) => n + (r.requests || 0), 0)};
}

const cases = () => (args.prompts || 'a,b,c').split(',').flatMap((p) => (args.models || 'xiaomi/mimo-v2.6-flash').split(',').map((model) => ({p, model, key: `${p}_${model.split('/')[1]}`})));

async function gen() {
  const dir = path.join(OUT, args.arm); fs.mkdirSync(dir, {recursive: true});
  for (const {p, model, key} of cases()) {
    const file = path.join(dir, key + '.json');
    if (fs.existsSync(file)) continue; // cached: never pay twice for the same cell
    const {prompt, style, format} = PROMPTS[p];
    const result = await post(args.base || 'http://localhost:4173', {prompt, engine: 'canvas', model, format, ...(style ? {style} : {})}, Number(args['max-requests'] || 15));
    fs.writeFileSync(file, JSON.stringify({p, model, ...result}, null, 1));
    console.log(key, result.status, result.error || `${result.completionTokens} tok $${result.usd}`);
    if (result.status !== 200 && fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f)))).filter((r) => r.status !== 200).length >= 2) throw new Error('Errors repeat; stopping.');
  }
}

async function renderArm() {
  const dir = path.join(OUT, args.arm), browser = await chrome(), rows = [];
  try {
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'metrics.json').sort()) {
      const run = JSON.parse(fs.readFileSync(path.join(dir, name)));
      const size = FORMATS[PROMPTS[run.p].format];
      const metrics = run.code ? await render(browser.port, run.code, size, {kit: args.kit}) : {crash: `no code: ${run.error}`};
      if (metrics.frames) await contactSheet(metrics.frames, path.join(dir, name.replace('.json', '.png')));
      const row = {arm: args.arm, key: name.replace('.json', ''), crash: metrics.crash || null, unsafeFrames: metrics.unsafeFrames, worstOverPx: metrics.worstOverPx, offenders: metrics.offenders, energy: metrics.energy, staticPairs: metrics.staticPairs, duration: metrics.duration, tokens: run.completionTokens, requests: run.requests, usd: run.usd, ...(run.code ? lint(run.code) : {})};
      rows.push(row); console.log(JSON.stringify(row));
    }
  } finally { browser.close(); }
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(rows, null, 1));
}

// Idea 4: static lint + safe-area probe, then one repair call through the API's normal error path.
async function repair() {
  const from = path.join(OUT, args.arm), to = path.join(OUT, args.to); fs.mkdirSync(to, {recursive: true});
  for (const row of JSON.parse(fs.readFileSync(path.join(from, 'metrics.json')))) {
    const run = JSON.parse(fs.readFileSync(path.join(from, row.key + '.json')));
    const problems = [row.crash && `It crashes: ${row.crash}`, row.random && 'It uses Math.random; use a seeded random.', row.date && 'It reads the clock; draw only from t.', row.timers && 'It uses timers or fetch.',
      row.unsafeFrames && `Text leaves the safe area in ${row.unsafeFrames}/${FRAMES} sampled frames: ${row.offenders.join('; ')}. Shrink or wrap that text so it stays inside the safe area for its whole lifetime.`].filter(Boolean);
    if (!problems.length || !run.code) { fs.writeFileSync(path.join(to, row.key + '.json'), JSON.stringify({...run, repaired: false}, null, 1)); continue; }
    const {prompt, style, format} = PROMPTS[run.p];
    const result = await post(args.base || 'http://localhost:4173', {prompt, engine: 'canvas', model: run.model, format, ...(style ? {style} : {}), previous: run.code, error: problems.join(' ')}, Number(args['max-requests'] || 15));
    fs.writeFileSync(path.join(to, row.key + '.json'), JSON.stringify({p: run.p, model: run.model, ...result, repaired: true, problems}, null, 1));
    console.log(row.key, 'repaired', result.status, result.error || '');
  }
}

async function pairs() {
  const dir = path.join(OUT, `pairs-${args.a}-vs-${args.b}`); fs.mkdirSync(dir, {recursive: true});
  const key = {};
  for (const name of fs.readdirSync(path.join(OUT, args.a)).filter((f) => f.endsWith('.png'))) {
    const b = path.join(OUT, args.b, name); if (!fs.existsSync(b)) continue;
    const swap = Math.random() < 0.5, top = swap ? b : path.join(OUT, args.a, name), bottom = swap ? path.join(OUT, args.a, name) : b;
    const [t, u] = await Promise.all([top, bottom].map((f) => sharp(f).metadata()));
    await sharp({create: {width: Math.max(t.width, u.width), height: t.height + u.height + 80, channels: 3, background: '#111'}}).composite([
      {input: Buffer.from('<svg width="200" height="40"><text x="8" y="30" font-size="30" fill="#ff0">A</text></svg>'), left: 0, top: 0}, {input: top, left: 0, top: 40},
      {input: Buffer.from('<svg width="200" height="40"><text x="8" y="30" font-size="30" fill="#ff0">B</text></svg>'), left: 0, top: t.height + 40}, {input: bottom, left: 0, top: t.height + 80}]).png().toFile(path.join(dir, name));
    key[name] = {A: swap ? args.b : args.a, B: swap ? args.a : args.b};
  }
  fs.writeFileSync(path.join(dir, 'pairs-key.json'), JSON.stringify(key, null, 1));
  console.log(dir);
}

async function selftest() {
  const browser = await chrome();
  try {
    const scene = (body, extra = '') => `const scene = {width:1080,height:1920,fps:30,duration:4,draw(ctx,t){ctx.fillStyle='#123';ctx.fillRect(0,0,1080,1920);${extra}ctx.fillStyle='#fff';ctx.font='80px Arial';${body}}};`;
    const good = await render(browser.port, scene("ctx.fillText('Hi', 300 + t * 100, 900); ctx.fillRect(200, 1000 + t * 150, 400, 300);"), [1080, 1920]);
    assert.equal(good.crash, null); assert.equal(good.unsafeFrames, 0); assert.ok(good.energy > 0.5, 'moving text has energy');
    const late = await render(browser.port, scene("if (t > 3.6) throw new Error('late');"), [1080, 1920]);
    assert.match(late.crash, /late/);
    const unsafe = await render(browser.port, scene("ctx.fillText('Edge text', 20, 100);"), [1080, 1920]);
    assert.equal(unsafe.unsafeFrames, FRAMES);
    const still = await render(browser.port, scene("ctx.fillText('Still', 300, 900);"), [1080, 1920]);
    assert.equal(still.energy, 0); assert.equal(still.staticPairs, FRAMES - 1);
    const kitFile = path.join(os.tmpdir(), 'bench-kit-test.js'); fs.writeFileSync(kitFile, 'window.K = {x: 300};');
    assert.equal((await render(browser.port, scene("ctx.fillText('K', K.x, 900);"), [1080, 1920], {kit: kitFile})).crash, null);
    console.log('selftest ok');
  } finally { browser.close(); }
}

const commands = {gen, render: renderArm, repair, pairs, selftest};
if (!commands[process.argv[2]]) { console.error('Usage: node bench.cjs gen|render|repair|pairs|selftest ...'); process.exit(2); }
commands[process.argv[2]]().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
