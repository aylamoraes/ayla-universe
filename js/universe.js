/* =========================================================================
   AYLA UNIVERSE — universe.js
   The 3D engine: one WebGL2 canvas, two scenes (the solar system for
   Explore, the sandbox for Create), a smooth orbit camera, planet labels and
   picking. Planets are procedural; the sky is baked once into a cube map.
   ========================================================================= */
(function (global) {
  'use strict';

  const GL = global.AYLA_GL;
  const SH = global.AYLA_SHADERS;
  const { V3, M4, Program, Mesh, hueMatrix, MAT3_IDENTITY } = GL;
  const TAU = Math.PI * 2;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  function rng(seed) {
    let s = seed | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) { return (r() + r() + r() + r() - 2) * 1.2247; }

  const nextFrame = () => new Promise((res) => {
    let done = false;
    const go = () => { if (!done) { done = true; res(); } };
    requestAnimationFrame(go);
    setTimeout(go, 120); // background tabs pause rAF; do not stall the load
  });

  /* ---------- state ---------- */
  const S = {
    gl: null, canvas: null, programs: {}, meshes: {}, sky: null, emptyVao: null,
    w: 1, h: 1, dpr: 1, dprCap: 2, dprScale: 1,
    time: 0, frame: 0, running: false, mode: 'explore', reduced: false, labelsOn: true,
    cfg: null, cb: {}, labelsEl: null, ex: null, sb: null, fatal: false,
    perf: { acc: 0, n: 0, since: 0 }, lastT: 0, tick: 0, skyRot: 0,
    shift: { x: 0, y: 0, tx: 0, ty: 0 }   // lens shift in NDC, used to keep the subject clear of UI panels
  };

  const FOV = 50 * Math.PI / 180;
  const NEAR = 0.05, FAR = 2600;

  function qualityConfig(q, hint) {
    const mobile = !!(hint && hint.mobile);
    const presets = {
      high: { sky: 1536, stars: 8500, bright: 170, dust: 2600, belt: 2200, seg: 128, rings: 96, lowq: 0, dprCap: mobile ? 1.5 : 2, galaxy: 16000 },
      low: { sky: 1024, stars: 4800, bright: 110, dust: 1500, belt: 1100, seg: 96, rings: 64, lowq: 1, dprCap: 1.25, galaxy: 9000 },
      test: { sky: 512, stars: 3000, bright: 80, dust: 900, belt: 700, seg: 64, rings: 48, lowq: 1, dprCap: 1, galaxy: 5000 }
    };
    let name = q;
    if (!presets[name]) name = mobile ? 'low' : 'high';
    return Object.assign({ name }, presets[name]);
  }

  /* ---------- uniforms helper ---------- */
  function applyU(P, u) {
    for (const k in u) {
      const v = u[k];
      if (typeof v === 'number') P.f(k, v);
      else if (v instanceof Float32Array) {
        if (v.length === 9) P.m3(k, v);
        else if (v.length === 15) P.v3v(k, v);
        else if (v.length === 16) P.m4(k, v);
      } else if (v.length === 3) P.v3(k, v);
      else if (v.length === 4) P.v4(k, v[0], v[1], v[2], v[3]);
      else if (v.length === 2) P.v2(k, v[0], v[1]);
    }
  }
  function useCommon(P, sc) {
    P.use();
    if (P._frame !== S.frame) {
      P._frame = S.frame;
      P.m4('uVP', sc.vp).v3('uCam', sc.eye).v3('uSunPos', [0, 0, 0]).f('uTime', S.time);
    }
    return P;
  }

  /* =======================================================================
     CAMERA RIG
     ======================================================================= */
  class Rig {
    constructor(o) {
      this.theta = this.gTheta = o.theta;
      this.phi = this.gPhi = o.phi;
      this.radius = this.gRadius = o.radius;
      this.target = (o.target || [0, 0, 0]).slice();
      this.gTarget = this.target.slice();
      this.minR = o.minR || 3;
      this.maxR = o.maxR || 160;
      this.follow = null;
      this.flight = 0;
      this.flightRate = 1.4;
      this.idle = 0;
      this.drift = o.drift !== false;
    }
    fly(g, dur) {
      if (g.theta !== undefined) this.gTheta = this.theta + wrapAngle(g.theta - this.theta);
      if (g.phi !== undefined) this.gPhi = clamp(g.phi, 0.12, Math.PI - 0.12);
      if (g.radius !== undefined) this.gRadius = clamp(g.radius, this.minR, this.maxR);
      if (g.target) this.gTarget = g.target.slice();
      if (S.reduced || !dur) {
        this.theta = this.gTheta; this.phi = this.gPhi; this.radius = this.gRadius; this.target = this.gTarget.slice();
        this.flight = 0;
      } else {
        this.flight = dur;
        this.flightRate = 3.2 / dur;
      }
    }
    input(dTheta, dPhi, zoomMul) {
      this.flight = 0;
      this.idle = 0;
      if (dTheta) this.gTheta += dTheta;
      if (dPhi) this.gPhi = clamp(this.gPhi + dPhi, 0.12, Math.PI - 0.12);
      if (zoomMul) this.gRadius = clamp(this.gRadius * zoomMul, this.minR, this.maxR);
    }
    update(dt) {
      if (this.follow) this.gTarget = this.follow();
      const fl = this.flight > 0;
      this.flight = Math.max(0, this.flight - dt);
      const kRot = 1 - Math.exp(-dt * (fl ? this.flightRate : 9));
      const kZoom = 1 - Math.exp(-dt * (fl ? this.flightRate : 9));
      const kTgt = 1 - Math.exp(-dt * (fl ? this.flightRate * 1.15 : (this.follow ? 7 : 8)));
      for (let i = 0; i < 3; i++) this.target[i] += (this.gTarget[i] - this.target[i]) * kTgt;
      this.theta += (this.gTheta - this.theta) * kRot;
      this.phi += (this.gPhi - this.phi) * kRot;
      this.gRadius = clamp(this.gRadius, this.minR, this.maxR);
      this.radius = Math.exp(lerp(Math.log(this.radius), Math.log(this.gRadius), kZoom));
      this.idle += dt;
      if (this.drift && !S.reduced && this.idle > 9 && !fl) this.gTheta += dt * 0.028;
    }
    eye() {
      const sp = Math.sin(this.phi);
      return [this.target[0] + this.radius * sp * Math.cos(this.theta), this.target[1] + this.radius * Math.cos(this.phi), this.target[2] + this.radius * sp * Math.sin(this.theta)];
    }
  }

  /* =======================================================================
     BODY DEFINITIONS (Explore)
     ======================================================================= */
  const ORBIT_SCALE = 3.6; // radians per second for catalog speed 1.0

  const EXPLORE_STYLE = {
    'Sun': {
      kind: 'star', spin: 0.03, tilt: 0.12,
      u: { uC0: [0.45, 0.07, 0.0], uC1: [1.0, 0.38, 0.03], uC2: [1.0, 0.74, 0.26], uC3: [1.0, 0.95, 0.78], uPulse: 0.012, uWarp: 0.0, uGlow: 2.0, uSeed: 1.3, uScale: 1.0 },
      corona: { color: [1.0, 0.60, 0.24], size: 7.2, amt: 1.0, pulse: 0.02 }
    },
    'Earth': {
      kind: 'earth', spin: 0.22, tilt: 0.41, ang0: 0.9,
      u: { uSeed: 3.1, uSea: 0.17, uCloudAmt: 0.34, uCloudRot: 0, uCity: 1.0, uBump: 0.10, uHue: MAT3_IDENTITY },
      atmo: { beta: [0.075, 0.17, 0.44], thick: 0.075, h: 0.022, int: 1.05 },
      moon: true
    },
    'Mars': {
      kind: 'rocky', spin: 0.2, tilt: 0.44, ang0: 2.6,
      u: { uPal0: [0.20, 0.08, 0.05], uPal1: [0.58, 0.27, 0.13], uPal2: [0.78, 0.47, 0.26], uPal3: [0.44, 0.19, 0.11], uCapCol: [0.9, 0.92, 0.95], uCrat: [0.13, 2.6, 7.0, 0.30], uMaria: 0.30, uCap: 0.13, uBump: 0.08, uSeed: 4.0, uSpec: 0.0, uIce: 0.0, uHue: MAT3_IDENTITY },
      atmo: { beta: [0.10, 0.06, 0.035], thick: 0.05, h: 0.014, int: 0.55 }
    },
    'Jupiter': {
      kind: 'gas', spin: 0.46, tilt: 0.05, ang0: 4.2,
      u: { uBand: new Float32Array([0.93, 0.86, 0.74, 0.80, 0.62, 0.42, 0.60, 0.40, 0.26, 0.74, 0.50, 0.34, 0.88, 0.80, 0.68]), uBandFreq: 11.0, uTurb: 1.3, uSeed: 2.0, uContrast: 1.25, uSpot: [-0.30, 0.7, 0.17, 1.0], uHue: MAT3_IDENTITY, uHasRing: 0.0, uRingN: [0, 1, 0], uCenter: [0, 0, 0], uRingR: [1, 2] },
      atmo: { beta: [0.10, 0.14, 0.22], thick: 0.05, h: 0.02, int: 0.32 }
    },
    'Saturn': {
      kind: 'gas', spin: 0.4, tilt: 0.466, ang0: 5.5,
      u: { uBand: new Float32Array([0.93, 0.86, 0.66, 0.84, 0.74, 0.52, 0.72, 0.62, 0.44, 0.90, 0.82, 0.62, 0.80, 0.72, 0.55]), uBandFreq: 9.0, uTurb: 0.6, uSeed: 6.0, uContrast: 0.8, uSpot: [0, 0, 0.1, 0.0], uHue: MAT3_IDENTITY, uHasRing: 1.0, uRingN: [0, 1, 0], uCenter: [0, 0, 0], uRingR: [1, 2] },
      atmo: { beta: [0.11, 0.13, 0.17], thick: 0.05, h: 0.02, int: 0.28 },
      ring: { inner: 1.24, outer: 2.3 }
    },
    'Ayla Prime': {
      kind: 'star', spin: 0.12, tilt: 0.3, ang0: 1.9,
      u: { uC0: [0.10, 0.02, 0.30], uC1: [0.45, 0.15, 0.85], uC2: [0.85, 0.45, 1.0], uC3: [1.0, 0.85, 1.0], uPulse: 0.07, uWarp: 0.85, uGlow: 1.8, uSeed: 8.0, uScale: 0.42 },
      corona: { color: [0.70, 0.36, 1.0], size: 6.4, amt: 1.0, pulse: 0.07 }
    }
  };

  /* =======================================================================
     STARFIELD + DUST MESHES
     ======================================================================= */
  const STAR_TINTS = [
    [0.62, 0.74, 1.0], [0.95, 0.96, 1.0], [1.0, 0.92, 0.76], [1.0, 0.76, 0.54], [1.0, 0.60, 0.46]
  ];
  function pickTint(r) {
    const x = r();
    if (x < 0.12) return STAR_TINTS[0];
    if (x < 0.46) return STAR_TINTS[1];
    if (x < 0.72) return STAR_TINTS[2];
    if (x < 0.90) return STAR_TINTS[3];
    return STAR_TINTS[4];
  }
  function makeFarStars(gl, count, bright, seed) {
    const r = rng(seed);
    const n = count + bright;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const z = r() * 2 - 1, a = r() * TAU, s = Math.sqrt(1 - z * z);
      const rad = 900;
      pos[i * 3] = Math.cos(a) * s * rad; pos[i * 3 + 1] = z * rad; pos[i * 3 + 2] = Math.sin(a) * s * rad;
      const t = pickTint(r);
      let b, size;
      if (i < count) { b = Math.pow(r(), 3.4) * 0.85 + 0.07; size = 0.9 + b * 1.5; }
      else { b = 0.95 + r() * 0.5; size = 4.6 + r() * 4.8; }
      col[i * 4] = t[0] * b; col[i * 4 + 1] = t[1] * b; col[i * 4 + 2] = t[2] * b; col[i * 4 + 3] = size;
      ph[i] = r();
    }
    return new Mesh(gl, [{ loc: 0, data: pos, size: 3 }, { loc: 1, data: col, size: 4 }, { loc: 2, data: ph, size: 1 }], { mode: gl.POINTS });
  }
  function makeDust(gl, count, seed, rMin, rMax) {
    const r = rng(seed);
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 4), ph = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const z = r() * 2 - 1, a = r() * TAU, s = Math.sqrt(1 - z * z);
      const rad = rMin + (rMax - rMin) * Math.cbrt(r());
      pos[i * 3] = Math.cos(a) * s * rad; pos[i * 3 + 1] = z * rad * 0.8; pos[i * 3 + 2] = Math.sin(a) * s * rad;
      const t = pickTint(r);
      const b = 0.035 + Math.pow(r(), 2.8) * 0.15;
      col[i * 4] = t[0] * b; col[i * 4 + 1] = t[1] * b; col[i * 4 + 2] = t[2] * b; col[i * 4 + 3] = 1.0 + r() * 1.3;
      ph[i] = r();
    }
    return new Mesh(gl, [{ loc: 0, data: pos, size: 3 }, { loc: 1, data: col, size: 4 }, { loc: 2, data: ph, size: 1 }], { mode: gl.POINTS });
  }
  function makeBelt(gl, count, inner, outer, seed) {
    const r = rng(seed);
    const base = GL.rockBase();
    const inst = new Float32Array(count * 4), rnd = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const rad = inner + (outer - inner) * (0.5 + gauss(r) * 0.28);
      inst[i * 4] = clamp(rad, inner - 0.4, outer + 0.4);
      inst[i * 4 + 1] = r() * TAU;
      inst[i * 4 + 2] = gauss(r) * 0.32;
      inst[i * 4 + 3] = lerp(0.022, 0.085, Math.pow(r(), 3.2));
      rnd[i * 4] = r(); rnd[i * 4 + 1] = r(); rnd[i * 4 + 2] = r(); rnd[i * 4 + 3] = r();
    }
    return new Mesh(gl, [
      { loc: 0, data: base.pos, size: 3 },
      { loc: 1, data: inst, size: 4, divisor: 1 },
      { loc: 2, data: rnd, size: 4, divisor: 1 }
    ], { indices: base.idx, instances: count });
  }
  function makeOrbitMesh(gl, dist, segs) {
    const pos = new Float32Array(segs * 3), ang = new Float32Array(segs);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * TAU;
      pos[i * 3] = Math.cos(a) * dist; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = -Math.sin(a) * dist;
      ang[i] = a;
    }
    return new Mesh(gl, [{ loc: 0, data: pos, size: 3 }, { loc: 1, data: ang, size: 1 }], { mode: gl.LINE_LOOP });
  }

  /* =======================================================================
     BODIES
     ======================================================================= */
  function bodyPos(b) {
    return [Math.cos(b.ang) * b.dist, 0, -Math.sin(b.ang) * b.dist];
  }

  function makeBody(o) {
    const b = Object.assign({ ang: 0, spinA: 0, tilt: 0, spin: 0.2, angVel: 0, dist: 0, moons: [] }, o);
    b.pos = bodyPos(b);
    b.model = M4.model(b.pos, b.radius, b.spinA, b.tilt);
    if (b.dist > 0) b.orbitMesh = makeOrbitMesh(S.gl, b.dist, 360);
    return b;
  }
  function disposeBody(b) {
    if (b.orbitMesh) b.orbitMesh.dispose();
    if (b.galaxyMesh) b.galaxyMesh.dispose();
    (b.moons || []).forEach((m) => m.orbitMesh && m.orbitMesh.dispose());
    if (b.label && b.label.el.parentNode) b.label.el.parentNode.removeChild(b.label.el);
  }

  function updateBody(b, dt, sc) {
    const scale = S.reduced ? 0.25 : 1;
    if (b.dist > 0) { b.ang += b.angVel * dt * scale; b.pos = bodyPos(b); }
    b.spinA += b.spin * dt * scale;
    if (b.u && b.u.uCloudRot !== undefined) b.u.uCloudRot += dt * 0.014 * scale;
    b.model = M4.model(b.pos, b.radius, b.spinA, b.tilt);
    if (b.ringDef) {
      b.ringN = [-Math.sin(b.tilt), Math.cos(b.tilt), 0];
      b.u.uRingN = b.ringN; b.u.uCenter = b.pos;
      b.u.uRingR = [b.ringDef.inner * b.radius, b.ringDef.outer * b.radius];
    }
    b.moons.forEach((m) => {
      m.ang += m.angVel * dt * scale;
      const lx = Math.cos(m.ang) * m.dist, lz = -Math.sin(m.ang) * m.dist;
      const ct = Math.cos(m.incl), st = Math.sin(m.incl);
      m.pos = [b.pos[0] + lx, b.pos[1] + lz * st, b.pos[2] + lz * ct];
      m.model = M4.model(m.pos, m.radius, m.ang + 1.2, 0);
    });
  }

  /* =======================================================================
     SCENES
     ======================================================================= */
  function newScene(rigOpts) {
    return { rig: new Rig(rigOpts), bodies: [], galaxies: [], belt: null, far: null, dust: null, vp: M4.identity(), eye: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], selected: null, labels: [], t: 0, hover: null, paused: false, orbitsOn: true };
  }

  function addLabel(sc, text, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'label';
    el.tabIndex = -1;
    el.textContent = text;
    el.style.display = 'none';
    el.addEventListener('click', onClick);
    S.labelsEl.appendChild(el);
    const lab = { el, op: -1, active: false, shown: false, wasActive: false };
    sc.labels.push(lab);
    return lab;
  }

  function buildExplorer(catalog) {
    const sc = newScene({ theta: -1.25, phi: 1.05, radius: 210, minR: 5, maxR: 180 });
    sc.rig.gTheta = -0.6; sc.rig.gRadius = 84; sc.rig.gPhi = 1.08;
    S.ex = sc;
    Object.keys(catalog).forEach((key) => {
      const d = catalog[key], st = EXPLORE_STYLE[key];
      if (!st) return;
      const b = makeBody({
        key, name: d.name, data: d, kind: st.kind, radius: d.radius, dist: d.dist,
        angVel: d.speed * ORBIT_SCALE, ang: st.ang0 || 0, spin: st.spin, tilt: st.tilt,
        u: st.u, atmo: st.atmo, corona: st.corona, ringDef: st.ring, focusDist: d.radius * (st.ring ? 7.6 : (d.dist === 0 ? 5.4 : 5.0)) + 1.4
      });
      if (st.moon) {
        b.moons.push({ radius: 0.27, dist: 2.3, angVel: 0.36, ang: 0.5, incl: 0.09, pos: [0, 0, 0], model: M4.identity(), orbit: makeOrbitMesh(S.gl, 2.3, 120), u: { uPal0: [0.16, 0.16, 0.17], uPal1: [0.38, 0.38, 0.38], uPal2: [0.62, 0.61, 0.58], uPal3: [0.30, 0.29, 0.27], uCapCol: [1, 1, 1], uCrat: [0.26, 3.6, 10.0, 0.45], uMaria: 0.9, uCap: 0, uBump: 0.11, uSeed: 9.0, uSpec: 0, uIce: 0, uHue: MAT3_IDENTITY } });
        b.moons[0].orbitMesh = b.moons[0].orbit;
      }
      updateBody(b, 0, sc);
      b.label = addLabel(sc, d.name, () => S.cb.onSelect && S.cb.onSelect(key));
      sc.bodies.push(b);
    });
    sc.belt = makeBelt(S.gl, S.cfg.belt, 17.2, 20.4, 77);
    sc.far = makeFarStars(S.gl, S.cfg.stars, S.cfg.bright, 11);
    sc.dust = makeDust(S.gl, S.cfg.dust, 23, 35, 260);
    return sc;
  }

  /* ---- sandbox ---- */
  const WORLD_TYPES = {
    oceanic: { kind: 'earth', baseHue: 205, atmo: { beta: [0.075, 0.17, 0.44], thick: 0.075, h: 0.022, int: 1.0 } },
    desert: { kind: 'rocky', baseHue: 24, atmo: { beta: [0.10, 0.065, 0.04], thick: 0.05, h: 0.015, int: 0.5 }, rocky: { pal: [[0.28, 0.14, 0.07], [0.62, 0.40, 0.20], [0.82, 0.58, 0.32], [0.50, 0.28, 0.14]], crat: [0.12, 3.0, 8.0, 0.3], maria: 0.25, cap: 0.0, bump: 0.10, spec: 0, ice: 0 } },
    barren: { kind: 'rocky', baseHue: null, atmo: null, rocky: { pal: [[0.15, 0.14, 0.14], [0.36, 0.34, 0.33], [0.60, 0.57, 0.54], [0.29, 0.27, 0.25]], crat: [0.42, 4.0, 11.0, 0.45], maria: 0.8, cap: 0.0, bump: 0.11, spec: 0, ice: 0 } },
    ice: { kind: 'rocky', baseHue: 205, atmo: { beta: [0.06, 0.12, 0.22], thick: 0.04, h: 0.016, int: 0.4 }, rocky: { pal: [[0.45, 0.55, 0.66], [0.80, 0.88, 0.95], [0.95, 0.98, 1.0], [0.70, 0.80, 0.90]], crat: [0.10, 3.0, 9.0, 0.2], maria: 0.0, cap: 0.0, bump: 0.05, spec: 0.5, ice: 1 } },
    gas: { kind: 'gas', baseHue: 30, atmo: { beta: [0.10, 0.14, 0.22], thick: 0.05, h: 0.02, int: 0.30 }, bands: [[0.93, 0.86, 0.74], [0.80, 0.62, 0.42], [0.60, 0.40, 0.26], [0.74, 0.50, 0.34], [0.88, 0.80, 0.68]], freq: 11, turb: 1.2, contrast: 1.2 },
    iceGiant: { kind: 'gas', baseHue: 200, atmo: { beta: [0.05, 0.14, 0.30], thick: 0.06, h: 0.022, int: 0.5 }, bands: [[0.66, 0.84, 0.92], [0.46, 0.73, 0.89], [0.34, 0.60, 0.85], [0.52, 0.79, 0.92], [0.74, 0.90, 0.96]], freq: 6, turb: 0.5, contrast: 0.7 }
  };

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0x00f0ff;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgbToHsv(c) {
    const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === c[0]) h = ((c[1] - c[2]) / d) % 6;
      else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
      else h = (c[0] - c[1]) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: mx === 0 ? 0 : d / mx, v: mx };
  }

  function buildWorldUniforms(type, tintHex, seed) {
    const T = WORLD_TYPES[type] || WORLD_TYPES.oceanic;
    const tint = hexToRgb(tintHex), hsv = rgbToHsv(tint);
    const r = rng(seed);
    const gain = 0.78 + 0.32 * hsv.v;
    let hue = MAT3_IDENTITY;
    if (T.baseHue !== null) hue = hueMatrix(hsv.h - T.baseHue, 0.45 + 0.85 * hsv.s, gain);
    const out = { kind: T.kind, atmo: T.atmo, u: {} };
    if (T.kind === 'earth') {
      out.u = { uSeed: 1 + r() * 20, uSea: 0.13 + r() * 0.12, uCloudAmt: 0.32 + r() * 0.2, uCloudRot: 0, uCity: 0.5, uBump: 0.12, uHue: hue };
    } else if (T.kind === 'rocky') {
      const R = T.rocky;
      let pal = R.pal;
      if (type === 'barren') {
        const k = 0.72 * (0.35 + 0.65 * hsv.s);
        const m = Math.max(tint[0], tint[1], tint[2]) || 1;
        pal = pal.map((c) => [c[0] * (1 - k + k * tint[0] / m * 1.1), c[1] * (1 - k + k * tint[1] / m * 1.1), c[2] * (1 - k + k * tint[2] / m * 1.1)]);
      }
      out.u = { uPal0: pal[0], uPal1: pal[1], uPal2: pal[2], uPal3: pal[3], uCapCol: [0.92, 0.94, 0.97], uCrat: R.crat, uMaria: R.maria, uCap: R.cap, uBump: R.bump, uSeed: 1 + r() * 30, uSpec: R.spec, uIce: R.ice, uHue: hue };
    } else {
      const bands = new Float32Array(15);
      T.bands.forEach((c, i) => { bands[i * 3] = c[0]; bands[i * 3 + 1] = c[1]; bands[i * 3 + 2] = c[2]; });
      out.u = { uBand: bands, uBandFreq: T.freq * (0.85 + r() * 0.35), uTurb: T.turb, uSeed: 1 + r() * 40, uContrast: T.contrast, uSpot: type === 'gas' && r() > 0.45 ? [-0.2 - r() * 0.3, r() * 6 - 3, 0.12 + r() * 0.08, 1.0] : [0, 0, 0.1, 0.0], uHue: hue, uHasRing: 0.0, uRingN: [0, 1, 0], uCenter: [0, 0, 0], uRingR: [1, 2] };
    }
    return out;
  }

  const SB_STAR = { radius: 2.5 };
  let sbId = 1;

  function buildSandbox() {
    const sc = newScene({ theta: -0.7, phi: 1.0, radius: 46, minR: 5, maxR: 170 });
    S.sb = sc;
    sc.starBody = {
      key: 'star', name: 'Central star', kind: 'star', radius: SB_STAR.radius, dist: 0, pos: [0, 0, 0], spin: 0.04, spinA: 0, tilt: 0.1, moons: [], model: M4.model([0, 0, 0], SB_STAR.radius, 0, 0.1),
      u: { uC0: [0.04, 0.20, 0.46], uC1: [0.18, 0.62, 0.95], uC2: [0.62, 0.90, 1.0], uC3: [0.96, 1.0, 1.0], uPulse: 0.015, uWarp: 0.2, uGlow: 2.0, uSeed: 5.0, uScale: 0.7 },
      corona: { color: [0.42, 0.78, 1.0], size: 7.0, amt: 0.95, pulse: 0.02 }
    };
    sc.far = makeFarStars(S.gl, S.cfg.stars, S.cfg.bright, 31);
    sc.dust = makeDust(S.gl, Math.round(S.cfg.dust * 0.7), 43, 35, 260);
    sc.time = 0;
    return sc;
  }

  function sandboxItems() {
    return S.sb.bodies.map((b) => ({ id: b.id, name: b.name, kind: 'world', type: b.worldType, color: b.tintHex, radius: b.radius, dist: b.dist, speed: b.speedUser }))
      .concat(S.sb.galaxies.map((g) => ({ id: g.id, name: g.name, kind: 'galaxy', type: g.arms + ' arms', color: g.tintHex, size: g.size })));
  }
  function emitSandbox() { if (S.cb.onSandboxChange) S.cb.onSandboxChange(sandboxItems()); }

  function sandboxAddPlanet(o) {
    const sc = S.sb;
    const type = WORLD_TYPES[o.type] ? o.type : 'oceanic';
    const radius = clamp(+o.radius || 0.8, 0.3, 2.5);
    const minDist = SB_STAR.radius + radius + 1.0;
    let dist = clamp(+o.dist || 10, 4, 22);
    let adjusted = false;
    if (dist < minDist) { dist = minDist; adjusted = true; }
    const speed = clamp(+o.speed || 1, 0.2, 3);
    const id = 'w' + (sbId++);
    const seed = o.seed || Math.floor(Math.random() * 1000);
    const W = buildWorldUniforms(type, o.color || '#00f0ff', seed);
    const b = makeBody({
      key: id, name: (o.name || 'Planet-X').slice(0, 28), kind: W.kind, radius, dist,
      angVel: speed * 0.35, ang: o.ang !== undefined ? o.ang : Math.random() * TAU, spin: 0.25 + Math.random() * 0.3, tilt: (Math.random() - 0.5) * 0.7,
      u: W.u, atmo: W.atmo
    });
    b.id = id; b.worldType = type; b.tintHex = o.color || '#00f0ff'; b.speedUser = speed; b.focusDist = radius * 5.2 + 1.4;
    b.label = addLabel(sc, b.name, () => sandboxFocus(id));
    sc.bodies.push(b);
    emitSandbox();
    return { id, name: b.name, dist, adjusted, type };
  }

  function makeGalaxyMesh(gl, arms, size, tintRgb, seed, count) {
    const r = rng(seed);
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 4), ph = new Float32Array(count);
    const twist = 2.4 + r() * 0.8;
    const warmCore = [1.0, 0.82, 0.58];
    const armCol = [lerp(tintRgb[0], 1, 0.28), lerp(tintRgb[1], 1, 0.28), lerp(tintRgb[2], 1, 0.28)];
    for (let i = 0; i < count; i++) {
      const bulge = r() < 0.2;
      let x, y, z, c, b, sz;
      if (bulge) {
        const rad = Math.abs(gauss(r)) * size * 0.1;
        const a = r() * TAU, e = (r() - 0.5) * 2;
        const s = Math.sqrt(1 - e * e);
        x = Math.cos(a) * s * rad; z = Math.sin(a) * s * rad; y = e * rad * 0.7;
        c = warmCore; b = 0.35 + r() * 0.5; sz = 1.4 + r() * 1.6;
      } else {
        const rad = -Math.log(1 - r() * 0.985) * size * 0.2;
        const arm = Math.floor(r() * arms);
        const base = (arm / arms) * TAU + twist * Math.log(1 + rad / (size * 0.1));
        const spread = (0.05 + 0.22 * Math.min(rad / size, 1)) * gauss(r);
        const a = base + spread;
        const rr = rad * (1 + gauss(r) * 0.05);
        x = Math.cos(a) * rr; z = Math.sin(a) * rr; y = gauss(r) * size * 0.012 * (1 + 2 * Math.exp(-rad / (size * 0.15)));
        const young = r() < 0.22;
        c = young ? [0.72, 0.82, 1.0] : armCol;
        b = (young ? 0.55 : 0.30) + r() * 0.5; sz = 1.1 + r() * 1.9;
        if (r() < 0.012) { b = 1.0; sz = 3.2 + r() * 2.0; }
      }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      col[i * 4] = c[0] * b; col[i * 4 + 1] = c[1] * b; col[i * 4 + 2] = c[2] * b; col[i * 4 + 3] = sz;
      ph[i] = r();
    }
    return new Mesh(gl, [{ loc: 0, data: pos, size: 3 }, { loc: 1, data: col, size: 4 }, { loc: 2, data: ph, size: 1 }], { mode: gl.POINTS });
  }

  /* column-major model matrix from three basis axes and a translation */
  function basisModel(ax, ay, az, pos) {
    return new Float32Array([ax[0], ax[1], ax[2], 0, ay[0], ay[1], ay[2], 0, az[0], az[1], az[2], 0, pos[0], pos[1], pos[2], 1]);
  }

  function sandboxAddGalaxy(o) {
    const sc = S.sb;
    const arms = clamp(Math.round(+o.arms || 3), 2, 5);
    const size = clamp(+o.size || 16, 8, 30);
    const tiltDeg = clamp(+o.tilt || 55, 0, 85);
    const tintHex = o.color || '#8f7bff';
    const id = 'g' + (sbId++);
    const rig = sc.rig;
    // placed beyond the system, roughly in the direction the camera is looking
    const look = V3.norm([-Math.cos(rig.theta) * Math.sin(rig.phi), 0, -Math.sin(rig.theta) * Math.sin(rig.phi)]);
    const yaw = (Math.random() - 0.5) * 1.8;
    const dir = [look[0] * Math.cos(yaw) - look[2] * Math.sin(yaw), 0, look[0] * Math.sin(yaw) + look[2] * Math.cos(yaw)];
    const dist = 78 + Math.random() * 30 + size * 0.8;
    const pos = [dir[0] * dist, (Math.random() - 0.2) * 22, dir[2] * dist];
    // the camera will look at it from the same direction the rig looks at the system now
    const sp = Math.sin(rig.phi);
    const toCam = V3.norm([Math.cos(rig.theta) * sp, Math.cos(rig.phi), Math.sin(rig.theta) * sp]);
    const t = tiltDeg * Math.PI / 180;
    let camUp = V3.sub([0, 1, 0], V3.scale(toCam, toCam[1]));
    if (V3.len(camUp) < 0.05) camUp = [1, 0, 0];
    camUp = V3.norm(camUp);
    const normal = V3.norm(V3.add(V3.scale(toCam, Math.cos(t)), V3.scale(camUp, Math.sin(t))));
    let axis1 = V3.cross(normal, toCam);
    if (V3.len(axis1) < 0.01) axis1 = V3.cross(normal, [0, 0, 1]);
    axis1 = V3.norm(axis1);
    const axis2 = V3.cross(axis1, normal);
    const model = basisModel(axis1, normal, axis2, pos);
    const tint = hexToRgb(tintHex);
    const g = {
      id, name: (o.name || 'Galaxy').slice(0, 28), arms, size, tiltDeg, tintHex, pos, model, normal, toCam,
      mesh: makeGalaxyMesh(S.gl, arms, size, tint, Math.floor(Math.random() * 99999), S.cfg.galaxy),
      glowColor: [lerp(tint[0], 1, 0.35), lerp(tint[1], 0.85, 0.3), lerp(tint[2], 0.7, 0.2)], spin: 0
    };
    g.label = addLabel(sc, g.name, () => sandboxFocus(id));
    sc.galaxies.push(g);
    emitSandbox();
    sandboxFocus(id);
    return { id, name: g.name };
  }

  function sandboxFocus(id) {
    const sc = S.sb;
    const b = sc.bodies.find((x) => x.id === id);
    const g = sc.galaxies.find((x) => x.id === id);
    sc.selected = b || g || null;
    sc.labels.forEach((l) => l.active = false);
    if (sc.selected && sc.selected.label) sc.selected.label.active = true;
    if (b) {
      sc.rig.minR = b.radius * 2.6; sc.rig.maxR = 120;
      sc.rig.follow = () => b.pos;
      // approach from the star's side, so the lit face is the one on screen
      sc.rig.fly({ radius: b.focusDist, phi: 1.2, theta: Math.atan2(-b.pos[2], -b.pos[0]) + 0.8 }, 2.4);
    } else if (g) {
      sc.rig.follow = null;
      sc.rig.minR = 6; sc.rig.maxR = 220;
      const sp = Math.sin(sc.rig.gPhi);
      sc.rig.fly({ target: g.pos, radius: g.size * 2.8 }, 3.0);
      void sp;
    }
  }
  function sandboxOverview() {
    const sc = S.sb;
    sc.selected = null;
    sc.labels.forEach((l) => l.active = false);
    sc.rig.follow = null; sc.rig.minR = 5; sc.rig.maxR = 170;
    sc.rig.fly({ target: [0, 0, 0], radius: 46, phi: 1.0 }, 2.4);
  }

  function sandboxRemove(id) {
    const sc = S.sb;
    let i = sc.bodies.findIndex((x) => x.id === id);
    if (i !== -1) { disposeBody(sc.bodies[i]); sc.labels = sc.labels.filter((l) => l !== sc.bodies[i].label); if (sc.selected === sc.bodies[i]) sandboxOverview(); sc.bodies.splice(i, 1); emitSandbox(); return; }
    i = sc.galaxies.findIndex((x) => x.id === id);
    if (i !== -1) { disposeBody(sc.galaxies[i]); sc.labels = sc.labels.filter((l) => l !== sc.galaxies[i].label); if (sc.selected === sc.galaxies[i]) sandboxOverview(); sc.galaxies.splice(i, 1); emitSandbox(); }
  }
  function sandboxReset() {
    const sc = S.sb;
    sc.bodies.forEach(disposeBody); sc.galaxies.forEach(disposeBody);
    sc.bodies = []; sc.galaxies = []; sc.labels = []; sc.selected = null;
    sc.rig.follow = null;
    emitSandbox();
    sandboxOverview();
  }

  /* =======================================================================
     RENDERING
     ======================================================================= */
  function setState(blend, depthTest, depthWrite, cull) {
    const gl = S.gl;
    if (depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(!!depthWrite);
    if (cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); } else gl.disable(gl.CULL_FACE);
    if (blend === 'add') { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); }
    else if (blend === 'alpha') { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); }
    else gl.disable(gl.BLEND);
  }

  function prepareCamera(sc) {
    const eye = sc.rig.eye();
    const view = M4.lookAt(eye, sc.rig.target, [0, 1, 0]);
    const proj = M4.perspective(FOV, S.w / S.h, NEAR, FAR);
    proj[8] = -S.shift.x; proj[9] = -S.shift.y;
    sc.eye = eye; sc.view = view; sc.proj = proj;
    sc.vp = M4.multiply(proj, view);
    sc.right = [view[0], view[4], view[8]];
    sc.up = [view[1], view[5], view[9]];
    sc.fwd = [-view[2], -view[6], -view[10]];
  }

  function drawBackground(sc) {
    const gl = S.gl, P = S.programs.bg;
    setState(null, false, false, false);
    P.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, S.sky.tex);
    P.i('uSky', 0).v3('uFwd', sc.fwd).v3('uRight', sc.right).v3('uUp', sc.up)
      .v2('uTan', Math.tan(FOV / 2) * (S.w / S.h), Math.tan(FOV / 2)).f('uSkyRot', S.skyRot).f('uExposure', 1.0);
    gl.bindVertexArray(S.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function drawStars(sc) {
    const P = S.programs.stars;
    P.use();
    P.m4('uVP', sc.vp).v3('uCam', sc.eye).f('uPx', S.dpr).f('uTime', S.time).f('uTw', S.reduced ? 0 : 1).f('uSkyRot', S.skyRot).f('uNear', 90);
    setState('add', true, false, false);
    P.f('uLock', 1); sc.far.draw();
    P.f('uLock', 0); sc.dust.draw();
  }

  function drawOrbit(P, mesh, ang, boost, off) {
    P.f('uBodyAng', ang).f('uBoost', boost).v3('uOff', off || [0, 0, 0]);
    mesh.draw();
  }

  function drawSphereOpaque(b, sc) {
    const P = useCommon(S.programs[b.kind], sc);
    P.m4('uModel', b.model);
    applyU(P, b.u);
    S.meshes.sphere.draw();
  }

  function renderScene(sc, dt) {
    const gl = S.gl;
    sc.t += dt;
    prepareCamera(sc);
    gl.viewport(0, 0, S.canvas.width, S.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    drawBackground(sc);
    drawStars(sc);

    const isEx = sc === S.ex;
    const allBodies = isEx ? sc.bodies : [sc.starBody].concat(sc.bodies);

    /* orbit lines */
    if (sc.orbitsOn) {
      const P = S.programs.orbit;
      P.use();
      P.m4('uVP', sc.vp).v3('uColor', [0.52, 0.58, 1.0]).f('uBase', 0.10).f('uTrail', 0.52);
      setState('add', true, false, false);
      allBodies.forEach((b) => {
        if (!b.orbitMesh) return;
        drawOrbit(P, b.orbitMesh, b.ang, sc.selected === b ? 2.2 : 1.0);
        b.moons.forEach((m) => {
          P.f('uBase', 0.05).f('uTrail', 0.3);
          drawOrbit(P, m.orbitMesh, m.ang, 1.0, b.pos);
          P.f('uBase', 0.10).f('uTrail', 0.52);
        });
      });
    }

    /* opaque: bodies, moons, rocks */
    setState(null, true, true, true);
    allBodies.forEach((b) => {
      drawSphereOpaque(b, sc);
      b.moons.forEach((m) => {
        const P = useCommon(S.programs.rocky, sc);
        P.m4('uModel', m.model);
        applyU(P, m.u);
        S.meshes.sphere.draw();
      });
    });
    if (isEx && sc.belt) {
      const P = S.programs.belt;
      P.use();
      P.m4('uVP', sc.vp).v3('uSunPos', [0, 0, 0]).f('uBeltT', S.reduced ? S.time * 0.25 : S.time * 2.8);
      sc.belt.draw();
    }

    /* rings (alpha) */
    setState('alpha', true, false, false);
    allBodies.forEach((b) => {
      if (!b.ringDef) return;
      const P = useCommon(S.programs.ring, sc);
      const m = M4.model(b.pos, b.radius, 0, b.tilt);
      P.m4('uModel', m).v3('uRingN', b.ringN).v3('uCenter', b.pos).v2('uLocalR', b.ringDef.inner, b.ringDef.outer).f('uPlanetR', b.radius).m3('uHue', MAT3_IDENTITY);
      S.meshes.ring.draw();
    });

    /* galaxies (sandbox) */
    if (!isEx) {
      setState('add', true, false, false);
      sc.galaxies.forEach((g) => {
        g.spin += dt * (S.reduced ? 0.1 : 0.45);
        const P = S.programs.galaxy;
        P.use();
        P.m4('uVP', sc.vp).m4('uModel', g.model).v3('uCam', sc.eye).f('uPx', S.dpr).f('uTime', S.time).f('uSpin', g.spin * 0.12).f('uNear', 70);
        g.mesh.draw();
        const G = S.programs.glow;
        G.use();
        G.m4('uVP', sc.vp).v3('uCenter', g.pos).v3('uRight', sc.right).v3('uUp', sc.up).f('uSize', g.size * 0.75).v3('uColor', g.glowColor).f('uAmt', 0.32);
        S.meshes.quad.draw();
      });
    }

    /* additive: atmospheres and coronas */
    setState('add', true, false, true);
    allBodies.forEach((b) => {
      if (!b.atmo) return;
      const A = b.atmo;
      const Ra = b.radius * (1 + A.thick);
      if (V3.dist(sc.eye, b.pos) < Ra * 1.04) return;
      const P = useCommon(S.programs.atmo, sc);
      P.m4('uModel', M4.model(b.pos, Ra, 0, 0)).v3('uCenter', b.pos).v3('uBeta', A.beta).f('uRp', b.radius).f('uRa', Ra).f('uH', b.radius * A.h).f('uInt', A.int);
      S.meshes.sphere.draw();
    });
    setState('add', true, false, false);
    allBodies.forEach((b) => {
      if (!b.corona) return;
      const C = b.corona;
      const dCam = V3.dist(sc.eye, b.pos);
      const fade = clamp((dCam - b.radius * 1.5) / (b.radius * 5.0), 0, 1);
      if (fade <= 0.001) return;
      const P = S.programs.corona;
      P.use();
      P.m4('uVP', sc.vp).v3('uCenter', b.pos).v3('uRight', sc.right).v3('uUp', sc.up).f('uSize', b.radius * C.size)
        .v3('uColor', C.color).f('uTime', S.time).f('uStarR', 1 / C.size).f('uPulse', C.pulse).f('uAmt', C.amt * (0.72 * fade * fade * (3 - 2 * fade)));
      S.meshes.quad.draw();
    });
  }

  /* ---------- labels ---------- */
  function setLabel(lab, display, x, y, op) {
    const el = lab.el;
    if (!display) {
      if (lab.shown) { el.style.display = 'none'; lab.shown = false; }
      return;
    }
    if (!lab.shown) { el.style.display = ''; lab.shown = true; lab.op = -1; }
    el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    if (Math.abs(lab.op - op) > 0.02) {
      el.style.opacity = op;
      el.style.pointerEvents = op > 0.25 ? '' : 'none';
      lab.op = op;
    }
    if (lab.wasActive !== lab.active) { el.classList.toggle('is-active', !!lab.active); lab.wasActive = lab.active; }
  }
  function updateLabels(sc) {
    const tanH = Math.tan(FOV / 2);
    const items = sc.bodies.map((b) => ({ lab: b.label, pos: b.pos, r: b.radius, obj: b }));
    if (sc === S.sb) sc.galaxies.forEach((g) => items.push({ lab: g.label, pos: g.pos, r: g.size * 0.12, obj: g }));
    items.forEach((it) => {
      const lab = it.lab;
      if (!lab) return;
      if (!S.labelsOn) { setLabel(lab, false); return; }
      const p = M4.project(sc.vp, it.pos, S.w, S.h);
      if (!(p[2] > 0 && p[0] > -60 && p[0] < S.w + 60 && p[1] > -60 && p[1] < S.h + 60)) { setLabel(lab, false); return; }
      const rpx = (it.r * (S.h / 2)) / (tanH * p[2]);
      let op = 1;
      if (rpx > S.h * 0.5) op = 0;
      else if (it.obj !== sc.selected && p[2] > 150) op = 0.7;
      setLabel(lab, op > 0, Math.round(p[0] + Math.max(rpx, 4) + 10), Math.round(p[1] - 16), op);
    });
  }
  function hideLabels(sc) {
    if (!sc) return;
    sc.labels.forEach((l) => setLabel(l, false));
  }

  /* ---------- picking ---------- */
  function pickAt(sc, x, y, touch) {
    const tanH = Math.tan(FOV / 2);
    let best = null, bestD = 1e9;
    const cands = sc === S.ex ? sc.bodies : sc.bodies.concat(sc.galaxies);
    cands.forEach((b) => {
      const p = M4.project(sc.vp, b.pos, S.w, S.h);
      if (p[2] <= 0) return;
      const r = b.size !== undefined ? b.size * 0.12 : b.radius;
      const rpx = (r * (S.h / 2)) / (tanH * p[2]);
      const lim = Math.max(rpx * 1.12, touch ? 30 : 20);
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d <= lim && p[2] < bestD) { best = b; bestD = p[2]; }
    });
    return best;
  }

  /* ---------- stage input ---------- */
  function bindStage(el, getScene, isActive) {
    const pts = new Map();
    let moved = 0, down = null, pinch = 0;
    el.addEventListener('pointerdown', (e) => {
      if (!isActive()) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { moved = 0; down = { x: e.clientX, y: e.clientY, t: performance.now() }; el.classList.add('is-dragging'); }
      if (pts.size === 2) { const a = [...pts.values()]; pinch = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); down = null; }
    });
    el.addEventListener('pointermove', (e) => {
      const sc = getScene();
      if (!isActive() || !sc) return;
      const prev = pts.get(e.pointerId);
      if (!prev) {
        if (e.pointerType === 'mouse') el.classList.toggle('is-over', !!pickAt(sc, e.clientX, e.clientY, false));
        return;
      }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      prev.x = e.clientX; prev.y = e.clientY;
      if (pts.size === 1) {
        moved += Math.abs(dx) + Math.abs(dy);
        sc.rig.input(-dx * 0.0056, -dy * 0.0056, 0);
      } else if (pts.size === 2) {
        const a = [...pts.values()];
        const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (pinch > 0 && d > 0) sc.rig.input(0, 0, pinch / d);
        pinch = d;
      }
    });
    const end = (e) => {
      const sc = getScene();
      const had = pts.delete(e.pointerId);
      if (pts.size === 0) el.classList.remove('is-dragging');
      if (had && down && sc && moved < 7 && performance.now() - down.t < 650) {
        const hit = pickAt(sc, e.clientX, e.clientY, e.pointerType !== 'mouse');
        if (hit) handlePick(sc, hit);
      }
      if (pts.size < 2) pinch = 0;
      if (pts.size === 0) down = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => el.classList.remove('is-over'));
    el.addEventListener('wheel', (e) => {
      const sc = getScene();
      if (!isActive() || !sc) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : 1;
      sc.rig.input(0, 0, Math.exp(clamp(e.deltaY * unit, -240, 240) * 0.0012));
    }, { passive: false });
  }

  function handlePick(sc, hit) {
    if (sc === S.ex) { if (S.cb.onSelect) S.cb.onSelect(hit.key); }
    else sandboxFocus(hit.id);
  }

  /* =======================================================================
     EXPLORE controls
     ======================================================================= */
  function exFocus(key) {
    const sc = S.ex;
    const b = sc.bodies.find((x) => x.key === key);
    if (!b) return;
    sc.selected = b;
    sc.labels.forEach((l) => l.active = false);
    b.label.active = true;
    sc.rig.minR = b.radius * 2.6; sc.rig.maxR = 110;
    sc.rig.follow = () => b.pos;
    const g = { radius: b.focusDist, phi: 1.22 };
    if (b.dist > 0) g.theta = Math.atan2(-b.pos[2], -b.pos[0]) + 0.8;
    sc.rig.fly(g, 2.6);
  }
  function exOverview() {
    const sc = S.ex;
    sc.selected = null;
    sc.labels.forEach((l) => l.active = false);
    sc.rig.follow = null; sc.rig.minR = 5; sc.rig.maxR = 180;
    sc.rig.fly({ target: [0, 0, 0], radius: 84, phi: 1.08 }, 2.8);
  }

  /* =======================================================================
     MAIN LOOP
     ======================================================================= */
  function resize() {
    if (!S.canvas) return;
    const cw = S.canvas.clientWidth || window.innerWidth, ch = S.canvas.clientHeight || window.innerHeight;
    S.dpr = Math.max(0.6, Math.min(window.devicePixelRatio || 1, S.cfg.dprCap) * S.dprScale);
    S.w = cw; S.h = ch;
    const bw = Math.max(2, Math.floor(cw * S.dpr)), bh = Math.max(2, Math.floor(ch * S.dpr));
    if (S.canvas.width !== bw || S.canvas.height !== bh) { S.canvas.width = bw; S.canvas.height = bh; }
  }

  function activeScene() { return S.mode === 'create' ? S.sb : S.ex; }

  function frame(now) {
    if (!S.running) return;
    requestAnimationFrame(frame);
    if (document.hidden || S.fatal) { S.lastT = 0; return; }
    if (!S.lastT) S.lastT = now;
    let dt = Math.min((now - S.lastT) / 1000, 0.05);
    S.lastT = now;
    S.tick++;
    // pages that sit over the universe (Ask, Log) only need ~30 fps
    if ((S.mode === 'ask' || S.mode === 'discoveries') && (S.tick & 1)) return;
    if (S.mode === 'ask' || S.mode === 'discoveries') dt *= 2;

    S.frame++;
    S.time += dt;
    if (!S.reduced) S.skyRot += dt * 0.0016;
    const sc = activeScene();
    if (!sc) return;
    const speed = sc === S.sb && sc.paused ? 0 : 1;
    sc.rig.update(dt);
    {
      const k = S.reduced ? 1 : 1 - Math.exp(-dt * 3.2), sh = S.shift;
      sh.x += (sh.tx - sh.x) * k; sh.y += (sh.ty - sh.y) * k;
    }
    if (sc === S.ex) {
      S.ex.bodies.forEach((b) => updateBody(b, dt, S.ex));
    } else {
      sc.starBody.spinA += sc.starBody.spin * dt;
      sc.starBody.model = M4.model([0, 0, 0], SB_STAR.radius, sc.starBody.spinA, sc.starBody.tilt);
      sc.bodies.forEach((b) => updateBody(b, dt * speed, sc));
    }
    renderScene(sc, dt * (speed || 0));
    updateLabels(sc);
    watchPerf(dt);
  }

  function watchPerf(dt) {
    const p = S.perf;
    if (S.time < 3) return;
    p.acc += dt; p.n++;
    if (p.n >= 90) {
      const avg = p.acc / p.n;
      p.acc = 0; p.n = 0;
      if (avg > 0.034 && S.dprScale > 0.6) {
        S.dprScale = Math.max(0.6, S.dprScale - 0.2);
        resize();
      }
    }
  }

  /* =======================================================================
     PUBLIC API
     ======================================================================= */
  const API = {
    supported() { return GL.webgl2Supported(); },

    async init(opts) {
      S.canvas = opts.canvas;
      S.labelsEl = opts.labelsEl;
      S.cb = { onSelect: opts.onSelect, onSandboxChange: opts.onSandboxChange, onFatal: opts.onFatal };
      S.cfg = qualityConfig(opts.quality, opts.hint);
      S.reduced = !!opts.reduced;
      S.labelsOn = opts.labels !== false;
      const progress = opts.onProgress || (() => {});
      const gl = GL.getContext(S.canvas);
      if (!gl) throw new Error('WebGL2 is not available');
      S.gl = gl;
      S.emptyVao = gl.createVertexArray();
      S.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); S.fatal = true; if (S.cb.onFatal) S.cb.onFatal('context-lost'); });
      resize();

      // 1. compile programs, one per frame so the page stays responsive
      const names = Object.keys(SH.programs);
      const defs = '#define LOWQ ' + S.cfg.lowq + '\n';
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        S.programs[n] = new Program(gl, n, SH.programs[n].vs, SH.programs[n].fs, defs);
        progress(0.08 + 0.42 * ((i + 1) / names.length), 'Compiling the sky and planets');
        await nextFrame();
      }

      // 2. meshes
      S.meshes.sphere = GL.sphereMesh(gl, S.cfg.seg, S.cfg.rings);
      S.meshes.ring = GL.ringMesh(gl, 1.24, 2.3, 256);
      S.meshes.quad = GL.quadMesh(gl);

      // 3. bake the sky, one cube face per frame
      const cube = GL.createCube(gl, S.cfg.sky);
      S.sky = cube;
      const P = S.programs.sky;
      gl.bindFramebuffer(gl.FRAMEBUFFER, cube.fbo);
      gl.viewport(0, 0, cube.size, cube.size);
      setState(null, false, false, false);
      P.use();
      P.f('uSeed', 2.7);
      for (let f = 0; f < 6; f++) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, cube.tex, 0);
        if (f === 0 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Sky render target is incomplete');
        P.i('uFace', f);
        gl.bindVertexArray(S.emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.finish();
        progress(0.5 + 0.38 * ((f + 1) / 6), 'Painting the night sky');
        await nextFrame();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // 4. scenes
      buildExplorer(opts.catalog);
      buildSandbox();
      sandboxAddPlanet({ name: 'Ayla-Alpha', type: 'oceanic', radius: 0.9, dist: 8, speed: 1, color: '#00f0ff', ang: 0.6, seed: 12 });
      progress(0.94, 'Warming up');
      await nextFrame();

      // warm both scenes once so the first visible frame does not hitch
      resize();
      [S.ex, S.sb].forEach((sc) => { S.frame++; sc.rig.update(0.016); renderScene(sc, 0); hideLabels(sc); });
      gl.finish();

      bindStage(opts.stageExplorer, () => S.ex, () => S.mode === 'explore');
      bindStage(opts.stageSandbox, () => S.sb, () => S.mode === 'create');
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', () => { S.lastT = 0; });
      progress(1, 'Ready');
      S.ready = true;
      return { quality: S.cfg.name };
    },

    start() {
      if (S.running || !S.ready) return;
      S.running = true;
      S.lastT = 0;
      requestAnimationFrame(frame);
    },
    setMode(mode) {
      const m = mode === 'create' ? 'create' : (mode === 'ask' || mode === 'discoveries' ? mode : 'explore');
      const prevScene = activeScene();
      S.mode = m;
      if (activeScene() !== prevScene) hideLabels(prevScene);
      resize();
    },
    setViewShift(x, y) { S.shift.tx = +x || 0; S.shift.ty = +y || 0; },
    focusBody: exFocus,
    overview: exOverview,
    setReducedMotion(v) { S.reduced = !!v; },
    setLabels(v) { S.labelsOn = !!v; if (!v) { hideLabels(S.ex); hideLabels(S.sb); } },
    resize,
    isReady() { return !!S.ready; },
    sandbox: {
      addPlanet: sandboxAddPlanet,
      addGalaxy: sandboxAddGalaxy,
      remove: sandboxRemove,
      reset: sandboxReset,
      list: sandboxItems,
      focus: sandboxFocus,
      overview: sandboxOverview,
      setPaused(v) { S.sb.paused = !!v; },
      setOrbits(v) { S.sb.orbitsOn = !!v; }
    }
  };

  global.AYLA_UNIVERSE = API;
  if (/[?&]debug\b/.test(location.search)) global.AYLA_UNIVERSE._S = S;
})(window);
