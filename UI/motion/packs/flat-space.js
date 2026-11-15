// Flat-Vector Science materials for the Motion kit: sky, planets, the robot, cat and dog, bubbles, arrows, galaxy, glows.
// Generated from api/_motion-styles/flat-vector-science.txt (its H helper library and the drawing functions of its reference,
// without the example story, player and sound). Regenerate from that file rather than editing here.

// Shared helpers + style registry for the style-frame explorations.
// Every style is a pure function of time: draw(ctx, W, H, t). Same t => same pixels.
(function () {
  const STYLES = (window.STYLES = window.STYLES || []);
  window.registerStyle = (s) => STYLES.push(s);

  const H = (window.H = {});

  // ---------- seeded randomness ----------
  // H.rng(seed) -> r() in [0,1). Extras: r.range(a,b), r.int(a,b), r.pick(arr), r.gauss(), r.chance(p)
  H.rng = function (seed = 1) {
    let a = typeof seed === 'string' ? hashStr(seed) : (seed >>> 0) || 1;
    const r = function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.range = (lo, hi) => lo + r() * (hi - lo);
    r.int = (lo, hi) => Math.floor(lo + r() * (hi - lo + 1));
    r.pick = (arr) => arr[Math.floor(r() * arr.length)];
    r.chance = (p) => r() < p;
    r.gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    return r;
  };
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // ---------- gradient noise ----------
  // H.makeNoise(seed) -> { n2(x,y), n3(x,y,z), fbm2(x,y,oct), fbm3(x,y,z,oct) }  (outputs roughly -1..1)
  H.makeNoise = function (seed = 1) {
    const r = H.rng(seed), p = new Uint8Array(512), perm = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (a, b, t) => a + (b - a) * t;
    const g3 = (h, x, y, z) => { h &= 15; const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); };
    function n3(x, y, z) {
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
      x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
      const u = fade(x), v = fade(y), w = fade(z);
      const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
      return lerp(lerp(lerp(g3(p[AA], x, y, z), g3(p[BA], x - 1, y, z), u), lerp(g3(p[AB], x, y - 1, z), g3(p[BB], x - 1, y - 1, z), u), v),
        lerp(lerp(g3(p[AA + 1], x, y, z - 1), g3(p[BA + 1], x - 1, y, z - 1), u), lerp(g3(p[AB + 1], x, y - 1, z - 1), g3(p[BB + 1], x - 1, y - 1, z - 1), u), v), w);
    }
    const n2 = (x, y) => n3(x, y, 0.5);
    const fbm3 = (x, y, z, oct = 4) => { let s = 0, a = 0.5, f = 1, norm = 0; for (let i = 0; i < oct; i++) { s += a * n3(x * f, y * f, z * f); norm += a; a *= 0.5; f *= 2; } return s / norm; };
    const fbm2 = (x, y, oct = 4) => fbm3(x, y, 0.5, oct);
    return { n2, n3, fbm2, fbm3 };
  };

  // ---------- math ----------
  H.lerp = (a, b, t) => a + (b - a) * t;
  H.clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  H.map = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
  H.smooth = (e0, e1, x) => { const t = H.clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
  H.ease = {
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    out: (t) => 1 - Math.pow(1 - t, 3),
    in: (t) => t * t * t,
    back: (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  };

  // ---------- color ----------
  H.hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  H.rgba = (hexOrArr, a = 1) => { const [r, g, b] = Array.isArray(hexOrArr) ? hexOrArr : H.hex(hexOrArr); return `rgba(${r | 0},${g | 0},${b | 0},${a})`; };
  H.mix = (c1, c2, t) => { const a = Array.isArray(c1) ? c1 : H.hex(c1), b = Array.isArray(c2) ? c2 : H.hex(c2); return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t); };

  // ---------- canvas utilities ----------
  // Offscreen canvas of the same logical size (use for layers, masks, compositing).
  H.layer = (W, H_, ) => { const c = document.createElement('canvas'); c.width = W; c.height = H_; return c; };
  // Monochrome grain / film noise over the whole canvas. amount ~ 0.03-0.15
  H.grain = function (ctx, W, Hh, amount = 0.08, seed = 7, mono = true) {
    const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height), d = img.data, r = H.rng(seed), k = amount * 255;
    for (let i = 0; i < d.length; i += 4) {
      const n = (r() - 0.5) * k;
      if (mono) { d[i] += n; d[i + 1] += n; d[i + 2] += n; }
      else { d[i] += (r() - 0.5) * k; d[i + 1] += (r() - 0.5) * k; d[i + 2] += (r() - 0.5) * k; }
    }
    ctx.putImageData(img, 0, 0);
  };
  // Paper-ish texture tile: fills with base color + fibrous noise (cheap; drawn into ctx).
  H.paper = function (ctx, W, Hh, base = '#f3ecdc', seed = 3, strength = 0.06) {
    ctx.save(); ctx.fillStyle = base; ctx.fillRect(0, 0, W, Hh);
    const nz = H.makeNoise(seed), cell = 4, [br, bg, bb] = H.hex(base);
    for (let y = 0; y < Hh; y += cell) for (let x = 0; x < W; x += cell) {
      const v = nz.fbm2(x * 0.01, y * 0.01, 3) * 0.6 + nz.n2(x * 0.15, y * 0.04) * 0.4;
      const s = 1 + v * strength * 2;
      ctx.fillStyle = `rgb(${br * s | 0},${bg * s | 0},${bb * s | 0})`; ctx.fillRect(x, y, cell, cell);
    }
    ctx.restore();
  };
  // Vignette
  H.vignette = function (ctx, W, Hh, strength = 0.5, color = '0,0,0') {
    const g = ctx.createRadialGradient(W / 2, Hh / 2, Math.min(W, Hh) * 0.3, W / 2, Hh / 2, Math.hypot(W, Hh) * 0.6);
    g.addColorStop(0, `rgba(${color},0)`); g.addColorStop(1, `rgba(${color},${strength})`);
    ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh); ctx.restore();
  };

  // ---------- rendering entry ----------
  // Renders style into canvas at logical 1280x720 (canvas can be any pixel size; it is scaled).
  H.W = 1280; H.H = 720;
  H.loadFonts = async function (style) {
    const specs = style.fonts || [];
    try { const sample = 'AaZz09' + (window.FONT_SAMPLE || '');
      await Promise.all(specs.map((f) => document.fonts.load(f, sample))); await document.fonts.ready; } catch (e) { /* render anyway */ }
  };
  H.render = function (style, canvas, t) {
    const ctx = canvas.getContext('2d', { willReadFrequently: !!style.readsPixels });
    const sx = canvas.width / H.W, sy = canvas.height / H.H;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.scale(sx, sy);
    style.draw(ctx, H.W, H.H, t == null ? style.frameT || 0 : t);
    ctx.restore();
  };
})();


{
  // ---------- Flat-vector science explainer: deep space gradients, chunky shaded balls, crescent shadows, glows ----------
  const TAU = Math.PI * 2;
  const cl = H.clamp, lerp = H.lerp;
  const seg = (t, a, b) => cl((t - a) / (b - a));
  const eo = H.ease.out, eio = H.ease.inOut;
  // gentle overshoot
  const back = (u, s = 1.5) => { if (u <= 0) return 0; if (u >= 1) return 1; return 1 + (s + 1) * Math.pow(u - 1, 3) + s * Math.pow(u - 1, 2); };
  const FONT = '"Nunito", "Fredoka", sans-serif';
  const F = (w, px) => `${w} ${px}px ${FONT}`;

  const C = {
    sky0: '#090b2c', sky1: '#18134f', sky2: '#3a1a6c',
    ink: '#141846', visor: '#10164a',
    teal: ['#a4fbef', '#3ccbdc', '#1d64b0'],
    orange: ['#ffcc7a', '#ff8d3f', '#d24a2a'],
    tan: ['#ffe9be', '#ecb676', '#b4723c'],
    yellow: '#ffd23f', pink: '#ff5d8f', red: '#ff3b5c', green: '#38e08e', cyan: '#56e8ff', violet: '#8b5cff',
  };

  // ---------- timeline of the explainer (shared with explainerSound) ----------
  const TL = {
    title: 0.15, titleShrink: [1.8, 2.4], robotIn: [0.5, 1.4], robotMove: [1.9, 2.8],
    arrow: [2.55, 3.1], count: [2.8, 5.6], travel: 1.5,
    zoom: [4.55, 5.8], sweep: [5.95, 6.85],
    catIn: [6.35, 6.95], guess: 6.95, bubble: 7.15, check: 7.6, wrong: 7.75,
    err: [8.05, 8.6], adjust: 8.6, zoomIn: [8.65, 9.1], rewire: [8.75, 9.35], zoomBack: [9.45, 9.85],
    guess2: 9.6, right: 9.75, toC: [10.3, 10.8], acc: [11.0, 12.55], hit: 12.55,
    take: [13.0, 13.75], line1: 13.3, line2: 13.55, D: 15,
  };
  // creature spawn times on the data stream
  const SPAWN = (() => { const a = []; let s = 2.75, i = 0; while (s < 5.3) { a.push(s); s += Math.max(0.18, 0.38 - i * 0.03); i++; } return a; })();
  const KIND = (i) => ['cat', 'dog', 'cat', 'cat', 'dog', 'dog', 'cat', 'dog'][i % 8];

  // ---------- small helpers ----------
  function rr(x, X, Y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r);
    x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath();
  }
  function glow(x, cx, cy, r, col, a) {
    if (a <= 0 || r <= 0) return;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, H.rgba(col, a)); g.addColorStop(0.35, H.rgba(col, a * 0.4)); g.addColorStop(1, H.rgba(col, 0));
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
  }
  function spark(x, cx, cy, r, col, a) {
    if (a <= 0 || r <= 0) return;
    x.save(); x.globalAlpha *= a; x.fillStyle = col; x.beginPath();
    x.moveTo(cx, cy - r); x.quadraticCurveTo(cx, cy, cx + r, cy); x.quadraticCurveTo(cx, cy, cx, cy + r);
    x.quadraticCurveTo(cx, cy, cx - r, cy); x.quadraticCurveTo(cx, cy, cx, cy - r); x.fill(); x.restore();
  }
  // region of circle (cx,cy,r) NOT covered by the same circle shifted by (dx,dy)
  function crescent(x, cx, cy, r, dx, dy, fill) {
    x.save(); x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.clip();
    x.beginPath(); x.rect(cx - r - 2, cy - r - 2, 2 * r + 4, 2 * r + 4); x.arc(cx + dx, cy + dy, r * 1.02, 0, TAU);
    x.fillStyle = fill; x.fill('evenodd'); x.restore();
  }
  // the core flat-vector ball: multi-stop gradient, two stepped flat shadow crescents, rim highlight
  function ball(x, cx, cy, r, col, o = {}) {
    if (r <= 0.3) return;
    const la = o.la == null ? -2.25 : o.la, lx = Math.cos(la), ly = Math.sin(la);
    const g = x.createLinearGradient(cx + lx * r, cy + ly * r, cx - lx * r, cy - ly * r);
    g.addColorStop(0, col[0]); g.addColorStop(0.45, col[1]); g.addColorStop(1, H.rgba(H.mix(col[1], col[2], 0.6)));
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
    if (o.inner) { x.save(); x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.clip(); o.inner(); x.restore(); }
    const sh = o.sh == null ? 0.3 : o.sh;
    crescent(x, cx, cy, r, lx * r * sh, ly * r * sh, H.rgba(col[2], o.sha == null ? 0.5 : o.sha));
    crescent(x, cx, cy, r, lx * r * sh * 2.2, ly * r * sh * 2.2, H.rgba(col[2], (o.sha == null ? 0.5 : o.sha) * 0.45));
    crescent(x, cx, cy, r, -lx * r * 0.075, -ly * r * 0.075, H.rgba(o.rim || '#ffffff', o.rima == null ? 0.42 : o.rima));
  }
  const bez = (P, u) => { const v = 1 - u; return [v * v * v * P[0][0] + 3 * v * v * u * P[1][0] + 3 * v * u * u * P[2][0] + u * u * u * P[3][0], v * v * v * P[0][1] + 3 * v * v * u * P[1][1] + 3 * v * u * u * P[2][1] + u * u * u * P[3][1]]; };
  // rounded dotted / solid arrow along a cubic, drawn on to `prog`
  function arrow(x, P, prog, col, lw, o = {}) {
    if (prog <= 0) return;
    const n = 48, a = o.a == null ? 1 : o.a;
    x.save(); x.globalAlpha *= a; x.strokeStyle = col; x.fillStyle = col; x.lineWidth = lw; x.lineCap = 'round'; x.lineJoin = 'round';
    if (o.dots) x.setLineDash([0.01, lw * 1.9]);
    x.beginPath(); const p0 = bez(P, o.from || 0); x.moveTo(p0[0], p0[1]);
    for (let i = 1; i <= n; i++) { const u = (o.from || 0) + ((prog - (o.from || 0)) * i) / n; const p = bez(P, u); x.lineTo(p[0], p[1]); }
    x.stroke(); x.setLineDash([]);
    if (o.head !== false && prog > 0.08) {
      const e = bez(P, prog), e0 = bez(P, prog - 0.02), ang = Math.atan2(e[1] - e0[1], e[0] - e0[0]), hs = lw * 1.5 * cl(prog * 5);
      x.translate(e[0], e[1]); x.rotate(ang); x.beginPath(); x.moveTo(hs * 1.1, 0); x.lineTo(-hs * 0.8, hs); x.lineTo(-hs * 0.8, -hs); x.closePath();
      x.lineWidth = lw * 0.7; x.fill(); x.stroke();
    }
    x.restore();
  }
  // flat text with a darker offset "long shadow"
  function text(x, s, cx, cy, px, col, o = {}) {
    x.save(); x.font = F(o.w || 900, px); x.textAlign = o.align || 'center'; x.textBaseline = 'middle';
    x.globalAlpha *= o.a == null ? 1 : o.a;
    x.fillStyle = o.shadow || 'rgba(10,8,46,0.55)'; x.fillText(s, cx + px * 0.03, cy + px * 0.07);
    x.fillStyle = col; x.fillText(s, cx, cy); x.restore();
  }
  // rounded label pill, optional pointer below
  function pill(x, cx, cy, s, px, o = {}) {
    const sc = o.s == null ? 1 : o.s, a = o.a == null ? 1 : o.a;
    if (sc <= 0.01 || a <= 0.01) return;
    x.save(); x.font = F(o.w || 900, px);
    const tw = x.measureText(s).width, w = tw + px * 1.15, h = px * 1.6;
    x.translate(cx, cy); x.scale(sc, sc); x.globalAlpha *= a;
    x.fillStyle = 'rgba(10,8,46,0.4)'; rr(x, -w / 2, -h / 2 + px * 0.2, w, h, h / 2); x.fill();
    x.fillStyle = o.bg || '#ffffff';
    if (o.ptr) { x.beginPath(); x.moveTo(-px * 0.35, h / 2 - 2); x.lineTo(0, h / 2 + px * 0.45); x.lineTo(px * 0.35, h / 2 - 2); x.fill(); }
    rr(x, -w / 2, -h / 2, w, h, h / 2); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.35)'; rr(x, -w / 2 + h * 0.25, -h / 2 + h * 0.12, w - h * 0.5, h * 0.16, h * 0.08); x.fill();
    x.fillStyle = o.fg || C.ink; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(s, 0, px * 0.06);
    x.restore();
    return w;
  }

  // ---------- sky: gradient, nebula glows, parallax stars and sparkles ----------
  let STARS = null;
  function stars() {
    if (STARS) return STARS;
    const r = H.rng(77), a = [], sp = [];
    for (let i = 0; i < 620; i++) a.push({ x: r.range(0, 1680), y: r.range(0, 1120), d: r.pick([0.15, 0.3, 0.3, 0.55, 1]), s: r.range(0.6, 2.0), ph: r.range(0, TAU), sp: r.range(0.8, 2.6), c: r.pick(['#ffffff', '#cfe4ff', '#ffe9c7', '#dccbff']) });
    for (let i = 0; i < 16; i++) sp.push({ x: r.range(0, 1680), y: r.range(0, 1120), d: r.range(0.3, 0.9), s: r.range(6, 13), ph: r.range(0, TAU) });
    STARS = { a, sp }; return STARS;
  }
  function sky(x, W, H_, t, cam = {}) {
    const px = cam.x || 0, py = cam.y || 0, lz = Math.log(cam.z || 1);
    const g = x.createLinearGradient(0, 0, W * 0.3, H_);
    g.addColorStop(0, C.sky0); g.addColorStop(0.5, C.sky1); g.addColorStop(1, C.sky2);
    x.fillStyle = g; x.fillRect(0, 0, W, H_);
    glow(x, W * 0.86, H_ * 0.12, 700, '#7b34c6', 0.34);
    glow(x, W * 0.05, H_ * 1.0, 620, '#2448b4', 0.4);
    glow(x, W * 0.45, H_ * 0.6, 520, '#4a2a9c', 0.16);
    const S = stars();
    const place = (s) => {
      const k = Math.exp(lz * s.d * 0.6);
      let sx = (((s.x - px * s.d) % 1680) + 1680) % 1680 - 200, sy = (((s.y - py * s.d) % 1120) + 1120) % 1120 - 200;
      return [(sx - 640) * k + 640, (sy - 360) * k + 360];
    };
    for (const s of S.a) {
      const [sx, sy] = place(s);
      if (sx < -4 || sx > W + 4 || sy < -4 || sy > H_ + 4) continue;
      x.globalAlpha = (0.55 + 0.45 * Math.sin(t * s.sp + s.ph)) * (0.45 + s.d * 0.55);
      x.fillStyle = s.c; x.beginPath(); x.arc(sx, sy, s.s * (0.7 + 0.35 * s.d), 0, TAU); x.fill();
    }
    x.globalAlpha = 1;
    for (const s of S.sp) {
      const [sx, sy] = place(s); const tw = 0.6 + 0.4 * Math.sin(t * 1.7 + s.ph);
      glow(x, sx, sy, s.s * 2.2, '#bfa8ff', 0.25 * tw);
      spark(x, sx, sy, s.s * tw, '#ffffff', 0.9);
    }
  }

  // ---------- planets ----------
  function ring(x, cx, cy, R, half, a = 1) {
    if (a <= 0) return;
    x.save(); x.translate(cx, cy); x.rotate(R.tilt); x.globalAlpha *= a;
    // clip to the back or front half, wide enough for the outermost band so the ring ends are never cut off
    const m = Math.max(...R.bands.map((b) => b[1])) * 1.05;
    x.beginPath(); if (half === 'back') x.rect(-R.rx * m, -R.ry * m, R.rx * m * 2, R.ry * m); else x.rect(-R.rx * m, 0, R.rx * m * 2, R.ry * m); x.clip();
    for (const [f0, f1, col, al] of R.bands) {
      x.beginPath(); x.ellipse(0, 0, R.rx * f1, R.ry * f1, 0, 0, TAU); x.ellipse(0, 0, R.rx * f0, R.ry * f0, 0, 0, TAU);
      x.fillStyle = H.rgba(col, (al == null ? 1 : al) * (half === 'back' ? 0.75 : 1)); x.fill('evenodd');
    }
    x.restore();
  }
  function bands(x, r, B, tilt) {
    x.save(); x.rotate(tilt || 0);
    for (const [v0, v1, col, a] of B) {
      x.beginPath();
      for (let i = 0; i <= 20; i++) { const u = (i / 20) * 2 - 1; x.lineTo(u * r * 1.1, (v0 + 0.13 * (1 - u * u)) * r); }
      for (let i = 20; i >= 0; i--) { const u = (i / 20) * 2 - 1; x.lineTo(u * r * 1.1, (v1 + 0.13 * (1 - u * u)) * r); }
      x.fillStyle = H.rgba(col, a == null ? 1 : a); x.fill();
    }
    x.restore();
  }
  const PL = {
    magenta: { c: ['#ffa0c4', '#de4b93', '#4e1670'], glow: '#ff5fa8', tilt: -0.18, atmo: [255, 214, 234],
      bands: [[-0.62, -0.48, '#ffc1d8', 0.55], [-0.2, -0.02, '#b5307e', 0.6], [0.06, 0.14, '#ffd0e2', 0.4], [0.36, 0.58, '#9a2775', 0.55]],
      ring: { rx: 1.75, ry: 0.5, tilt: -0.2, bands: [[1.18, 1.32, '#ffd27a', 0.95], [1.34, 1.5, '#ff9f5a', 0.9], [1.53, 1.6, '#ffe7b0', 0.8]] } },
    coral: { c: ['#ffd29a', '#ff7a4a', '#7a1f4f'], glow: '#ff8a50', tilt: 0.1, atmo: [255, 226, 190],
      bands: [[-0.7, -0.5, '#ffe2b8', 0.5], [-0.32, -0.12, '#e8553a', 0.6], [0.05, 0.22, '#ffb27a', 0.5], [0.4, 0.62, '#c43c46', 0.55]] },
    teal: { c: ['#9ff3ff', '#3a9be0', '#1d2f86'], glow: '#4fc9ff', tilt: -0.12, atmo: [190, 245, 255],
      bands: [[-0.5, -0.36, '#c6f8ff', 0.5], [-0.05, 0.1, '#2f74c9', 0.55], [0.32, 0.5, '#7fdcff', 0.4]] },
    moon: { c: ['#e8e6ff', '#a7a2d8', '#4a3f8c'], craters: true },
  };
  function planet(x, cx, cy, r, pal, o = {}) {
    if (r <= 0.5) return;
    const ra = o.ringA == null ? 1 : o.ringA;
    if (pal.glow) glow(x, cx, cy, r * 1.7, pal.glow, o.glowA == null ? 0.32 : o.glowA);
    const R = pal.ring && { rx: pal.ring.rx * r, ry: pal.ring.ry * r, tilt: pal.ring.tilt, bands: pal.ring.bands };
    if (R) ring(x, cx, cy, R, 'back', ra);
    if (o.behind) o.behind(R);
    ball(x, cx, cy, r, pal.c, {
      sh: 0.34, sha: 0.55, rima: 0.35,
      inner: () => {
        x.save(); x.translate(cx, cy);
        if (pal.bands) bands(x, r, pal.bands, pal.tilt);
        if (pal.craters) { const q = H.rng(5); for (let i = 0; i < 5; i++) { const a = q.range(0, TAU), d = q.range(0.1, 0.65) * r, cr = q.range(0.1, 0.2) * r, qx = Math.cos(a) * d, qy = Math.sin(a) * d; x.fillStyle = 'rgba(80,66,150,0.38)'; x.beginPath(); x.arc(qx, qy, cr, 0, TAU); x.fill(); crescent(x, qx, qy, cr, -cr * 0.3, -cr * 0.3, 'rgba(255,255,255,0.3)'); } }
        x.restore();
      },
    });
    const atA = o.atmo == null ? 0.7 : o.atmo;
    if (pal.atmo && atA > 0) { // thin bright atmosphere on the limb, strongest on the lit (upper-left) side
      x.save(); x.lineCap = 'round'; const ga0 = x.globalAlpha;
      const la = -2.25, ag = x.createLinearGradient(cx + Math.cos(la) * r, cy + Math.sin(la) * r, cx - Math.cos(la) * r, cy - Math.sin(la) * r);
      ag.addColorStop(0, H.rgba(pal.atmo, 1)); ag.addColorStop(0.55, H.rgba(pal.atmo, 0.5)); ag.addColorStop(1, H.rgba(pal.atmo, 0.08));
      x.strokeStyle = ag;
      for (const [lw, a] of [[r * 0.05, 0.08], [r * 0.028, 0.16], [r * 0.014, 0.3], [Math.max(2, r * 0.006), 0.6]]) { x.globalAlpha = ga0 * a * atA; x.lineWidth = lw; x.beginPath(); x.arc(cx, cy, r + lw * 0.15, 0, TAU); x.stroke(); }
      x.restore();
    }
    if (R) ring(x, cx, cy, R, 'front', ra);
    if (o.front) o.front(R);
  }

  // ---------- print finish: fine animated grain + soft static mottling (overlay), kills gradient banding ----------
  let GRAIN = null;
  function grainTex() {
    if (GRAIN) return GRAIN;
    const S = 256, tile = H.layer(S, S), tc = tile.getContext('2d'), img = tc.createImageData(S, S), d = img.data, r = H.rng(4242);
    for (let i = 0; i < d.length; i += 4) { const v = 128 + (r() + r() + r() - 1.5) * 92; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    tc.putImageData(img, 0, 0);
    const MW = 320, MH = 180, mot = H.layer(MW, MH), mc = mot.getContext('2d'), mi = mc.createImageData(MW, MH), md = mi.data, nz = H.makeNoise(88);
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) { const v = 128 + nz.fbm2(x * 0.035, y * 0.035, 4) * 70 + nz.n2(x * 0.22, y * 0.22) * 14, k = (y * MW + x) * 4; md[k] = md[k + 1] = md[k + 2] = v; md[k + 3] = 255; }
    mc.putImageData(mi, 0, 0);
    GRAIN = { tile, mot };
    return GRAIN;
  }
  function finish(x, W, H_, t) {
    const G = grainTex(), f = Math.floor(t * 24);
    x.save(); x.globalCompositeOperation = 'overlay';
    x.globalAlpha = 0.12; x.imageSmoothingEnabled = true; x.drawImage(G.mot, 0, 0, W, H_);
    const pat = x.createPattern(G.tile, 'repeat'); pat.setTransform(new DOMMatrix().translateSelf((f * 73) % 256, (f * 151) % 256));
    x.globalAlpha = 0.09; x.fillStyle = pat; x.fillRect(0, 0, W, H_);
    x.restore();
  }

  // ---------- eyes (big white, dark pupils) ----------
  function eye(x, ex, ey, er, o) {
    const look = o.look || [0, 0];
    if ((o.happy || 0) > 0.5) {
      x.save(); x.strokeStyle = '#ffffff'; x.lineWidth = er * 0.42; x.lineCap = 'round';
      x.beginPath(); x.arc(ex, ey + er * 0.35, er * 0.62, Math.PI * 1.15, Math.PI * 1.85); x.stroke(); x.restore(); return;
    }
    const bl = 1 - 0.92 * (o.blink || 0);
    x.save(); x.translate(ex, ey); x.scale(1, bl);
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(0, 0, er, 0, TAU); x.fill();
    const pr = er * (o.worry ? 0.5 : 0.56);
    const px = look[0] * er * 0.36, py = look[1] * er * 0.36;
    x.fillStyle = '#141638'; x.beginPath(); x.arc(px, py, pr, 0, TAU); x.fill();
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(px - pr * 0.35, py - pr * 0.4, pr * 0.32, 0, TAU); x.fill();
    x.beginPath(); x.arc(px + pr * 0.35, py + pr * 0.35, pr * 0.13, 0, TAU); x.fill();
    x.restore();
  }
  const blinkAt = (t, ph) => { const u = (t + ph) % 3.3; return u < 0.14 ? Math.sin((u / 0.14) * Math.PI) : 0; };

  // ---------- the AI: a chunky round robot with a glass brain dome ----------
  const NET = (() => {
    const r = H.rng(31), L = [[-0.6, [-0.42, 0.02, 0.44]], [0, [-0.58, -0.2, 0.2, 0.58]], [0.6, [-0.4, 0.04, 0.44]]];
    const nodes = []; L.forEach(([lx, ys], li) => ys.forEach((y) => nodes.push({ x: lx, y: y - 0.05, l: li })));
    const byL = (l) => nodes.map((n, i) => [n, i]).filter(([n]) => n.l === l).map(([, i]) => i);
    const edges = [];
    const l0 = byL(0), l1 = byL(1), l2 = byL(2);
    l0.forEach((a, k) => { const tA = [l1[k], l1[k + 1]], tB = [l1[(k + 2) % 4], l1[k + 1]]; tA.forEach((b, j) => edges.push({ a, b, b2: tB[j], w: r.range(0.2, 0.5), w2: r.range(0.6, 1) })); });
    l1.forEach((a, k) => { const tA = [l2[k % 3], l2[(k + 1) % 3]], tB = [l2[(k + 2) % 3], l2[(k + 1) % 3]]; tA.forEach((b, j) => edges.push({ a, b, b2: tB[j], w: r.range(0.2, 0.5), w2: r.range(0.6, 1) })); });
    return { nodes, edges };
  })();
  function network(x, cx, cy, dr, o) {
    const rw = o.rewire || 0, br = o.bright == null ? 0.5 : o.bright, err = o.err || 0, t = o.t || 0, s = dr * 0.82;
    const P = (i) => [cx + NET.nodes[i].x * s, cy + NET.nodes[i].y * s];
    x.save(); x.lineCap = 'round';
    NET.edges.forEach((e, k) => {
      const a = P(e.a), b0 = P(e.b), b1 = P(e.b2), m = eio(cl(rw * 1.25 - (k % 6) * 0.05));
      const b = [lerp(b0[0], b1[0], m), lerp(b0[1], b1[1], m)], w = lerp(e.w, e.w2, m);
      const col = H.mix(H.mix('#7a5cff', '#ffd23f', w * (0.4 + br * 0.6)), '#ff3b5c', err);
      x.strokeStyle = H.rgba(col, 0.55 + 0.45 * w); x.lineWidth = dr * (0.025 + 0.05 * w);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - dr * 0.08;
      x.beginPath(); x.moveTo(a[0], a[1]); x.quadraticCurveTo(mx, my, b[0], b[1]); x.stroke();
      // a little signal dot running along
      const u = (t * 0.9 + k * 0.137) % 1, v = 1 - u;
      const qx = v * v * a[0] + 2 * v * u * mx + u * u * b[0], qy = v * v * a[1] + 2 * v * u * my + u * u * b[1];
      x.fillStyle = H.rgba(err > 0.3 ? '#ffb0bf' : '#fff6c8', 0.8 * (0.4 + br * 0.6)); x.beginPath(); x.arc(qx, qy, dr * 0.035, 0, TAU); x.fill();
    });
    NET.nodes.forEach((n, i) => {
      const [nx, ny] = P(i), pulse = 0.5 + 0.5 * Math.sin(t * 3 + i * 1.3);
      const col = H.mix(H.mix('#9b7bff', '#ffe066', br), '#ff4a66', err);
      glow(x, nx, ny, dr * (0.2 + 0.22 * br), col, 0.35 + 0.4 * br);
      x.fillStyle = H.rgba(col); x.beginPath(); x.arc(nx, ny, dr * (0.085 + 0.03 * br), 0, TAU); x.fill();
      x.fillStyle = 'rgba(255,255,255,0.75)'; x.beginPath(); x.arc(nx - dr * 0.025, ny - dr * 0.025, dr * 0.035, 0, TAU); x.fill();
    });
    x.restore();
  }
  function robot(x, cx, cy, R, o = {}) {
    if (R < 1) return;
    const t = o.t || 0, red = o.red || 0, happy = o.happy || 0, worry = o.worry || 0;
    if (red > 0) glow(x, cx, cy - R * 0.4, R * 2.2, '#ff3b5c', 0.5 * red);
    // thruster flame
    const fl = 1 + 0.14 * Math.sin(t * 29) + 0.08 * Math.sin(t * 13.7);
    glow(x, cx, cy + R * 1.25, R * 0.95, '#ff9a3d', 0.4);
    x.fillStyle = '#ff8a3d'; x.beginPath(); x.moveTo(cx - R * 0.25, cy + R * 0.9);
    x.quadraticCurveTo(cx - R * 0.2, cy + R * (1.25 + 0.2 * fl), cx, cy + R * (1.35 + 0.42 * fl)); x.quadraticCurveTo(cx + R * 0.2, cy + R * (1.25 + 0.2 * fl), cx + R * 0.25, cy + R * 0.9); x.fill();
    x.fillStyle = '#ffd94a'; x.beginPath(); x.moveTo(cx - R * 0.13, cy + R * 0.92);
    x.quadraticCurveTo(cx - R * 0.1, cy + R * (1.15 + 0.1 * fl), cx, cy + R * (1.2 + 0.22 * fl)); x.quadraticCurveTo(cx + R * 0.1, cy + R * (1.15 + 0.1 * fl), cx + R * 0.13, cy + R * 0.92); x.fill();
    x.fillStyle = '#16307a'; rr(x, cx - R * 0.32, cy + R * 0.78, R * 0.64, R * 0.22, R * 0.08); x.fill();
    // arms
    for (const sd of [-1, 1]) {
      const up = (o.armUp || 0) * (sd > 0 ? 1 : 0.6), ang = sd * (0.55 + 0.12 * Math.sin(t * 2.2 + sd)) - sd * up * 1.6;
      const sx = cx + sd * R * 0.86, sy = cy + R * 0.12, ex = sx + Math.sin(ang) * R * 0.55, ey = sy + Math.cos(ang) * R * 0.55;
      x.strokeStyle = '#1d5aa6'; x.lineWidth = R * 0.24; x.lineCap = 'round'; x.beginPath(); x.moveTo(sx, sy); x.lineTo(ex, ey); x.stroke();
      ball(x, ex, ey, R * 0.17, C.teal, { sha: 0.4 });
    }
    // brain dome (glass) with the glowing network inside
    const dr = R * 0.76, dx = cx, dy = cy - R * 1.02;
    glow(x, dx, dy, dr * 2.0, red > 0.2 ? '#ff3b5c' : '#58e6ff', 0.22 + 0.25 * (o.brainGlow || 0) + 0.2 * red);
    x.save(); x.beginPath(); x.arc(dx, dy, dr, 0, TAU); x.clip();
    const dg = x.createRadialGradient(dx - dr * 0.3, dy - dr * 0.3, 0, dx, dy, dr * 1.1);
    dg.addColorStop(0, '#2a3a9c'); dg.addColorStop(0.6, '#18206a'); dg.addColorStop(1, '#0d1146');
    x.fillStyle = dg; x.fillRect(dx - dr, dy - dr, dr * 2, dr * 2);
    if (red > 0) { x.fillStyle = H.rgba('#ff3b5c', 0.3 * red); x.fillRect(dx - dr, dy - dr, dr * 2, dr * 2); }
    network(x, dx, dy - dr * 0.12, dr * 0.92, o);
    x.restore();
    crescent(x, dx, dy, dr, dr * 0.1, dr * 0.12, 'rgba(190,250,255,0.55)');
    crescent(x, dx, dy, dr, -dr * 0.22, -dr * 0.2, 'rgba(8,10,50,0.28)');
    x.save(); x.strokeStyle = 'rgba(255,255,255,0.6)'; x.lineWidth = dr * 0.09; x.lineCap = 'round';
    x.beginPath(); x.arc(dx, dy, dr * 0.74, Math.PI * 1.08, Math.PI * 1.36); x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.6)'; x.beginPath(); x.arc(dx + dr * 0.74 * Math.cos(Math.PI * 1.5), dy - dr * 0.74, dr * 0.05, 0, TAU); x.fill(); x.restore();
    // collar
    x.fillStyle = '#1b4c9c'; rr(x, cx - R * 0.6, cy - R * 0.84, R * 1.2, R * 0.26, R * 0.13); x.fill();
    x.fillStyle = 'rgba(160,240,255,0.5)'; rr(x, cx - R * 0.5, cy - R * 0.81, R * 0.7, R * 0.06, R * 0.03); x.fill();
    // body
    ball(x, cx, cy, R, C.teal, { sha: 0.5 });
    // visor face
    const vw = R * 1.36, vh = R * 0.78, vx = cx - vw / 2 + R * 0.02, vy = cy - R * 0.42;
    x.fillStyle = '#0c1145'; rr(x, vx, vy + R * 0.05, vw, vh, R * 0.34); x.fill();
    const vg = x.createLinearGradient(vx, vy, vx + vw, vy + vh); vg.addColorStop(0, '#26338e'); vg.addColorStop(0.5, '#151c5c'); vg.addColorStop(1, '#0d1246');
    x.fillStyle = vg; rr(x, vx, vy, vw, vh, R * 0.34); x.fill();
    x.fillStyle = 'rgba(160,240,255,0.22)'; rr(x, vx + R * 0.16, vy + R * 0.07, vw * 0.45, R * 0.07, R * 0.035); x.fill();
    const ey = vy + vh * 0.48, er = R * 0.19, look = o.look || [0, 0];
    for (const sd of [-1, 1]) eye(x, cx + sd * R * 0.3, ey, er, { look, blink: o.blink, happy, worry: worry > 0.5 });
    // brows when worried
    if (worry > 0.02) {
      x.save(); x.globalAlpha *= cl(worry * 2); x.strokeStyle = '#9ff7ff'; x.lineWidth = R * 0.065; x.lineCap = 'round';
      for (const sd of [-1, 1]) { x.beginPath(); x.moveTo(cx + sd * R * 0.46, ey - er * 1.05); x.lineTo(cx + sd * R * 0.16, ey - er * 1.5); x.stroke(); }
      x.restore();
    }
    // mouth
    x.save(); x.strokeStyle = '#9ff7ff'; x.lineWidth = R * 0.06; x.lineCap = 'round'; x.beginPath();
    const my = vy + vh * 0.86;
    if (worry > 0.5) { x.moveTo(cx - R * 0.12, my); x.quadraticCurveTo(cx - R * 0.06, my - R * 0.06, cx, my); x.quadraticCurveTo(cx + R * 0.06, my + R * 0.06, cx + R * 0.12, my); }
    else if (happy > 0.5) { x.arc(cx, my - R * 0.06, R * 0.12, 0.15 * Math.PI, 0.85 * Math.PI); }
    else { x.arc(cx, my - R * 0.1, R * 0.1, 0.3 * Math.PI, 0.7 * Math.PI); }
    x.stroke(); x.restore();
    // belly lights
    ['#ffd23f', '#ff5d8f', '#56e8ff'].forEach((c, i) => { const bx = cx + (i - 1) * R * 0.2, by = cy + R * 0.58; glow(x, bx, by, R * 0.12, c, 0.5); x.fillStyle = c; x.beginPath(); x.arc(bx, by, R * 0.055, 0, TAU); x.fill(); });
    // sweat drop
    if (worry > 0.3) {
      const sx = cx + R * 0.82, sy = cy - R * 0.38 + (t * 40 % (R * 0.3));
      x.save(); x.globalAlpha *= cl((worry - 0.3) * 3); x.fillStyle = '#7fe6ff';
      x.beginPath(); x.moveTo(sx, sy - R * 0.16); x.quadraticCurveTo(sx + R * 0.09, sy, sx, sy + R * 0.06); x.quadraticCurveTo(sx - R * 0.09, sy, sx, sy - R * 0.16); x.fill(); x.restore();
    }
  }

  // ---------- creatures: little cat and dog (training data) ----------
  function cat(x, cx, cy, r, o = {}) {
    if (r < 1) return;
    const t = o.t || 0;
    x.save(); x.translate(cx, cy); x.rotate(o.rot || 0);
    x.strokeStyle = C.orange[2]; x.lineWidth = r * 0.24; x.lineCap = 'round';
    x.beginPath(); x.moveTo(r * 0.6, r * 0.55); x.quadraticCurveTo(r * 1.4, r * 0.55 + Math.sin(t * 3) * r * 0.12, r * 1.18, -r * 0.2); x.stroke();
    for (const sd of [-1, 1]) {
      x.fillStyle = sd < 0 ? C.orange[1] : '#e8693a'; x.strokeStyle = x.fillStyle; x.lineWidth = r * 0.16; x.lineJoin = 'round';
      x.beginPath(); x.moveTo(sd * r * 0.82, -r * 0.3); x.lineTo(sd * r * 0.66, -r * 1.08); x.lineTo(sd * r * 0.14, -r * 0.8); x.closePath(); x.fill(); x.stroke();
      x.fillStyle = '#ff9fb4'; x.beginPath(); x.moveTo(sd * r * 0.66, -r * 0.48); x.lineTo(sd * r * 0.62, -r * 0.9); x.lineTo(sd * r * 0.32, -r * 0.74); x.closePath(); x.fill();
    }
    ball(x, 0, 0, r, C.orange, { sha: 0.45, inner: () => {
      x.fillStyle = 'rgba(200,70,40,0.55)';
      for (const k of [-1, 0, 1]) { rr(x, k * r * 0.17 - r * 0.045, -r * 0.92, r * 0.09, r * 0.3, r * 0.045); x.fill(); }
      x.fillStyle = 'rgba(255,240,220,0.9)'; x.beginPath(); x.ellipse(0, r * 0.42, r * 0.42, r * 0.3, 0, 0, TAU); x.fill();
    } });
    for (const sd of [-1, 1]) eye(x, sd * r * 0.36, -r * 0.08, r * 0.25, { look: o.look, blink: o.blink, happy: o.happy });
    x.fillStyle = '#ff6f8e'; x.beginPath(); x.moveTo(-r * 0.09, r * 0.22); x.lineTo(r * 0.09, r * 0.22); x.lineTo(0, r * 0.33); x.closePath(); x.fill();
    x.strokeStyle = '#7a2e2e'; x.lineWidth = r * 0.05; x.lineCap = 'round'; x.beginPath();
    x.arc(-r * 0.08, r * 0.36, r * 0.08, 0.1 * Math.PI, 0.9 * Math.PI); x.moveTo(r * 0.16, r * 0.36 + r * 0.025); x.arc(r * 0.08, r * 0.36, r * 0.08, 0.1 * Math.PI, 0.9 * Math.PI); x.stroke();
    x.restore();
  }
  function dog(x, cx, cy, r, o = {}) {
    if (r < 1) return;
    const t = o.t || 0;
    x.save(); x.translate(cx, cy); x.rotate(o.rot || 0);
    ball(x, 0, 0, r, C.tan, { sha: 0.45, inner: () => {
      x.fillStyle = 'rgba(150,85,40,0.55)'; x.beginPath(); x.arc(r * 0.38, -r * 0.2, r * 0.36, 0, TAU); x.fill();
      x.fillStyle = '#fff3dc'; x.beginPath(); x.ellipse(0, r * 0.36, r * 0.4, r * 0.3, 0, 0, TAU); x.fill();
    } });
    for (const sd of [-1, 1]) {
      x.save(); x.translate(sd * r * 0.86, -r * 0.18); x.rotate(sd * (0.35 + 0.08 * Math.sin(t * 4 + sd)));
      x.fillStyle = '#8b4f2c'; x.beginPath(); x.ellipse(0, r * 0.18, r * 0.27, r * 0.55, 0, 0, TAU); x.fill();
      x.fillStyle = 'rgba(255,200,150,0.25)'; x.beginPath(); x.ellipse(-sd * r * 0.06, r * 0.05, r * 0.1, r * 0.3, 0, 0, TAU); x.fill();
      x.restore();
    }
    for (const sd of [-1, 1]) eye(x, sd * r * 0.34, -r * 0.12, r * 0.23, { look: o.look, blink: o.blink, happy: o.happy });
    x.fillStyle = '#2a1a2a'; x.beginPath(); x.ellipse(0, r * 0.22, r * 0.13, r * 0.09, 0, 0, TAU); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.6)'; x.beginPath(); x.arc(-r * 0.04, r * 0.19, r * 0.03, 0, TAU); x.fill();
    x.fillStyle = '#ff6f8e'; rr(x, -r * 0.08, r * 0.38, r * 0.16, r * 0.17, r * 0.08); x.fill();
    x.restore();
  }
  const creature = (x, kind, cx, cy, r, o) => (kind === 'cat' ? cat : dog)(x, cx, cy, r, o);

  // speech bubble with a tail
  function bubble(x, cx, cy, w, h, tx, ty, s, col) {
    if (s <= 0.01) return;
    x.save(); x.translate(cx, cy); x.scale(s, s);
    x.fillStyle = 'rgba(10,8,46,0.4)'; rr(x, -w / 2, -h / 2 + 8, w, h, h / 2); x.fill();
    x.fillStyle = col || '#ffffff';
    x.beginPath(); x.moveTo(-w * 0.18, h * 0.3); x.lineTo((tx - cx) / s, (ty - cy) / s); x.lineTo(-w * 0.02, h * 0.42); x.fill();
    rr(x, -w / 2, -h / 2, w, h, h / 2); x.fill();
    x.restore();
  }
  function badge(x, cx, cy, r, ok, s) {
    if (s <= 0.01) return;
    x.save(); x.translate(cx, cy); x.scale(s, s);
    glow(x, 0, 0, r * 2.4, ok ? C.green : C.red, 0.45);
    ball(x, 0, 0, r, ok ? ['#9fffc8', C.green, '#178a5a'] : ['#ff9aa8', C.red, '#9c1638'], { sha: 0.4 });
    x.strokeStyle = '#ffffff'; x.lineWidth = r * 0.26; x.lineCap = 'round'; x.lineJoin = 'round'; x.beginPath();
    if (ok) { x.moveTo(-r * 0.42, 0); x.lineTo(-r * 0.1, r * 0.32); x.lineTo(r * 0.45, -r * 0.3); }
    else { x.moveTo(-r * 0.34, -r * 0.34); x.lineTo(r * 0.34, r * 0.34); x.moveTo(r * 0.34, -r * 0.34); x.lineTo(-r * 0.34, r * 0.34); }
    x.stroke(); x.restore();
  }
  function flare(x, cx, cy, k, t, seed) {
    if (k <= 0) return;
    glow(x, cx, cy, 420 * (0.6 + 0.4 * k), '#ffcf5a', 0.55 * k);
    glow(x, cx, cy, 160, '#fff6d0', 0.6 * k);
    x.save(); x.translate(cx, cy); x.rotate(t * 0.25); x.globalAlpha *= 0.32 * k; x.fillStyle = '#ffe28a';
    for (let i = 0; i < 12; i++) { x.rotate(TAU / 12); x.beginPath(); x.moveTo(0, -12); x.lineTo(330 + 60 * (i % 2), 0); x.lineTo(0, 12); x.fill(); }
    x.restore();
  }
  function burst(x, cx, cy, age, seed, spread) {
    if (age < 0 || age > 1.4) return;
    const r = H.rng(seed);
    for (let i = 0; i < 18; i++) {
      const a = r.range(0, TAU), d = (spread || 300) * r.range(0.45, 1) * eo(cl(age / 0.9)), sz = r.range(7, 16) * (1 - cl(age / 1.4));
      spark(x, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, sz, r.pick(['#ffffff', '#ffe28a', '#9ff7ff', '#ffb0d0']), 1);
    }
  }

  // ---------- galaxy of examples (precomputed) ----------
  let GAL = null;
  function galaxyPts() {
    if (GAL) return GAL;
    const r = H.rng(901); GAL = [];
    for (let i = 0; i < 2600; i++) {
      const arm = i % 3, u = Math.pow(r(), 0.85), rr2 = 260 + 5300 * u;
      const ang = arm * (TAU / 3) + rr2 * 0.00075 + r.gauss() * (0.16 + 0.25 * (1 - u));
      GAL.push({ rr: rr2 * (1 + r.gauss() * 0.04), a: ang, s: r.range(1.2, 3.2), c: r.pick(['#ff9a4a', '#ffcc7a', '#ecb676', '#ffffff', '#9ff7ff', '#ff8fb8']) });
    }
    return GAL;
  }
  function galaxy(x, cx, cy, s, rot, a) {
    if (a <= 0.01) return;
    glow(x, cx, cy, 5600 * s * 0.55, '#8a5cff', 0.35 * a);
    glow(x, cx, cy, 5600 * s * 0.22, '#ffcf7a', 0.4 * a);
    x.save(); x.globalAlpha = a;
    for (const p of galaxyPts()) {
      const ang = p.a + rot, d = p.rr * s;
      if (d < 14) continue;
      const px = cx + Math.cos(ang) * d, py = cy + Math.sin(ang) * d * 0.52;
      if (px < -5 || px > 1285 || py < -5 || py > 725) continue;
      x.fillStyle = p.c; x.beginPath(); x.arc(px, py, p.s, 0, TAU); x.fill();
    }
    x.restore();
  }

  // ---------- header pill ----------

  window.FVS = { C, PL, sky, finish, planet, robot, cat, dog, bubble, pill, arrow, badge, galaxy, burst, flare, glow, spark, ball, text, network };
}
