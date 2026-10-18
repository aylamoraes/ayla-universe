/* =========================================================================
   AYLA UNIVERSE — 2D orbital map (fallback)
   Used only when WebGL2 is unavailable or the 3D engine fails to start.
   It exposes the same surface as AYLA_UNIVERSE, so the interface does not need
   to know which one it is talking to. Everything is drawn with Canvas 2D.
   ========================================================================= */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const TYPE_COLORS = {
    oceanic: '#4f8fd6', desert: '#c9965a', barren: '#8d8a86', ice: '#bcd9e6', gas: '#d0a67a', iceGiant: '#6fb4e6'
  };

  const S = {
    cv: null, ctx: null, w: 1, h: 1, dpr: 1,
    catalog: null, cb: {}, mode: 'explore', running: false, reduced: false, labelsOn: true,
    stars: [], t: 0, last: 0,
    ex: { bodies: [], selected: null, zoom: 1, panX: 0, panY: 0, tx: 0, ty: 0, tz: 1 },
    sb: { items: [], galaxies: [], paused: false, orbitsOn: true, selected: null, nextId: 1, zoom: 1, tz: 1, tx: 0, ty: 0, panX: 0, panY: 0 },
    stageEx: null, stageSb: null
  };

  function seeded(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  function buildStars() {
    const r = seeded(7);
    S.stars = [];
    for (let i = 0; i < 260; i++) S.stars.push({ x: r(), y: r(), a: 0.18 + r() * 0.6, s: r() < 0.08 ? 1.6 : 0.8 + r() * 0.5, p: r() * TAU });
  }

  function scaleFor(scene) {
    // fits the farthest orbit inside the shorter side of the screen
    const far = scene === 'ex' ? 46 : 24;
    return Math.min(S.w, S.h) * 0.46 / far;
  }
  const TILT = 0.5; // top-down map with a slight tilt, so orbits read as ellipses

  function toScreen(scene, x, y) {
    const sc = S[scene];
    const k = scaleFor(scene) * sc.zoom;
    return [S.w / 2 + (x - sc.panX) * k, S.h / 2 + (y - sc.panY) * k * TILT];
  }

  /* ---------------- scene content ---------------- */
  function buildExplorer() {
    const out = [];
    Object.keys(S.catalog).forEach((key, i) => {
      const d = S.catalog[key];
      out.push({ key, name: d.name, r: d.radius, dist: d.dist, speed: d.speed, ang: i * 1.3 + 0.4, css: d.css || '#ffffff', rings: !!d.hasRings, star: d.dist === 0 || d.fictional && d.type.indexOf('Star') !== -1 });
    });
    S.ex.bodies = out;
  }

  function addPlanet(o) {
    const radius = clamp(+o.radius || 0.8, 0.3, 2.5);
    const minDist = 2.5 + radius + 1.0;
    let dist = clamp(+o.dist || 10, 4, 22);
    let adjusted = false;
    if (dist < minDist) { dist = minDist; adjusted = true; }
    const type = TYPE_COLORS[o.type] ? o.type : 'oceanic';
    const item = {
      id: 'p' + (S.sb.nextId++), name: String(o.name || 'Unnamed world').slice(0, 28), type, kind: 'world',
      radius, dist, speed: clamp(+o.speed || 1, 0.2, 3), ang: o.ang != null ? o.ang : Math.random() * TAU,
      color: o.color || TYPE_COLORS[type]
    };
    S.sb.items.push(item);
    emit();
    return { id: item.id, name: item.name, dist: item.dist, adjusted, type };
  }
  function addGalaxy(o) {
    const g = {
      id: 'g' + (S.sb.nextId++), name: String(o.name || 'Unnamed galaxy').slice(0, 28), kind: 'galaxy',
      arms: clamp(Math.round(+o.arms || 3), 2, 5), size: clamp(+o.size || 16, 8, 30), tilt: clamp(+o.tilt || 55, 0, 85),
      color: o.color || '#8f7bff', ang: Math.random() * TAU,
      gx: (Math.random() < 0.5 ? -1 : 1) * (18 + Math.random() * 6), gy: (Math.random() - 0.5) * 36
    };
    S.sb.galaxies.push(g);
    emit();
    return { id: g.id, name: g.name };
  }
  function listSandbox() {
    return S.sb.items.map((b) => ({ id: b.id, name: b.name, kind: 'world', type: b.type, color: b.color, radius: b.radius, dist: b.dist, speed: b.speed }))
      .concat(S.sb.galaxies.map((g) => ({ id: g.id, name: g.name, kind: 'galaxy', type: g.arms + ' arms', color: g.color, size: g.size })));
  }
  function emit() { if (S.cb.onSandboxChange) S.cb.onSandboxChange(listSandbox()); }

  /* ---------------- drawing ---------------- */
  function drawSky() {
    const c = S.ctx;
    const g = c.createRadialGradient(S.w * 0.5, S.h * 0.4, 0, S.w * 0.5, S.h * 0.4, Math.max(S.w, S.h) * 0.8);
    g.addColorStop(0, '#0d1030'); g.addColorStop(1, '#02030a');
    c.fillStyle = g; c.fillRect(0, 0, S.w, S.h);
    const neb = c.createRadialGradient(S.w * 0.78, S.h * 0.25, 0, S.w * 0.78, S.h * 0.25, Math.max(S.w, S.h) * 0.5);
    neb.addColorStop(0, 'rgba(120,60,200,0.16)'); neb.addColorStop(1, 'rgba(120,60,200,0)');
    c.fillStyle = neb; c.fillRect(0, 0, S.w, S.h);
    for (const s of S.stars) {
      const tw = S.reduced ? 1 : 0.75 + 0.25 * Math.sin(S.t * 0.8 + s.p);
      c.globalAlpha = s.a * tw;
      c.fillStyle = '#e8ecff';
      c.fillRect(s.x * S.w, s.y * S.h, s.s, s.s);
    }
    c.globalAlpha = 1;
  }

  function orbitPath(scene, dist, alpha, color) {
    const c = S.ctx;
    const [cx, cy] = toScreen(scene, 0, 0);
    const k = scaleFor(scene) * S[scene].zoom;
    c.beginPath();
    c.ellipse(cx, cy, dist * k, dist * k * TILT, 0, 0, TAU);
    c.strokeStyle = color || 'rgba(176,188,255,' + alpha + ')';
    c.lineWidth = 1;
    c.stroke();
  }

  function disc(x, y, r, color, glow) {
    const c = S.ctx;
    if (glow) {
      const g = c.createRadialGradient(x, y, r * 0.6, x, y, r * glow);
      g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.35; c.fillStyle = g; c.beginPath(); c.arc(x, y, r * glow, 0, TAU); c.fill(); c.globalAlpha = 1;
    }
    const sh = c.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    sh.addColorStop(0, '#ffffff'); sh.addColorStop(0.18, color); sh.addColorStop(1, '#05060c');
    c.fillStyle = glow ? color : sh;
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  }

  function label(text, x, y, active) {
    if (!S.labelsOn) return;
    const c = S.ctx;
    c.font = '500 11px Jost, "Helvetica Neue", Arial, sans-serif';
    c.textBaseline = 'middle';
    c.fillStyle = active ? '#eceeff' : 'rgba(200,206,240,0.62)';
    c.fillText(text.toUpperCase().split('').join(' '), x, y);
  }

  function drawExplorer() {
    const sc = S.ex;
    const k = scaleFor('ex') * sc.zoom;
    sc.bodies.forEach((b) => { if (b.dist > 0) orbitPath('ex', b.dist, b === sc.selected ? 0.5 : 0.16); });
    // belt hint
    const c = S.ctx;
    const [cx, cy] = toScreen('ex', 0, 0);
    c.save(); c.setLineDash([1, 5]); c.strokeStyle = 'rgba(176,188,255,0.28)'; c.lineWidth = 6;
    c.beginPath(); c.ellipse(cx, cy, 18.8 * k, 18.8 * k * TILT, 0, 0, TAU); c.stroke(); c.restore();

    sc.bodies.forEach((b) => {
      const px = Math.cos(b.ang) * b.dist, py = Math.sin(b.ang) * b.dist;
      const [x, y] = toScreen('ex', px, py);
      b.sx = x; b.sy = y;
      const r = Math.max(3, Math.pow(b.r, 0.7) * 5 * Math.min(sc.zoom, 2.2) * (Math.min(S.w, S.h) / 700 + 0.5));
      b.sr = r;
      if (b.rings) {
        c.save(); c.translate(x, y); c.rotate(-0.35);
        c.beginPath(); c.ellipse(0, 0, r * 2.1, r * 0.7, 0, 0, TAU);
        c.strokeStyle = 'rgba(230,210,154,0.7)'; c.lineWidth = Math.max(1.5, r * 0.28); c.stroke(); c.restore();
      }
      disc(x, y, r, b.css, b.star ? 3.2 : 0);
      if (b === sc.selected) {
        c.beginPath(); c.arc(x, y, r + 7, 0, TAU); c.strokeStyle = '#8fe6f5'; c.lineWidth = 1; c.stroke();
      }
      label(b.name, x + r + 10, y, b === sc.selected);
    });
  }

  function drawSandbox() {
    const sc = S.sb;
    const c = S.ctx;
    const [cx, cy] = toScreen('sb', 0, 0);
    const k = scaleFor('sb') * sc.zoom;

    sc.galaxies.forEach((g) => {
      const [gx, gy] = toScreen('sb', g.gx, g.gy);
      const R = g.size * 0.16 * k * 0.9;
      c.save(); c.translate(gx, gy); c.scale(1, Math.cos(g.tilt * Math.PI / 180) * 0.8 + 0.2); c.rotate(g.ang);
      const core = c.createRadialGradient(0, 0, 0, 0, 0, R * 0.55);
      core.addColorStop(0, 'rgba(255,224,160,0.9)'); core.addColorStop(1, 'rgba(255,224,160,0)');
      c.fillStyle = core; c.beginPath(); c.arc(0, 0, R * 0.55, 0, TAU); c.fill();
      c.fillStyle = g.color; c.globalAlpha = 0.8;
      for (let a = 0; a < g.arms; a++) {
        for (let i = 0; i < 46; i++) {
          const t = i / 46, th = t * 5.2 + (a / g.arms) * TAU, rr = R * (0.12 + t * 0.95);
          c.fillRect(Math.cos(th) * rr + (Math.sin(i * 12.9 + a) * 2), Math.sin(th) * rr + (Math.cos(i * 7.7 + a) * 2), 1.4, 1.4);
        }
      }
      c.restore(); c.globalAlpha = 1;
      label(g.name, gx + R + 6, gy, g === sc.selected);
    });

    if (sc.orbitsOn) sc.items.forEach((b) => orbitPath('sb', b.dist, b === sc.selected ? 0.5 : 0.16));
    disc(cx, cy, Math.max(8, 2.5 * k * 0.45), '#79c3ff', 3);
    sc.items.forEach((b) => {
      const [x, y] = toScreen('sb', Math.cos(b.ang) * b.dist, Math.sin(b.ang) * b.dist);
      b.sx = x; b.sy = y;
      const r = Math.max(3.5, b.radius * k * 0.5);
      b.sr = r;
      disc(x, y, r, b.color, 0);
      if (b === sc.selected) { c.beginPath(); c.arc(x, y, r + 7, 0, TAU); c.strokeStyle = '#8fe6f5'; c.lineWidth = 1; c.stroke(); }
      label(b.name, x + r + 8, y, b === sc.selected);
    });
  }

  function frame(now) {
    if (!S.running) return;
    requestAnimationFrame(frame);
    const dt = S.last ? Math.min((now - S.last) / 1000, 0.05) : 0.016;
    S.last = now;
    S.t += dt;
    if (S.mode === 'ask' || S.mode === 'discoveries') { if (Math.floor(S.t * 30) % 2) return; }

    const scene = S.mode === 'create' ? 'sb' : 'ex';
    const sc = S[scene];
    // ease the camera
    const f = 1 - Math.exp(-dt * 4);
    sc.zoom += (sc.tz - sc.zoom) * f;
    sc.panX += (sc.tx - sc.panX) * f;
    sc.panY += (sc.ty - sc.panY) * f;
    const m = S.reduced ? 0.25 : 1;
    if (scene === 'ex') S.ex.bodies.forEach((b) => { b.ang += b.speed * 3.6 * dt * m; });
    else if (!S.sb.paused) S.sb.items.forEach((b) => { b.ang += b.speed * 0.35 * dt * m; });

    drawSky();
    if (scene === 'ex') drawExplorer(); else drawSandbox();
  }

  /* ---------------- input ---------------- */
  function pick(scene, px, py) {
    const list = scene === 'ex' ? S.ex.bodies : S.sb.items.concat(S.sb.galaxies);
    let best = null, bd = 1e9;
    list.forEach((b) => {
      let x = b.sx, y = b.sy, r = (b.sr || 8);
      if (b.kind === 'galaxy') { const p = toScreen('sb', b.gx, b.gy); x = p[0]; y = p[1]; r = b.size * 0.16 * scaleFor('sb') * S.sb.zoom; }
      const d = Math.hypot(px - x, py - y);
      if (d < Math.max(r + 12, 24) && d < bd) { bd = d; best = b; }
    });
    return best;
  }

  function bind(el, scene) {
    if (!el) return;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, px: S[scene].tx, py: S[scene].ty, moved: false }; try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } });
    el.addEventListener('pointermove', (e) => {
      const rect = el.getBoundingClientRect();
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) down.moved = true;
        if (down.moved) {
          const k = scaleFor(scene) * S[scene].zoom;
          S[scene].tx = down.px - dx / k; S[scene].ty = down.py - dy / (k * TILT);
          S[scene].panX = S[scene].tx; S[scene].panY = S[scene].ty;
        }
      } else {
        el.classList.toggle('is-over', !!pick(scene, e.clientX - rect.left, e.clientY - rect.top));
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (down && !down.moved) {
        const rect = el.getBoundingClientRect();
        const hit = pick(scene, e.clientX - rect.left, e.clientY - rect.top);
        if (hit) { if (scene === 'ex') { if (S.cb.onSelect) S.cb.onSelect(hit.key); } else focusSandbox(hit.id); }
      }
      down = null;
    });
    el.addEventListener('pointercancel', () => { down = null; });
    el.addEventListener('wheel', (e) => { e.preventDefault(); S[scene].tz = clamp(S[scene].tz * Math.exp(-e.deltaY * 0.0015), 0.5, 4); }, { passive: false });
  }

  function focusSandbox(id) {
    const sc = S.sb;
    const it = sc.items.find((b) => b.id === id) || sc.galaxies.find((g) => g.id === id);
    if (!it) return;
    sc.selected = it;
    sc.tz = 1.6;
    if (it.kind === 'galaxy') { sc.tx = it.gx; sc.ty = it.gy; } else { sc.tx = Math.cos(it.ang) * it.dist; sc.ty = Math.sin(it.ang) * it.dist; }
  }

  function resize() {
    if (!S.cv) return;
    const rect = S.cv.getBoundingClientRect();
    S.w = Math.max(2, Math.floor(rect.width)); S.h = Math.max(2, Math.floor(rect.height));
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.cv.width = Math.floor(S.w * S.dpr); S.cv.height = Math.floor(S.h * S.dpr);
    S.ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  }

  const API = {
    isFallback: true,
    supported() { return !!document.createElement('canvas').getContext; },
    async init(opts) {
      S.cv = opts.canvas; S.ctx = S.cv.getContext('2d');
      if (!S.ctx) throw new Error('Canvas 2D is not available');
      S.catalog = opts.catalog; S.cb = { onSelect: opts.onSelect, onSandboxChange: opts.onSandboxChange };
      S.reduced = !!opts.reduced; S.labelsOn = opts.labels !== false;
      S.stageEx = opts.stageExplorer; S.stageSb = opts.stageSandbox;
      buildStars(); buildExplorer();
      resize();
      window.addEventListener('resize', resize);
      bind(S.stageEx, 'ex'); bind(S.stageSb, 'sb');
      addPlanet({ name: 'Ayla-Alpha', type: 'oceanic', radius: 0.9, dist: 8, speed: 1, color: '#00f0ff', ang: 0.6 });
      if (opts.onProgress) opts.onProgress(1, 'Ready');
      S.ready = true;
      return { quality: 'map' };
    },
    start() { if (S.running) return; S.running = true; S.last = 0; requestAnimationFrame(frame); },
    setMode(m) { S.mode = m === 'create' ? 'create' : (m === 'ask' || m === 'discoveries' ? m : 'explore'); resize(); },
    setViewShift() { /* the 2D map has no lens shift */ },
    focusBody(key) {
      const b = S.ex.bodies.find((x) => x.key === key);
      if (!b) return;
      S.ex.selected = b; S.ex.tz = 1.5;
      S.ex.tx = Math.cos(b.ang) * b.dist; S.ex.ty = Math.sin(b.ang) * b.dist;
    },
    overview() { S.ex.selected = null; S.ex.tz = 1; S.ex.tx = 0; S.ex.ty = 0; },
    setReducedMotion(v) { S.reduced = !!v; },
    setLabels(v) { S.labelsOn = !!v; },
    resize,
    isReady() { return !!S.ready; },
    sandbox: {
      addPlanet, addGalaxy,
      remove(id) {
        S.sb.items = S.sb.items.filter((b) => b.id !== id);
        S.sb.galaxies = S.sb.galaxies.filter((g) => g.id !== id);
        if (S.sb.selected && S.sb.selected.id === id) API.sandbox.overview();
        emit();
      },
      reset() { S.sb.items = []; S.sb.galaxies = []; S.sb.selected = null; API.sandbox.overview(); emit(); },
      list: listSandbox,
      focus: focusSandbox,
      overview() { S.sb.selected = null; S.sb.tz = 1; S.sb.tx = 0; S.sb.ty = 0; },
      setPaused(v) { S.sb.paused = !!v; },
      setOrbits(v) { S.sb.orbitsOn = !!v; }
    }
  };

  global.AYLA_FALLBACK = API;
})(window);
