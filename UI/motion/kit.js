// Relio Motion kit: ready-made looks, fonts, text animations, blocks, decorations and transitions.
// A video is a small JSON spec, played by Kit.build(spec). The model only chooses and fills in pieces (see KIT_GUIDE in
// api/_motion-kit.js, which lists the same names); it writes no drawing code, so cheap models can't draw a bad frame.
// Every frame is a pure function of t: all randomness is seeded.
(function () {
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const prog = (t, start, dur) => clamp((t - start) / dur);
  const out = (u) => 1 - Math.pow(1 - clamp(u), 3);
  const inn = (u) => Math.pow(clamp(u), 3);
  const back = (u) => { u = clamp(u); const k = 1.70158; return 1 + (k + 1) * Math.pow(u - 1, 3) + k * Math.pow(u - 1, 2); };
  function rng(seed) {
    let a = seed >>> 0 || 1;
    return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const bright = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
  const dot = (c, x, y, r) => { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); };

  // Google Fonts by name; only the ones a video uses are loaded.
  const FONTS = ['Anton', 'Archivo Black', 'Bebas Neue', 'Oswald', 'Montserrat', 'Poppins', 'Sora', 'Space Grotesk', 'Inter', 'Rubik',
    'Fredoka', 'Nunito', 'Baloo 2', 'Playfair Display', 'DM Serif Display', 'Fraunces', 'Caveat', 'Permanent Marker'];

  // ---------- backgrounds: each fills the whole frame and keeps moving ----------
  function bgGlow(c, W, H, t, p) {
    const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, p.bg); g.addColorStop(1, p.bg2); c.fillStyle = g; c.fillRect(0, 0, W, H);
    [[p.accent, 0.25, 0.3, 0.31, 0.9], [p.accent2, 0.78, 0.72, 0.23, 2.1], [p.accent, 0.6, 0.15, 0.17, 4.2]].forEach(([col, x, y, sp, ph], i) => {
      const cx = W * (x + 0.12 * Math.sin(t * sp + ph)), cy = H * (y + 0.1 * Math.cos(t * sp * 0.8 + ph)), r = Math.max(W, H) * (0.45 + 0.05 * Math.sin(t * 0.6 + i));
      const rg = c.createRadialGradient(cx, cy, 0, cx, cy, r); rg.addColorStop(0, rgba(col, 0.34)); rg.addColorStop(1, rgba(col, 0)); c.fillStyle = rg; c.fillRect(0, 0, W, H);
    });
  }
  function bgSpace(c, W, H, t, p) {
    const g = c.createLinearGradient(0, 0, W * 0.4, H); g.addColorStop(0, p.bg); g.addColorStop(1, p.bg2); c.fillStyle = g; c.fillRect(0, 0, W, H);
    const neb = c.createRadialGradient(W * 0.75, H * 0.3, 0, W * 0.75, H * 0.3, Math.max(W, H) * 0.6); neb.addColorStop(0, rgba(p.accent2, 0.22)); neb.addColorStop(1, rgba(p.accent2, 0)); c.fillStyle = neb; c.fillRect(0, 0, W, H);
    const r = rng(7);
    for (let i = 0; i < 170; i++) {
      const depth = 0.3 + r() * 0.7, x = ((r() * W - t * 14 * depth) % W + W) % W, y = r() * H, tw = 0.55 + 0.45 * Math.sin(t * (1 + r() * 3) + r() * 9);
      c.fillStyle = `rgba(255,255,255,${0.75 * tw * depth})`; dot(c, x, y, (0.6 + r() * 1.9) * depth * W / 1080 * 1.6);
    }
  }
  function bgPaper(c, W, H, t, p) {
    c.fillStyle = p.bg; c.fillRect(0, 0, W, H);
    const r = rng(11);
    for (let i = 0; i < 9; i++) {
      const col = i % 3 === 0 ? p.accent2 : i % 3 === 1 ? p.accent : p.bg2, x = W * (r() + 0.04 * Math.sin(t * 0.3 + i)), y = H * (r() + 0.03 * Math.cos(t * 0.25 + i * 2)), rad = Math.max(W, H) * (0.16 + r() * 0.22);
      for (let k = 0; k < 3; k++) { const rg = c.createRadialGradient(x, y, rad * 0.2 * k, x, y, rad * (1 - k * 0.12)); rg.addColorStop(0, rgba(col, 0.1)); rg.addColorStop(0.75, rgba(col, 0.08)); rg.addColorStop(1, rgba(col, 0)); c.fillStyle = rg; c.fillRect(0, 0, W, H); }
    }
  }
  function bgLamp(c, W, H, t, p) {
    const B = 1 + 0.04 * Math.sin(t * 5.3) + 0.025 * Math.sin(t * 13.7 + 1), cx = W / 2 + Math.sin(t * 0.9) * W * 0.008, cy = H * 0.43;
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.75);
    [[0, [255, 236, 178]], [0.2, [255, 204, 114]], [0.45, [236, 136, 54]], [0.7, [160, 62, 22]], [1, [48, 13, 5]]].forEach(([o, col]) => g.addColorStop(o, `rgb(${col.map((v) => Math.min(255, v * B) | 0).join(',')})`));
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  }
  function bgClean(c, W, H, t, p) {
    c.fillStyle = p.bg; c.fillRect(0, 0, W, H);
    const m = Math.min(W, H);
    c.fillStyle = rgba(p.accent, 0.16); dot(c, W * 0.86 + Math.sin(t * 0.5) * m * 0.03, H * 0.14 + Math.cos(t * 0.4) * m * 0.03, m * 0.3);
    c.fillStyle = rgba(p.accent2, 0.16); dot(c, W * 0.1 + Math.cos(t * 0.45) * m * 0.03, H * 0.88 + Math.sin(t * 0.35) * m * 0.03, m * 0.36);
    c.save(); c.translate(W * 0.84, H * 0.86); c.rotate(t * 0.25); c.strokeStyle = rgba(p.text, 0.14); c.lineWidth = m * 0.012; c.strokeRect(-m * 0.1, -m * 0.1, m * 0.2, m * 0.2); c.restore();
    c.strokeStyle = rgba(p.text, 0.1); c.lineWidth = m * 0.008; c.beginPath(); c.arc(W * 0.12, H * 0.12, m * 0.14, t * 0.4, t * 0.4 + Math.PI * 1.3); c.stroke();
  }
  function bgSunset(c, W, H, t, p) {
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, p.bg); g.addColorStop(0.55, p.bg2); g.addColorStop(1, p.accent2); c.fillStyle = g; c.fillRect(0, 0, W, H);
    const sy = H * (0.72 + 0.01 * Math.sin(t * 0.5)), sr = Math.min(W, H) * 0.42, sg = c.createRadialGradient(W / 2, sy, 0, W / 2, sy, sr * 1.6);
    sg.addColorStop(0, rgba(p.accent, 0.55)); sg.addColorStop(0.5, rgba(p.accent, 0.18)); sg.addColorStop(1, rgba(p.accent, 0)); c.fillStyle = sg; c.fillRect(0, 0, W, H);
    for (let i = 0; i < 3; i++) {
      c.fillStyle = rgba(p.bg, 0.16 + i * 0.1); c.beginPath(); c.moveTo(0, H);
      for (let x = 0; x <= W; x += W / 40) c.lineTo(x, H * (0.86 + i * 0.045) + Math.sin(x / W * (5 + i * 2) + t * (0.5 + i * 0.25) + i * 2) * H * 0.016);
      c.lineTo(W, H); c.fill();
    }
  }

  // ---------- finishing passes ----------
  function grain(c, W, H, t, a = 0.05) {
    const r = rng(Math.floor(t * 12) + 5), s = Math.max(2, W / 540);
    for (let i = 0; i < 700; i++) { c.fillStyle = r() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`; c.fillRect(r() * W, r() * H, s, s); }
  }
  function vignette(c, W, H, a) {
    const v = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${a})`); c.fillStyle = v; c.fillRect(0, 0, W, H);
  }
  function finishPaper(c, W, H, t) {
    const r = rng(3); c.strokeStyle = 'rgba(90,70,50,0.05)'; c.lineWidth = Math.max(1, W / 900);
    for (let i = 0; i < 260; i++) { const x = r() * W, y = r() * H, l = (8 + r() * 30) * W / 1080, a = r() * TAU; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); }
    grain(c, W, H, 0, 0.035); vignette(c, W, H, 0.12);
  }
  function finishLamp(c, W, H, t) {
    const INK = 'rgb(22,9,5)', HOLE = '#ffe3a8', k = W / 1080;
    c.fillStyle = INK; c.fillRect(0, 0, W, 26 * k);
    for (let x = -20 * k; x < W + 40 * k; x += 40 * k) { c.beginPath(); c.arc(x + 20 * k, 25 * k, 20 * k, 0, Math.PI); c.fill(); }
    c.fillStyle = HOLE; for (let x = 8 * k; x < W; x += 16 * k) dot(c, x, 11 * k, 2.4 * k);
    const r = rng(31); c.fillStyle = INK; c.fillRect(0, H - 28 * k, W, 28 * k);
    for (let x = -10; x < W + 10; x += (6 + r() * 7) * k) {
      const h = (18 + r() * 46) * k, lean = ((r() - 0.5) * 28 + Math.sin(t * 1.2 + x * 0.02) * 3) * k, w = (2.5 + r() * 3) * k, y = H - 24 * k;
      c.beginPath(); c.moveTo(x - w, y); c.quadraticCurveTo(x + lean * 0.3, y - h * 0.6, x + lean, y - h); c.quadraticCurveTo(x + lean * 0.3 + w * 0.6, y - h * 0.55, x + w, y); c.fill();
    }
    c.fillStyle = 'rgba(70,25,8,0.05)'; for (let y = 0; y < H; y += 4 * k) c.fillRect(0, y, W, 1.2 * k);
    grain(c, W, H, t, 0.06); vignette(c, W, H, 0.45);
  }

  // Looks. `plaque` hangs text on dark cut-paper signs (shadow theatre); `ink` is the sign color.
  const THEMES = {
    neon: { palette: { bg: '#0a0c1c', bg2: '#1a1040', text: '#ffffff', accent: '#5aa9ff', accent2: '#ff6b6b' }, head: 'Sora', body: 'Inter', bg: bgGlow, finish: (c, W, H, t) => { grain(c, W, H, t, 0.04); vignette(c, W, H, 0.35); }, glow: true },
    space: { palette: { bg: '#0d1440', bg2: '#3a1c6e', text: '#ffffff', accent: '#5fd4ff', accent2: '#ff7ac0' }, head: 'Fredoka', body: 'Nunito', bg: bgSpace, finish: (c, W, H, t) => vignette(c, W, H, 0.3), glow: true },
    paper: { palette: { bg: '#f6efe0', bg2: '#8fb9d8', text: '#2b2b3a', accent: '#2f6fa8', accent2: '#e2725b' }, head: 'Fraunces', body: 'Nunito', bg: bgPaper, finish: finishPaper },
    shadow: { palette: { bg: '#301005', bg2: '#ec8836', text: '#ffe3a8', accent: '#ffe3a8', accent2: '#a8dcff' }, head: 'Archivo Black', body: 'Nunito', bg: bgLamp, finish: finishLamp, plaque: true, ink: 'rgb(22,9,5)' },
    clean: { palette: { bg: '#f5f3ee', bg2: '#e8e4da', text: '#14151a', accent: '#2563eb', accent2: '#f97316' }, head: 'Archivo Black', body: 'Inter', bg: bgClean, finish: (c, W, H, t) => grain(c, W, H, 0, 0.02) },
    sunset: { palette: { bg: '#2a1a5e', bg2: '#c2437a', text: '#ffffff', accent: '#ffd166', accent2: '#ff8a5c' }, head: 'Poppins', body: 'Poppins', bg: bgSunset, finish: (c, W, H, t) => { grain(c, W, H, t, 0.035); vignette(c, W, H, 0.25); }, glow: true },
  };

  // ---------- decorations, drawn behind the content of a scene ----------
  const DECOR = {
    orbits(c, W, H, t, lt, p) {
      const m = Math.min(W, H), cx = W / 2, cy = H / 2;
      [[0.46, 0.2, -0.35, p.accent, 0.5], [0.4, 0.26, 0.5, p.accent2, 0.75], [0.52, 0.14, 0.1, p.accent, 1.1]].forEach(([rx, ry, rot, col, sp], i) => {
        c.save(); c.translate(cx, cy); c.rotate(rot + Math.sin(t * 0.3 + i) * 0.06); c.strokeStyle = rgba(col, 0.55); c.lineWidth = m * 0.004;
        c.beginPath(); c.ellipse(0, 0, m * rx, m * ry, 0, 0, TAU * out(prog(lt, i * 0.15, 0.9))); c.stroke();
        const a = t * sp + i * 2; c.fillStyle = col; c.shadowColor = col; c.shadowBlur = m * 0.03; dot(c, Math.cos(a) * m * rx, Math.sin(a) * m * ry, m * 0.012); c.restore();
      });
    },
    particles(c, W, H, t, lt, p) {
      const r = rng(21), a = out(prog(lt, 0, 0.6));
      for (let i = 0; i < 46; i++) {
        const sp = 0.03 + r() * 0.07, x = r() * W + Math.sin(t * (0.4 + r()) + i) * W * 0.02, y = ((r() - t * sp) % 1 + 1) % 1 * H, s = (2 + r() * 6) * W / 1080;
        c.fillStyle = rgba(i % 3 ? p.accent : p.accent2, (0.25 + r() * 0.5) * a); dot(c, x, y, s);
      }
    },
    rings(c, W, H, t, lt, p) {
      const m = Math.max(W, H);
      for (let i = 0; i < 4; i++) { const u = ((t * 0.22 + i / 4) % 1); c.strokeStyle = rgba(i % 2 ? p.accent2 : p.accent, 0.4 * (1 - u) * out(prog(lt, 0, 0.5))); c.lineWidth = m * 0.004; c.beginPath(); c.arc(W / 2, H / 2, m * (0.08 + u * 0.55), 0, TAU); c.stroke(); }
    },
    rays(c, W, H, t, lt, p) {
      const m = Math.hypot(W, H); c.save(); c.translate(W / 2, H / 2); c.rotate(t * 0.12);
      for (let i = 0; i < 14; i++) { c.rotate(TAU / 14); c.fillStyle = rgba(i % 2 ? p.accent : p.accent2, 0.09 * out(prog(lt, 0, 0.7))); c.beginPath(); c.moveTo(0, 0); c.lineTo(m, -m * 0.06); c.lineTo(m, m * 0.06); c.fill(); }
      c.restore();
    },
    confetti(c, W, H, t, lt, p) {
      const r = rng(41), k = W / 1080;
      for (let i = 0; i < 70; i++) {
        const x = r() * W + Math.sin(lt * (1 + r() * 2) + i) * 30 * k, v = 0.25 + r() * 0.45, y = ((r() * 1.2 - 0.3 + lt * v) % 1.3) * H - H * 0.1, col = [p.accent, p.accent2, p.text][i % 3];
        c.save(); c.translate(x, y); c.rotate(lt * (2 + r() * 4) + i); c.fillStyle = rgba(col, 0.85); c.fillRect(-9 * k, -5 * k, 18 * k, 10 * k); c.restore();
      }
    },
    waves(c, W, H, t, lt, p) {
      for (let i = 0; i < 3; i++) {
        c.fillStyle = rgba(i % 2 ? p.accent2 : p.accent, 0.16 * out(prog(lt, i * 0.1, 0.6))); c.beginPath(); c.moveTo(0, H);
        for (let x = 0; x <= W; x += W / 48) c.lineTo(x, H * (0.8 + i * 0.05) + Math.sin(x / W * (6 + i * 2) + t * (0.9 + i * 0.3) + i) * H * 0.02);
        c.lineTo(W, H); c.fill();
      }
    },
    planet(c, W, H, t, lt, p) {
      const m = Math.min(W, H), r = m * 0.15 * back(prog(lt, 0.1, 0.7)), x = W * 0.86 + Math.sin(t * 0.3) * m * 0.02, y = H * 0.86 + Math.cos(t * 0.25) * m * 0.015;
      if (r <= 0) return;
      c.save(); c.translate(x, y); c.rotate(-0.35);
      c.strokeStyle = rgba(p.accent, 0.8); c.lineWidth = r * 0.12; c.beginPath(); c.ellipse(0, 0, r * 1.7, r * 0.42, 0, Math.PI, TAU); c.stroke();
      const g = c.createLinearGradient(-r, -r, r, r); g.addColorStop(0, p.accent2); g.addColorStop(1, p.bg2); c.fillStyle = g; dot(c, 0, 0, r);
      c.fillStyle = 'rgba(255,255,255,0.14)'; c.beginPath(); c.ellipse(-r * 0.2, -r * 0.35, r * 0.6, r * 0.22, 0, 0, TAU); c.fill();
      c.beginPath(); c.ellipse(0, 0, r * 1.7, r * 0.42, 0, 0, Math.PI); c.stroke(); c.restore();
    },
    grid(c, W, H, t, lt, p) {
      const s = Math.min(W, H) / 12, a = out(prog(lt, 0, 0.6)), off = (t * s * 0.25) % s; c.fillStyle = rgba(p.text, 0.16 * a);
      for (let y = -s + off; y < H + s; y += s) for (let x = -s + off; x < W + s; x += s) dot(c, x, y, s * 0.045);
    },
  };

  // ---------- text ----------
  /** "Make it *move*" -> words, with the starred ones marked as accent. */
  function parseWords(text) {
    let on = false;
    return String(text ?? '').trim().split(/\s+/).filter(Boolean).map((raw) => {
      let s = raw; if (s.startsWith('*')) { on = true; s = s.slice(1); }
      const accent = on; if (s.endsWith('*')) { on = false; s = s.replace(/\*+$/, ''); }
      return { s: s.replaceAll('*', ''), accent };
    }).filter((w) => w.s);
  }
  /** Wraps and shrinks until the words fit maxW in maxLines; a single long word scales down to fit. */
  function fitText(c, words, font, maxW, maxLines, size, min) {
    let L;
    for (let s = size; ; s *= 0.94) {
      if (s < min) s = min;
      c.font = font(s); const space = c.measureText(' ').width, lines = [];
      let line = { words: [], w: 0 };
      for (const word of words) {
        const w = c.measureText(word.s).width;
        if (line.words.length && line.w + space + w > maxW) { lines.push(line); line = { words: [], w: 0 }; }
        line.words.push({ ...word, x: line.w ? line.w + space : 0, w }); line.w = line.words.at(-1).x + w;
      }
      if (line.words.length) lines.push(line);
      const w = Math.max(1, ...lines.map((l) => l.w));
      L = { size: s, lines, w, lineH: s * 1.1, h: lines.length * s * 1.1, font, k: 1 };
      if ((lines.length <= maxLines && w <= maxW) || s === min) break;
    }
    if (L.w > maxW) { L.k = maxW / L.w; L.h *= L.k; L.w = maxW; }
    return L;
  }
  const ANIMS = ['words', 'letters', 'rise', 'type', 'slam', 'fade'];
  function drawText(c, L, cx, top, lt, anim, color, accent, glow) {
    c.save(); c.translate(cx, top); c.scale(L.k, L.k); c.font = L.font(L.size); c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    if (glow) { c.shadowColor = 'rgba(0,0,0,0.35)'; c.shadowBlur = L.size * 0.12; c.shadowOffsetY = L.size * 0.03; }
    const h = L.lines.length * L.lineH, width = L.w / L.k;
    if (anim === 'slam') { const p = out(prog(lt, 0, 0.32)), s = lerp(2.3, 1, p); c.globalAlpha *= p; c.translate(0, h / 2); c.scale(s, s); c.translate(0, -h / 2); }
    if (anim === 'fade') { const p = out(prog(lt, 0, 0.55)); c.globalAlpha *= p; c.translate(0, (1 - p) * L.size * 0.35); }
    let wi = 0, ci = 0;
    const total = L.lines.reduce((n, l) => n + l.words.reduce((m, w) => m + w.s.length + 1, 0), 0), typed = anim === 'type' ? Math.floor(lt * 24) : Infinity;
    L.lines.forEach((line, li) => {
      const x0 = -line.w / 2, y = li * L.lineH + L.size * 0.84;
      c.save();
      if (anim === 'rise') { const p = out(prog(lt, li * 0.13, 0.55)); c.beginPath(); c.rect(-width / 2 - L.size, li * L.lineH - L.size * 0.1, width + L.size * 2, L.lineH * 1.08); c.clip(); c.translate(0, (1 - p) * L.lineH * 1.1); }
      for (const word of line.words) {
        c.fillStyle = word.accent ? accent : color;
        if (anim === 'words') {
          const p = back(prog(lt, wi * 0.085, 0.45)), a = prog(lt, wi * 0.085, 0.18);
          c.save(); c.globalAlpha *= a; c.translate(x0 + word.x + word.w / 2, y - L.size * 0.3 + (1 - p) * L.size * 0.35); c.scale(0.55 + 0.45 * p, 0.55 + 0.45 * p); c.fillText(word.s, -word.w / 2, L.size * 0.3); c.restore();
        } else if (anim === 'letters' || anim === 'type') {
          let x = x0 + word.x;
          for (const ch of word.s) {
            const w = c.measureText(ch).width;
            if (anim === 'type') { if (ci < typed) c.fillText(ch, x, y); }
            else { const p = out(prog(lt, ci * 0.024, 0.38)); c.save(); c.globalAlpha *= p; c.fillText(ch, x, y + (1 - p) * L.size * 0.5); c.restore(); }
            x += w; ci++;
          }
          ci++;
          if (anim === 'type' && typed < total && ci > typed && ci - word.s.length - 1 <= typed && Math.floor(lt * 4) % 2 === 0) c.fillRect(x0 + word.x + c.measureText(word.s.slice(0, Math.max(0, typed - (ci - word.s.length - 1)))).width + L.size * 0.04, y - L.size * 0.75, L.size * 0.06, L.size * 0.85);
        } else c.fillText(word.s, x0 + word.x, y);
        wi++;
      }
      c.restore();
    });
    c.restore();
  }

  // Line icons on a 24x24 grid, drawn on like a pen stroke.
  const ICONS = {
    play: 'M7 4v16l13-8z', check: 'M4 12l5 5L20 6', arrow: 'M4 12h16M13 5l7 7-7 7', star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
    heart: 'M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z', bolt: 'M13 2L4 14h7l-1 8 9-12h-7z', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 3',
    film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4', leaf: 'M5 19c0-8 5-14 15-14 0 10-6 15-14 15zM5 19l8-8', bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.500c.7.7 1 1.500 1 2.500h6c0-1 .3-1.800 1-2.500A6 6 0 0 0 12 3z',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.800z',
    scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.100 15.900M14.500 14.500L20 20M8.100 8.100L12 12',
    music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400', money: 'M12 2v20M17 6H9.500a3.500 3.500 0 0 0 0 7h5a3.500 3.500 0 0 1 0 7H6',
  };

  // ---------- blocks: each measures itself, then draws centered on cx from `top`; lt is seconds since it appeared ----------
  function makeBlock(b, c, cw, U, T) {
    const p = T.palette, head = (s) => `800 ${s}px "${T.head}", "Helvetica Neue", Arial, sans-serif`, body = (w) => (s) => `${w} ${s}px "${T.body}", "Helvetica Neue", Arial, sans-serif`;
    const anim = ANIMS.includes(b.anim) ? b.anim : null, textColor = T.plaque ? p.text : p.text;
    // Shadow theatre: text hangs on a cut-paper sign.
    const plaque = (w, h, draw) => !T.plaque ? { h, draw } : {
      h: h + U * 5, draw(c2, cx, top, lt) {
        const pw = w + U * 7, ph = h + U * 5, sway = Math.sin(lt * 1.3) * 0.012 + (lt < 2 ? 0.06 * Math.exp(-lt * 2.4) * Math.sin(lt * 7) : 0), drop = (1 - out(prog(lt, 0, 0.6))) * -ph * 3;
        c2.save(); c2.translate(cx, top + drop); c2.rotate(sway); c2.strokeStyle = T.ink; c2.lineWidth = U * 0.25;
        [-1, 1].forEach((s) => { c2.beginPath(); c2.moveTo(s * (pw / 2 - U * 4), U); c2.lineTo(s * (pw / 2 - U * 4), -U * 200); c2.stroke(); });
        c2.fillStyle = T.ink; c2.beginPath(); c2.roundRect(-pw / 2, 0, pw, ph, U * 2.2); c2.fill();
        c2.fillStyle = p.text; for (let x = -pw / 2 + U * 2; x <= pw / 2 - U * 2; x += U * 2) { dot(c2, x, U * 1.3, U * 0.25); dot(c2, x, ph - U * 1.3, U * 0.25); }
        draw(c2, 0, U * 2.5, 9); c2.restore();
      },
    };
    if (b.type === 'headline' || b.type === 'sub') {
      const big = b.type === 'headline', L = fitText(c, parseWords(b.text), big ? head : body(600), cw * (big ? 1 : 0.9), big ? 3 : 3, U * (big ? 13.5 : 5), U * (big ? 6.5 : 3.6));
      const a = anim || (big ? 'words' : 'fade');
      return plaque(L.w, L.h, (c2, cx, top, lt) => { c2.save(); if (!big) c2.globalAlpha *= 0.88; drawText(c2, L, cx, top, lt, a, textColor, T.plaque ? p.accent2 : p.accent, T.glow); c2.restore(); });
    }
    if (b.type === 'kicker') {
      const L = fitText(c, parseWords(String(b.text ?? '').toUpperCase()), body(800), cw * 0.8, 1, U * 3.1, U * 2.2), h = U * 6.2;
      return { h, draw(c2, cx, top, lt) {
        const s = back(prog(lt, 0, 0.45)), w = L.w + U * 6; if (s <= 0) return;
        c2.save(); c2.translate(cx, top + h / 2); c2.scale(s, s); c2.fillStyle = T.plaque ? T.ink : rgba(p.accent, 0.2); c2.strokeStyle = T.plaque ? T.ink : p.accent; c2.lineWidth = U * 0.3;
        c2.beginPath(); c2.roundRect(-w / 2, -h / 2, w, h, h / 2); c2.fill(); c2.stroke(); drawText(c2, L, 0, -L.h / 2, 9, 'none', T.plaque ? p.text : p.text, p.accent); c2.restore();
      } };
    }
    if (b.type === 'list') {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 5).map((s) => fitText(c, parseWords(s), body(700), cw * 0.78, 2, U * 5, U * 3.6)), rowGap = U * 2.4;
      const w = Math.max(1, ...items.map((L) => L.w)) + U * 8, h = items.reduce((n, L) => n + Math.max(L.h, U * 6) + rowGap, -rowGap);
      return { h, draw(c2, cx, top, lt) {
        let y = top;
        items.forEach((L, i) => {
          const pr = out(prog(lt, i * 0.24, 0.5)), rowH = Math.max(L.h, U * 6), x = cx - w / 2 - (1 - pr) * U * 8;
          c2.save(); c2.globalAlpha *= pr;
          c2.fillStyle = i % 2 ? p.accent2 : p.accent; dot(c2, x + U * 2.6, y + rowH / 2, U * 2.6);
          c2.strokeStyle = bright(i % 2 ? p.accent2 : p.accent) > 0.6 ? '#14151a' : '#fff'; c2.lineWidth = U * 0.6; c2.lineCap = 'round'; c2.lineJoin = 'round';
          const ck = out(prog(lt, i * 0.24 + 0.25, 0.3)); c2.beginPath(); c2.moveTo(x + U * 1.4, y + rowH / 2); c2.lineTo(x + U * 2.3, y + rowH / 2 + U * 0.9); if (ck > 0.5) c2.lineTo(x + U * 3.8, y + rowH / 2 - U * 0.9); c2.stroke();
          drawText(c2, L, x + U * 8 + L.w / 2, y + (rowH - L.h) / 2, 9, 'none', T.plaque ? T.ink : p.text, p.accent, T.glow);
          c2.restore(); y += rowH + rowGap;
        });
      } };
    }
    if (b.type === 'stat') {
      const value = Number(b.value) || 0, decimals = (String(b.value).split('.')[1] || '').length, text = (v) => `${b.prefix ?? ''}${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${b.suffix ?? ''}`;
      const L = fitText(c, [{ s: text(value), accent: true }], head, cw, 1, U * 30, U * 12), label = b.label ? fitText(c, parseWords(b.label), body(700), cw * 0.9, 2, U * 4.8, U * 3.4) : null;
      return plaque(Math.max(L.w, label?.w ?? 0), L.h + (label ? label.h + U * 1.5 : 0), (c2, cx, top, lt) => {
        const pr = out(prog(lt, 0.1, 1.3)), s = back(prog(lt, 0, 0.5)); if (s <= 0) return;
        c2.save(); c2.translate(cx, top + L.h / 2); c2.scale(s, s); c2.font = L.font(L.size); c2.scale(L.k, L.k); c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.fillStyle = T.plaque ? p.accent2 : p.accent;
        if (T.glow) { c2.shadowColor = rgba(p.accent, 0.6); c2.shadowBlur = L.size * 0.25; }
        c2.fillText(text(value * pr), 0, L.size * 0.04); c2.restore();
        if (label) drawText(c2, label, cx, top + L.h + U * 1.5, lt - 0.5, 'fade', textColor, p.accent2, T.glow);
      });
    }
    if (b.type === 'bars') {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 6).filter((it) => it && Number.isFinite(Number(it.value))), max = Math.max(1e-9, ...items.map((it) => Number(it.value))), h = U * 46, n = Math.max(1, items.length);
      return { h, draw(c2, cx, top, lt) {
        const w = Math.min(cw, U * 22 * n), bw = w / n * 0.62, base = top + h - U * 6;
        c2.fillStyle = rgba(T.plaque ? '#160905' : p.text, 0.35); c2.fillRect(cx - w / 2, base, w, U * 0.3);
        items.forEach((it, i) => {
          const pr = out(prog(lt, i * 0.14, 0.7)), x = cx - w / 2 + (w / n) * (i + 0.5), bh = (h - U * 15) * (Number(it.value) / max) * pr, col = T.plaque ? T.ink : Number(it.value) === max ? p.accent2 : p.accent;
          const g = c2.createLinearGradient(0, base - bh, 0, base); g.addColorStop(0, col); g.addColorStop(1, rgba(T.plaque ? '#160905' : col, 0.75)); c2.fillStyle = g; c2.beginPath(); c2.roundRect(x - bw / 2, base - bh, bw, bh, [U * 1.2, U * 1.2, 0, 0]); c2.fill();
          c2.textAlign = 'center'; c2.textBaseline = 'alphabetic'; c2.fillStyle = T.plaque ? T.ink : p.text; c2.globalAlpha = pr;
          c2.font = head(U * 3.8); c2.fillText(`${b.prefix ?? ''}${(Number(it.value) * pr).toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(Number(it.value)) ? 0 : 1 })}${b.suffix ?? ''}`, x, base - bh - U * 1.4);
          c2.font = body(700)(U * 3.2); c2.fillText(String(it.label ?? '').slice(0, 14), x, base + U * 4.6); c2.globalAlpha = 1;
        });
      } };
    }
    if (b.type === 'quote') {
      const L = fitText(c, parseWords(b.text), head, cw * 0.94, 5, U * 8, U * 4.6), by = b.by ? fitText(c, parseWords(`\u2014 ${b.by}`), body(700), cw * 0.9, 1, U * 3.8, U * 3) : null;
      return plaque(L.w, U * 9 + L.h + (by ? by.h + U * 2 : 0), (c2, cx, top, lt) => {
        c2.save(); c2.globalAlpha *= out(prog(lt, 0, 0.4)); c2.font = head(U * 22); c2.textAlign = 'center'; c2.textBaseline = 'alphabetic'; c2.fillStyle = T.plaque ? p.accent2 : p.accent; c2.fillText('\u201C', cx, top + U * 13); c2.restore();
        drawText(c2, L, cx, top + U * 9, lt - 0.15, anim || 'rise', textColor, T.plaque ? p.accent2 : p.accent, T.glow);
        if (by) drawText(c2, by, cx, top + U * 9 + L.h + U * 2, lt - 0.7, 'fade', textColor, p.accent2, T.glow);
      });
    }
    if (b.type === 'button') {
      const L = fitText(c, parseWords(b.text), body(800), cw * 0.8, 1, U * 5, U * 3.2), h = U * 11.5, w = L.w + U * 11;
      return { h, draw(c2, cx, top, lt) {
        const s = back(prog(lt, 0, 0.5)) * (1 + 0.025 * Math.sin(lt * 4)); if (s <= 0) return;
        c2.save(); c2.translate(cx, top + h / 2); c2.scale(s, s);
        const g = c2.createLinearGradient(-w / 2, 0, w / 2, 0); g.addColorStop(0, T.plaque ? T.ink : p.accent); g.addColorStop(1, T.plaque ? T.ink : p.accent2);
        c2.shadowColor = rgba(T.plaque ? '#160905' : p.accent, 0.5); c2.shadowBlur = U * 4; c2.shadowOffsetY = U; c2.fillStyle = g; c2.beginPath(); c2.roundRect(-w / 2, -h / 2, w, h, h / 2); c2.fill(); c2.shadowColor = 'transparent';
        c2.save(); c2.clip(); const sx = ((lt * 0.55) % 1.6 - 0.3) * w - w / 2; c2.fillStyle = 'rgba(255,255,255,0.22)'; c2.beginPath(); c2.moveTo(sx, -h); c2.lineTo(sx + U * 4, -h); c2.lineTo(sx - U * 2, h); c2.lineTo(sx - U * 6, h); c2.fill(); c2.restore();
        const ink = T.plaque ? p.text : bright(p.accent) + bright(p.accent2) > 1.25 ? '#14151a' : '#ffffff'; drawText(c2, L, 0, -L.h / 2, 9, 'none', ink, ink); c2.restore();
      } };
    }
    if (b.type === 'icon') {
      const path = new Path2D(ICONS[b.name] || ICONS.sparkle), r = U * 10, h = r * 2;
      return { h, draw(c2, cx, top, lt) {
        const s = back(prog(lt, 0, 0.5)); if (s <= 0) return;
        c2.save(); c2.translate(cx, top + r + Math.sin(lt * 1.6) * U * 0.5); c2.scale(s, s);
        if (T.glow) { c2.shadowColor = rgba(p.accent, 0.7); c2.shadowBlur = U * 5; }
        const g = c2.createLinearGradient(-r, -r, r, r); g.addColorStop(0, T.plaque ? T.ink : p.accent); g.addColorStop(1, T.plaque ? T.ink : p.accent2); c2.fillStyle = g; dot(c2, 0, 0, r); c2.shadowColor = 'transparent';
        const k = r * 1.1 / 24 * 2 * 0.5; c2.scale(k, k); c2.translate(-12, -12); c2.strokeStyle = T.plaque ? p.text : bright(p.accent) + bright(p.accent2) > 1.25 ? '#14151a' : '#ffffff'; c2.lineWidth = 2; c2.lineCap = 'round'; c2.lineJoin = 'round';
        c2.setLineDash([90, 90]); c2.lineDashOffset = 90 * (1 - out(prog(lt, 0.2, 0.9))); c2.stroke(path); c2.restore();
      } };
    }
    if (b.type === 'cards') {
      const n = clamp(Math.round(Number(b.count) || 3), 2, 4), ch = U * 40, cwid = ch * 0.5625, gap = U * 2.4, h = ch + U * 3;
      return { h, draw(c2, cx, top, lt) {
        for (let i = 0; i < n; i++) {
          const pr = back(prog(lt, i * 0.13, 0.6)); if (pr <= 0) continue;
          const x = cx + (i - (n - 1) / 2) * (cwid + gap), y = top + ch / 2 + U * 1.5 + Math.sin(lt * 1.5 + i * 1.3) * U * 0.7 + (1 - pr) * U * 14, col = [p.accent, p.accent2, p.bg2, p.accent][i];
          c2.save(); c2.translate(x, y); c2.rotate((i - (n - 1) / 2) * 0.035 + Math.sin(lt * 1.2 + i) * 0.015); c2.globalAlpha *= clamp(pr);
          c2.shadowColor = 'rgba(0,0,0,0.35)'; c2.shadowBlur = U * 3; c2.shadowOffsetY = U * 1.2;
          const g = c2.createLinearGradient(0, -ch / 2, 0, ch / 2); g.addColorStop(0, T.plaque ? '#c8ebff' : col); g.addColorStop(1, T.plaque ? '#f6c47c' : rgba(p.bg, 0.95)); c2.fillStyle = T.plaque ? T.ink : g;
          c2.beginPath(); c2.roundRect(-cwid / 2, -ch / 2, cwid, ch, U * 2.2); c2.fill(); c2.shadowColor = 'transparent';
          if (T.plaque) { c2.fillStyle = g; c2.beginPath(); c2.roundRect(-cwid / 2 + U * 1.2, -ch / 2 + U * 3.4, cwid - U * 2.4, ch - U * 6.8, U); c2.fill(); }
          c2.fillStyle = T.plaque ? T.ink : 'rgba(255,255,255,0.92)'; dot(c2, 0, 0, U * 3.6); c2.fillStyle = T.plaque ? p.text : col; c2.beginPath(); c2.moveTo(-U * 1.1, -U * 1.7); c2.lineTo(U * 2, 0); c2.lineTo(-U * 1.1, U * 1.7); c2.fill();
          c2.fillStyle = 'rgba(255,255,255,0.75)'; c2.beginPath(); c2.roundRect(-cwid / 2 + U * 2.4, ch / 2 - U * 4.4, (cwid - U * 4.8) * (0.3 + 0.7 * ((lt * 0.25 + i * 0.3) % 1)), U * 0.7, U * 0.35); c2.fill();
          c2.restore();
        }
      } };
    }
    if (b.type === 'media') {
      const media = (typeof MEDIA !== 'undefined' && MEDIA && MEDIA[b.id]) || null; if (!media) return null;
      const mw = media.videoWidth || media.naturalWidth || 16, mh = media.videoHeight || media.naturalHeight || 9, h = Math.min(U * 62, cw * mh / mw), w = h * mw / mh;
      return { h, draw(c2, cx, top, lt) {
        const s = back(prog(lt, 0, 0.6)); if (s <= 0) return;
        c2.save(); c2.translate(cx, top + h / 2); c2.scale(s * (1 + 0.02 * Math.sin(lt * 0.8)), s * (1 + 0.02 * Math.sin(lt * 0.8))); c2.rotate(Math.sin(lt * 0.7) * 0.008);
        c2.shadowColor = 'rgba(0,0,0,0.45)'; c2.shadowBlur = U * 4; c2.shadowOffsetY = U * 1.5; c2.fillStyle = '#000'; c2.beginPath(); c2.roundRect(-w / 2, -h / 2, w, h, U * 2); c2.fill(); c2.shadowColor = 'transparent';
        c2.clip(); try { c2.drawImage(media, -w / 2, -h / 2, w, h); } catch { /* a file that can't be drawn leaves the frame black */ } c2.restore();
      } };
    }
    return null;
  }

  const TRANSITIONS = ['fade', 'zoom', 'slide', 'wipe', 'flash'];

  /** A playable scene from a spec: { width, height, duration, theme, palette?, font?, scenes: [{ seconds, transition, align, decor, blocks }] }. */
  function build(spec) {
    const W = Number(spec.width) || 1080, H = Number(spec.height) || 1920, base = THEMES[spec.theme] || THEMES.neon;
    const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v : d);
    const palette = Object.fromEntries(Object.entries(base.palette).map(([k, v]) => [k, base.plaque ? v : hex(spec.palette?.[k], v)]));
    const T = { ...base, palette, head: FONTS.includes(spec.font?.head) ? spec.font.head : base.head, body: FONTS.includes(spec.font?.body) ? spec.font.body : base.body };
    const scenes = (Array.isArray(spec.scenes) ? spec.scenes : []).filter((s) => s && Array.isArray(s.blocks)).slice(0, 8);
    if (!scenes.length) throw new Error('The video has no scenes.');
    const duration = clamp(Number(spec.duration) || 8, 3, 30), weight = scenes.map((s) => Math.max(0.5, Number(s.seconds) || 1)), sum = weight.reduce((a, b) => a + b, 0);
    let at = 0; const times = weight.map((w) => { const start = at; at += w / sum * duration; return [start, at]; });
    // One size unit for everything: bigger on phone-shaped video, where there is room and text must read small.
    const U = Math.min(W, H) / 100 * (H > W ? 1.22 : 1.12), cw = W > H ? W * 0.72 : W * 0.86, safeTop = H * (H > W ? 0.115 : 0.09), safeH = H - safeTop * 2, layouts = [];
    function layout(c, i) {
      if (layouts[i]) return layouts[i];
      const blocks = scenes[i].blocks.slice(0, 5).map((b) => makeBlock(b || {}, c, cw, U, T)).filter(Boolean), gap = U * 3.6;
      const total = blocks.reduce((n, b) => n + b.h + gap, -gap), k = Math.min(1, safeH / Math.max(1, total));
      return (layouts[i] = { blocks, gap, total, k });
    }
    const ready = typeof document === 'undefined' ? Promise.resolve() : (() => {
      const names = [...new Set([T.head, T.body])];
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?${names.map((n) => `family=${n.replaceAll(' ', '+')}:wght@400;600;700;800`).join('&')}&display=block` }));
      // Fonts that don't arrive in 4 s fall back to the system font instead of holding the video.
      return Promise.race([new Promise((r) => setTimeout(r, 4000)), new Promise((r) => setTimeout(r, 300)).then(() => Promise.all(names.flatMap((n) => [600, 700, 800].map((w) => document.fonts.load(`${w} 40px "${n}"`).catch(() => null)))))]).then(() => { layouts.length = 0; });
    })();
    return {
      width: W, height: H, fps: 30, duration, ready,
      draw(c, t) {
        c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.shadowColor = 'transparent'; c.setLineDash([]);
        T.bg(c, W, H, t, palette);
        let i = times.findIndex(([s, e]) => t >= s && t < e); if (i < 0) i = scenes.length - 1;
        const sc = scenes[i], [start, end] = times[i], lt = t - start, last = i === scenes.length - 1, tr = TRANSITIONS.includes(sc.transition) ? sc.transition : 'fade';
        const nextTr = last ? null : (TRANSITIONS.includes(scenes[i + 1].transition) ? scenes[i + 1].transition : 'fade');
        const enter = i === 0 ? 1 : out(prog(lt, 0, 0.5)), exit = last ? 0 : inn(prog(t, end - 0.38, 0.38));
        c.save();
        c.globalAlpha = (i === 0 || tr === 'wipe' ? 1 : prog(lt, 0, 0.25)) * (1 - exit);
        c.translate(W / 2, H / 2);
        const zoom = 1 + 0.035 * (lt / (end - start)) + (tr === 'zoom' ? (1 - enter) * -0.3 : 0) + (nextTr === 'zoom' ? exit * 0.5 : exit * 0.06);
        c.scale(zoom, zoom); c.translate(-W / 2, -H / 2);
        if (tr === 'slide') c.translate((1 - enter) * W * 0.35, 0);
        if (nextTr === 'slide') c.translate(-exit * W * 0.35, 0);
        if (tr === 'wipe' && enter < 1) { c.beginPath(); c.arc(W / 2, H / 2, Math.hypot(W, H) * 0.6 * enter, 0, TAU); c.clip(); }
        for (const name of (Array.isArray(sc.decor) ? sc.decor : []).slice(0, 3)) if (DECOR[name]) { c.save(); DECOR[name](c, W, H, t, lt, palette, U); c.restore(); }
        const L = layout(c, i), th = L.total * L.k, y0 = sc.align === 'top' ? safeTop : sc.align === 'bottom' ? H - safeTop - th : (H - th) / 2;
        c.translate(W / 2, y0); c.scale(L.k, L.k);
        let y = 0;
        L.blocks.forEach((b, n) => { const bt = lt - (i === 0 ? 0.05 : 0.2) - n * 0.3; if (bt > 0) { c.save(); b.draw(c, 0, y + Math.sin(t * 1.1 + n * 1.7) * U * 0.25, bt); c.restore(); } y += b.h + L.gap; });
        c.restore();
        if (tr === 'flash') { const f = 1 - prog(lt, 0, 0.3); if (f > 0 && i > 0) { c.fillStyle = `rgba(255,255,255,${0.85 * f * f})`; c.fillRect(0, 0, W, H); } }
        if (nextTr === 'flash' && exit > 0) { c.fillStyle = `rgba(255,255,255,${0.85 * exit})`; c.fillRect(0, 0, W, H); }
        c.globalAlpha = 1; T.finish(c, W, H, t);
      },
    };
  }

  const Kit = { build, THEMES: Object.keys(THEMES), FONTS, DECOR: Object.keys(DECOR), ICONS: Object.keys(ICONS), ANIMS, TRANSITIONS };
  if (typeof window !== 'undefined') window.Kit = Kit;
  if (typeof module !== 'undefined') module.exports = Kit;
})();
