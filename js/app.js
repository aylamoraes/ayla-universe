/* =========================================================================
   AYLA UNIVERSE — interface
   Opening sequence, navigation, inspector, Ask AYLA, Creator Lab, discoveries
   log, settings, ambient audio. The 3D work lives in universe.js; if that cannot
   run on a device, fallback.js provides a 2D map with the same interface.
   ========================================================================= */
(function (global) {
  'use strict';

  const DATA = global.AYLA_DATA;
  const CAT = DATA.CELESTIAL_CATALOG;
  const BODY_KEYS = Object.keys(CAT);
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'ayla-universe:v2';
  const MODES = ['explore', 'ask', 'create', 'discoveries'];
  const MODE_SECTION = { explore: 'modeExplorer', ask: 'modeAsk', create: 'modeCreate', discoveries: 'modeDiscoveries' };
  const LIMITS = { worlds: 14, galaxies: 6 };

  const mqReduce = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const mqCoarse = global.matchMedia ? global.matchMedia('(pointer: coarse)') : { matches: false };

  const state = {
    mode: 'intro',
    engine: null,          // AYLA_UNIVERSE, or AYLA_FALLBACK when 3D is unavailable
    usingFallback: false,
    ready: false,
    booting: false,
    entering: false,
    entered: false,
    enterRequested: false,
    selected: null,
    discoveries: {},       // body name -> ISO date
    prefs: { reduceMotion: null, labels: true, onboardingDone: false },
    sound: false,
    sandboxPaused: false,
    sandboxOrbits: true,
    sandboxItems: [],
    resetArmed: false
  };

  /* ------------------------------------------------------------------ *
   *  Storage (every access is guarded: private windows can throw)
   * ------------------------------------------------------------------ */
  function loadStore() {
    try {
      const raw = global.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        if (d.discoveries && typeof d.discoveries === 'object') {
          Object.keys(d.discoveries).forEach((k) => { if (CAT[k]) state.discoveries[k] = String(d.discoveries[k]); });
        }
        if (d.prefs && typeof d.prefs === 'object') {
          if (typeof d.prefs.reduceMotion === 'boolean') state.prefs.reduceMotion = d.prefs.reduceMotion;
          if (typeof d.prefs.labels === 'boolean') state.prefs.labels = d.prefs.labels;
          if (typeof d.prefs.onboardingDone === 'boolean') state.prefs.onboardingDone = d.prefs.onboardingDone;
        }
      }
    } catch (_) { /* storage unavailable or corrupt: start fresh */ }
  }
  function saveStore() {
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify({ discoveries: state.discoveries, prefs: state.prefs })); } catch (_) { /* ignore */ }
  }
  function clearStore() {
    try { global.localStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ }
  }

  const reduced = () => (state.prefs.reduceMotion === null ? mqReduce.matches : state.prefs.reduceMotion);

  /* ------------------------------------------------------------------ *
   *  Small helpers: toast, focus trap
   * ------------------------------------------------------------------ */
  let toastTimer = 0;
  function toast(msg, iconId) {
    const el = $('toast');
    if (!el) return;
    $('toastMsg').textContent = msg;
    const use = el.querySelector('use');
    if (use) use.setAttribute('href', '#' + (iconId || 'i-check'));
    el.classList.add('is-visible');
    global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(() => el.classList.remove('is-visible'), 3400);
  }

  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let lastFocus = null;
  function trapFocus(e, root) {
    if (e.key !== 'Tab') return;
    const items = Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), (n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }
  function openModal(el, focusEl) {
    lastFocus = document.activeElement;
    el.hidden = false;
    (focusEl || el.querySelector(FOCUSABLE) || el).focus({ preventScroll: true });
  }
  function closeModal(el) {
    el.hidden = true;
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
  const isOpen = (el) => el && !el.hidden;

  /* ------------------------------------------------------------------ *
   *  Opening sequence
   * ------------------------------------------------------------------ */
  const intro = { video: null, node: null, failed: false, playing: false };

  function setIntroProgress(p, msg) {
    const bar = document.querySelector('#introProgress span');
    if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
    if (msg) { const s = $('introStatus'); if (s) s.textContent = msg + '…'; }
  }

  function introStatic(reason) {
    if (intro.failed) return;
    intro.failed = true;
    if (intro.node) { intro.node.classList.add('is-static'); intro.node.classList.remove('is-playing'); }
    try { intro.video.pause(); } catch (_) { /* ignore */ }
    intro.video.removeAttribute('autoplay');
    if (global.console) console.info('[AYLA] intro video not playing (' + reason + '), showing the still frame');
  }

  function initIntro() {
    intro.video = $('introVideo');
    intro.node = $('gatewayHero');
    const v = intro.video;
    if (!v) return;

    const conn = navigator.connection || {};
    if (mqReduce.matches || conn.saveData) { introStatic(mqReduce.matches ? 'reduced motion' : 'data saver'); return; }

    v.muted = true; v.defaultMuted = true; v.playsInline = true;

    v.addEventListener('playing', () => { intro.playing = true; intro.node.classList.add('is-playing'); });
    v.addEventListener('error', () => introStatic('video error'));
    const sources = v.querySelectorAll('source');
    if (sources.length) sources[sources.length - 1].addEventListener('error', () => introStatic('no playable source'));

    // brief dip to dark at the seam, so the loop never shows a hard cut
    v.addEventListener('timeupdate', () => {
      if (!v.duration || !isFinite(v.duration)) return;
      const left = v.duration - v.currentTime;
      if (left < 0.55) intro.node.classList.add('is-looping');
      else if (v.currentTime > 0.35 && v.currentTime < 1.2) intro.node.classList.remove('is-looping');
    });

    const tryPlay = () => {
      const p = v.play();
      if (p && p.catch) p.catch(() => {
        // autoplay blocked (low-power mode, strict policy): keep the still and retry on the first gesture
        const retry = () => { v.play().catch(() => introStatic('autoplay blocked')); };
        ['pointerdown', 'touchstart', 'keydown'].forEach((t) => global.addEventListener(t, retry, { once: true, passive: true }));
      });
    };
    tryPlay();

    // if nothing is playing after a while, settle on the still frame
    global.setTimeout(() => { if (!intro.playing && !intro.failed && v.readyState < 3) introStatic('slow network'); }, 7000);
  }

  async function bootEngine() {
    if (state.booting || state.ready) return;
    state.booting = true;
    const params = new URLSearchParams(global.location.search);
    const mobile = !!(mqCoarse.matches || global.innerWidth < 760);
    const common = {
      stageExplorer: $('threeCanvasContainer'),
      stageSandbox: $('sandboxCanvasContainer'),
      catalog: CAT,
      quality: params.get('q') || undefined,
      hint: { mobile },
      reduced: reduced(),
      labels: state.prefs.labels,
      onProgress: setIntroProgress,
      onSelect: (key) => { if (state.entered && state.mode === 'explore') focusBody(key); },
      onSandboxChange: renderSandboxList
    };
    const Universe = global.AYLA_UNIVERSE;
    let ok = false;
    if (Universe && Universe.supported() && !params.has('nogl')) {
      try {
        await Universe.init(Object.assign({}, common, {
          canvas: $('universeCanvas'),
          labelsEl: $('labels'),
          onFatal: handleFatal
        }));
        state.engine = Universe;
        ok = true;
      } catch (err) {
        if (global.console) console.warn('[AYLA] 3D engine could not start, using the 2D map instead:', err);
      }
    }
    if (!ok) {
      try {
        await startFallback(common);
        $('introStatus').textContent = 'Light mode · 3D graphics unavailable';
      } catch (err) {
        if (global.console) console.error('[AYLA] fallback failed', err);
        $('introStatus').textContent = 'This device cannot display the universe';
        state.booting = false;
        return;
      }
    }
    state.ready = true;
    state.booting = false;
    onReady();
  }

  async function startFallback(common) {
    const FB = global.AYLA_FALLBACK;
    if (!FB) throw new Error('fallback missing');
    $('universeCanvas').hidden = true;
    $('fallbackCanvas').hidden = false;
    $('labels').hidden = true;
    await FB.init(Object.assign({}, common, { canvas: $('fallbackCanvas') }));
    state.engine = FB;
    state.usingFallback = true;
    document.body.classList.add('is-fallback');
  }

  async function handleFatal(reason) {
    // The GPU context was lost while running: continue on the 2D map
    if (state.usingFallback) return;
    if (global.console) console.warn('[AYLA] 3D context lost (' + reason + '), switching to the 2D map');
    try {
      await startFallback({
        stageExplorer: $('threeCanvasContainer'), stageSandbox: $('sandboxCanvasContainer'), catalog: CAT,
        reduced: reduced(), labels: state.prefs.labels, onSelect: (k) => { if (state.mode === 'explore') focusBody(k); }, onSandboxChange: renderSandboxList
      });
      state.engine.setMode(state.mode);
      state.engine.start();
      if (state.selected) state.engine.focusBody(state.selected);
      toast('3D graphics stopped on this device. Showing the simplified map.', 'i-overview');
    } catch (_) { /* nothing more to do */ }
  }

  function onReady() {
    const node = $('gatewayHero');
    const btn = $('enterUniverseBtn');
    setIntroProgress(1);
    if (!state.usingFallback) $('introStatus').textContent = 'The universe is ready';
    node.classList.add('is-ready');
    btn.setAttribute('aria-busy', 'false');
    if (state.enterRequested) enterUniverse();
  }

  function enterUniverse() {
    if (state.entered || state.entering) return;
    const btn = $('enterUniverseBtn');
    if (!state.ready) {
      // the visitor was quicker than the loading: remember the request and go in as soon as it is ready
      state.enterRequested = true;
      btn.setAttribute('aria-busy', 'true');
      if (!state.booting) bootEngine();
      return;
    }
    state.entering = true;
    state.enterRequested = false;
    btn.disabled = true;

    const E = state.engine;
    const quick = reduced();
    E.setMode('explore');
    E.start();
    E.overview();

    document.body.classList.add('is-entered');
    $('gatewayHero').classList.add('is-leaving');
    $('mainNav').classList.remove('is-hidden');
    showSection('explore');
    setNav('explore');
    state.mode = 'explore';
    document.body.dataset.mode = 'explore';
    updateViewShift();

    const done = () => {
      $('gatewayHero').classList.add('is-gone');
      document.body.classList.remove('is-intro');
      try { intro.video.pause(); } catch (_) { /* ignore */ }
      state.entered = true;
      state.entering = false;
      if (state.usingFallback) toast('3D graphics are unavailable here, so this is a simplified orbital map.', 'i-overview');
      if (!state.prefs.onboardingDone) openModal($('onboardingModal'), $('startExplorationBtn'));
      else { const m = $('main'); if (m) m.focus({ preventScroll: true }); }
    };
    global.setTimeout(done, quick ? 250 : 2300);
  }

  /* Keeps the subject of the view clear of whichever panel is open: a lens shift in the engine */
  function updateViewShift() {
    const E = state.engine;
    if (!E || !E.setViewShift) return;
    const W = global.innerWidth, H = global.innerHeight, wide = W >= 900;
    let x = 0, y = 0;
    if (state.mode === 'explore' && state.selected) {
      const p = $('inspectorPanel');
      if (wide) x = ((260 + p.offsetLeft) / 2 - W / 2) / (W / 2);
      else y = -(((64 + p.offsetTop) / 2) - H / 2) / (H / 2);
    } else if (state.mode === 'create') {
      const lab = $('labPanel');
      if (wide) x = (lab.offsetLeft + lab.offsetWidth) / W;
      else y = -(((64 + lab.offsetTop) / 2) - H / 2) / (H / 2);
    }
    E.setViewShift(Math.max(-0.6, Math.min(0.6, x)), Math.max(-0.1, Math.min(0.7, y)));
  }

  /* ------------------------------------------------------------------ *
   *  Navigation
   * ------------------------------------------------------------------ */
  function showSection(mode) {
    MODES.forEach((m) => { const el = $(MODE_SECTION[m]); if (el) el.hidden = m !== mode; });
  }
  function setNav(mode) {
    MODES.forEach((m) => {
      const b = $('btn-nav-' + m);
      if (!b) return;
      if (m === mode) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  function switchMode(mode) {
    if (MODES.indexOf(mode) === -1) return;
    if (!state.entered && !state.entering) return;
    if (mode === state.mode) { if (mode === 'explore' && state.selected) closeInspector(); return; }
    if (state.mode === 'explore') hideInspectorPanel();
    state.mode = mode;
    document.body.dataset.mode = mode;
    showSection(mode);
    setNav(mode);
    if (state.engine) state.engine.setMode(mode);
    if (mode === 'discoveries') renderLog();
    if (mode === 'ask') {
      const log = $('chatWindow');
      log.scrollTop = log.scrollHeight;
      if (!mqCoarse.matches) global.setTimeout(() => $('chatInput').focus({ preventScroll: true }), 60);
    }
    if (mode === 'create' && state.engine) state.engine.sandbox.overview();
    updateViewShift();
  }

  /* ------------------------------------------------------------------ *
   *  Explore: body list and inspector
   * ------------------------------------------------------------------ */
  function renderBodyList() {
    const ul = $('bodyList');
    ul.textContent = '';
    BODY_KEYS.forEach((key) => {
      const d = CAT[key];
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'body-btn';
      b.dataset.key = key;
      b.setAttribute('aria-pressed', 'false');
      b.style.setProperty('--dot', d.css);
      const dot = document.createElement('span'); dot.className = 'body-btn__dot'; dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.textContent = d.name;
      b.append(dot, name);
      if (d.rare) { const r = document.createElement('span'); r.className = 'body-btn__rare'; r.textContent = 'RARE'; b.append(r); }
      b.addEventListener('click', () => focusBody(key));
      li.append(b);
      ul.append(li);
    });
  }

  function paintDiscoveryButton() {
    const btn = $('addDiscoveryBtn');
    if (!btn) return;
    const logged = !!(state.selected && state.discoveries[state.selected]);
    btn.disabled = logged || !state.selected;
    $('addDiscoveryIcon').setAttribute('href', logged ? '#i-check' : '#i-bookmark');
    $('addDiscoveryLabel').textContent = logged ? 'In your discoveries log' : 'Add to discoveries log';
  }

  function focusBody(key) {
    const d = CAT[key];
    if (!d) return;
    if (state.mode !== 'explore') switchMode('explore');
    state.selected = key;
    if (state.engine) state.engine.focusBody(key);

    $('inspectType').textContent = d.type;
    $('inspectName').textContent = d.name;
    $('inspectFiction').hidden = !d.fictional;
    $('inspectDiameter').textContent = d.diameter;
    $('inspectTemp').textContent = d.temp;
    $('inspectOrbit').textContent = d.orbit;
    $('inspectComposition').textContent = d.composition;
    $('inspectDesc').textContent = d.desc;
    $('inspectTrivia').textContent = d.trivia;
    const panel = $('inspectorPanel');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    $('modeExplorer').classList.add('has-inspector');
    document.querySelectorAll('.body-btn').forEach((b) => b.setAttribute('aria-pressed', b.dataset.key === key ? 'true' : 'false'));
    paintDiscoveryButton();
    updateViewShift();
  }

  function hideInspectorPanel() {
    const panel = $('inspectorPanel');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    $('modeExplorer').classList.remove('has-inspector');
    document.querySelectorAll('.body-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    state.selected = null;
    updateViewShift();
  }

  function closeInspector() {
    hideInspectorPanel();
    if (state.engine && state.mode === 'explore') state.engine.overview();
  }

  function logCurrentDiscovery() {
    const key = state.selected;
    if (!key || state.discoveries[key]) return;
    const before = unlockedIds();
    state.discoveries[key] = new Date().toISOString();
    saveStore();
    paintDiscoveryButton();
    renderLog();
    const gained = unlockedIds().filter((id) => before.indexOf(id) === -1);
    if (gained.length) {
      const badge = DATA.BADGES.find((b) => b.id === gained[gained.length - 1]);
      toast('Badge unlocked: ' + badge.name, 'i-check');
    } else {
      toast(CAT[key].name + ' added to your log', 'i-check');
    }
  }

  /* ------------------------------------------------------------------ *
   *  Discoveries log
   * ------------------------------------------------------------------ */
  function unlockedIds() {
    const set = new Set(Object.keys(state.discoveries));
    return DATA.BADGES.filter((b) => b.test(set, BODY_KEYS.length)).map((b) => b.id);
  }

  function renderLog() {
    const keys = Object.keys(state.discoveries).sort((a, b) => String(state.discoveries[a]).localeCompare(String(state.discoveries[b])));
    const total = BODY_KEYS.length;
    const pct = Math.round((keys.length / total) * 100);
    $('discoveryProgressText').textContent = keys.length + ' / ' + total + ' (' + pct + '%)';
    $('discoveryProgressBar').style.width = pct + '%';

    const unlocked = unlockedIds();
    DATA.BADGES.forEach((b) => {
      const li = $('badge-' + b.id);
      if (!li) return;
      const on = unlocked.indexOf(b.id) !== -1;
      li.classList.toggle('is-unlocked', on);
      li.setAttribute('aria-label', b.name + ', ' + b.rule + (on ? ', unlocked' : ', locked'));
    });

    const grid = $('logEntriesGrid');
    grid.querySelectorAll('.entry').forEach((n) => n.remove());
    $('emptyLogNotice').hidden = keys.length > 0;
    keys.forEach((key) => {
      const d = CAT[key];
      const art = document.createElement('article');
      art.className = 'entry';
      const h = document.createElement('h3'); h.className = 'entry__name'; h.textContent = d.name;
      const meta = document.createElement('p'); meta.className = 'eyebrow';
      let when = '';
      try { when = new Date(state.discoveries[key]).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { when = ''; }
      meta.textContent = d.type + (d.fictional ? ' · fictional' : '') + (when ? ' · ' + when : '');
      const desc = document.createElement('p'); desc.textContent = d.desc;
      const tri = document.createElement('p'); tri.className = 'entry__trivia'; tri.textContent = d.trivia;
      art.append(h, meta, desc, tri);
      grid.append(art);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Ask AYLA (pre-written notes, matched by keywords; not a live AI)
   * ------------------------------------------------------------------ */
  const norm = (s) => ' ' + String(s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

  function answerFor(text) {
    const t = norm(text);
    let best = null, bestScore = 0;
    DATA.KNOWLEDGE.forEach((entry) => {
      entry.keys.forEach((k) => {
        const nk = norm(k);
        if (t.indexOf(nk) !== -1) {
          const words = nk.trim().split(' ').length;
          const score = words * 10 + nk.trim().length;
          if (score > bestScore) { bestScore = score; best = entry; }
        }
      });
    });
    return best ? best.answer : DATA.FALLBACK_ANSWER;
  }

  function addMessage(who, text, extraClass) {
    const log = $('chatWindow');
    const art = document.createElement('article');
    art.className = 'msg msg--' + who + (extraClass ? ' ' + extraClass : '');
    const w = document.createElement('p'); w.className = 'msg__who'; w.textContent = who === 'you' ? 'You' : 'AYLA';
    const p = document.createElement('p'); p.className = 'msg__text';
    if (text) p.textContent = text;
    art.append(w, p);
    log.append(art);
    while (log.querySelectorAll('.msg').length > 60) log.querySelector('.msg').remove();
    log.scrollTop = log.scrollHeight;
    return art;
  }
const WORKER_URL = 'https://ayla-backend.ayla-olvmoraes.workers.dev';
let chatHistory = [];
  async function askQuestion(text) {
  addMessage('you', text);
  const typing = addMessage('ayla', '', 'msg--typing');
  typing.setAttribute('aria-hidden', 'true');
  const tp = typing.querySelector('.msg__text');
  for (let i = 0; i < 3; i++) { const s = document.createElement('span'); s.textContent = '.'; tp.append(s); }

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: text,
        history: chatHistory
      })
    });

    const data = await res.json();
    typing.remove();

    if (res.ok && data.response) {
      addMessage('ayla', data.response);
      chatHistory.push({ role: 'user', text: text });
      chatHistory.push({ role: 'model', text: data.response });
    } else {
      addMessage('ayla', 'Desculpe, tive um pequeno problema ao conectar com as estrelas. Tente novamente em instantes!');
    }
  } catch (err) {
    typing.remove();
    addMessage('ayla', 'Não foi possível se conectar ao universo de dados. Verifique sua conexão!');
  }
}

  function handleChatSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    askQuestion(text);
  }

  function renderChips() {
    const wrap = $('chatChips');
    wrap.textContent = '';
    DATA.SUGGESTIONS.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = s.label;
      b.addEventListener('click', () => askQuestion(s.prompt));
      wrap.append(b);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Creator Lab
   * ------------------------------------------------------------------ */
  function bindRange(id, fmt) {
    const el = $(id), out = $(id + 'Out');
    if (!el || !out) return;
    const paint = () => { out.textContent = fmt(el.value); };
    el.addEventListener('input', paint);
    paint();
  }

  function setLabTab(tab) {
    const world = tab !== 'galaxy';
    $('tab-world').setAttribute('aria-selected', world ? 'true' : 'false');
    $('tab-galaxy').setAttribute('aria-selected', world ? 'false' : 'true');
    $('tab-world').tabIndex = world ? 0 : -1;
    $('tab-galaxy').tabIndex = world ? -1 : 0;
    $('panel-world').hidden = !world;
    $('panel-galaxy').hidden = world;
  }

  function toggleLab() {
    const lab = $('labPanel');
    const collapsed = lab.classList.toggle('is-collapsed');
    const btn = $('labToggle');
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('aria-label', collapsed ? 'Expand the lab' : 'Collapse the lab');
    updateViewShift();
  }

  function counts() {
    const w = state.sandboxItems.filter((i) => i.kind === 'world').length;
    return { worlds: w, galaxies: state.sandboxItems.length - w };
  }

  function addCustomPlanet() {
    const E = state.engine;
    if (!E) return;
    if (counts().worlds >= LIMITS.worlds) { toast('That is plenty of worlds. Remove one to add another.', 'i-overview'); return; }
    const name = ($('createName').value || '').trim() || 'Unnamed world';
    const res = E.sandbox.addPlanet({
      name, type: $('createType').value,
      radius: parseFloat($('createRadius').value), dist: parseFloat($('createDistance').value),
      speed: parseFloat($('createSpeed').value), color: $('createColor').value
    });
    if (res && res.id) E.sandbox.focus(res.id);
    if (res && res.adjusted) toast(res.name + ' was placed at ' + res.dist.toFixed(1) + ' so it clears the star', 'i-orbit');
    else toast(name + ' has formed', 'i-check');
  }

  function addCustomGalaxy() {
    const E = state.engine;
    if (!E) return;
    if (counts().galaxies >= LIMITS.galaxies) { toast('The sky is full of galaxies. Remove one to add another.', 'i-overview'); return; }
    const name = ($('galaxyName').value || '').trim() || 'Unnamed galaxy';
    E.sandbox.addGalaxy({
      name, arms: parseInt($('galaxyArms').value, 10), size: parseFloat($('galaxySize').value),
      tilt: parseFloat($('galaxyTilt').value), color: $('galaxyColor').value
    });
    toast(name + ' has formed', 'i-galaxy');
  }

  function renderSandboxList(items) {
    state.sandboxItems = items || [];
    const ul = $('customPlanetList');
    if (!ul) return;
    ul.textContent = '';
    if (!state.sandboxItems.length) {
      const li = document.createElement('li'); li.className = 'empty';
      li.textContent = 'Nothing orbiting yet. Form a world to begin.';
      ul.append(li);
      return;
    }
    state.sandboxItems.forEach((it) => {
      const li = document.createElement('li');
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.setAttribute('aria-hidden', 'true'); sw.style.setProperty('--dot', it.color || '#8fe6f5');
      const nameBtn = document.createElement('button'); nameBtn.type = 'button'; nameBtn.className = 'name-btn';
      nameBtn.setAttribute('aria-label', 'Look at ' + it.name);
      const n = document.createElement('span'); n.className = 'name'; n.textContent = it.name;
      const k = document.createElement('span'); k.className = 'kind'; k.textContent = it.kind === 'galaxy' ? 'galaxy' : it.type;
      nameBtn.append(n, k);
      nameBtn.addEventListener('click', () => { if (state.engine) state.engine.sandbox.focus(it.id); });
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'icon-btn'; rm.setAttribute('aria-label', 'Remove ' + it.name);
      rm.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>';
      rm.addEventListener('click', () => { if (state.engine) state.engine.sandbox.remove(it.id); });
      li.append(sw, nameBtn, rm);
      ul.append(li);
    });
  }

  function toggleSandboxPause() {
    state.sandboxPaused = !state.sandboxPaused;
    if (state.engine) state.engine.sandbox.setPaused(state.sandboxPaused);
    $('pauseSandboxIcon').setAttribute('href', state.sandboxPaused ? '#i-play' : '#i-pause');
    $('pauseSandboxLabel').textContent = state.sandboxPaused ? 'Resume' : 'Pause';
  }
  function resetSandbox() {
    if (!state.engine) return;
    state.engine.sandbox.reset();
    toast('System cleared. Form a world to begin.', 'i-reset');
  }
  function toggleSandboxOrbits() {
    state.sandboxOrbits = !state.sandboxOrbits;
    if (state.engine) state.engine.sandbox.setOrbits(state.sandboxOrbits);
    $('orbitToggleBtn').setAttribute('aria-pressed', state.sandboxOrbits ? 'true' : 'false');
  }

  /* ------------------------------------------------------------------ *
   *  Settings
   * ------------------------------------------------------------------ */
  function syncSettingsUI() {
    $('reduceMotionToggle').checked = reduced();
    $('labelsToggle').checked = state.prefs.labels;
    syncSoundUI();
    disarmReset();
  }
  function openSettingsModal() { syncSettingsUI(); openModal($('settingsModal')); }
  function closeSettingsModal() { closeModal($('settingsModal')); disarmReset(); }

  function applyMotionPref() {
    const r = reduced();
    document.body.classList.toggle('reduce-motion', r);
    if (state.engine) state.engine.setReducedMotion(r);
  }
  function toggleReducedMotion() {
    state.prefs.reduceMotion = $('reduceMotionToggle').checked;
    applyMotionPref();
    saveStore();
  }
  function toggleLabels() {
    state.prefs.labels = $('labelsToggle').checked;
    if (state.engine) state.engine.setLabels(state.prefs.labels);
    saveStore();
  }

  function disarmReset() {
    state.resetArmed = false;
    const btn = document.querySelector('.settings__row--danger .btn--danger');
    if (btn) btn.textContent = 'Clear data';
  }
  function resetAllData() {
    const btn = document.querySelector('.settings__row--danger .btn--danger');
    if (!state.resetArmed) {
      state.resetArmed = true;
      if (btn) btn.textContent = 'Press again to confirm';
      global.setTimeout(() => { if (state.resetArmed) disarmReset(); }, 4000);
      return;
    }
    clearStore();
    state.discoveries = {};
    state.prefs = { reduceMotion: null, labels: true, onboardingDone: false };
    if (state.engine) state.engine.setLabels(true);
    applyMotionPref();
    syncSettingsUI();
    renderLog();
    paintDiscoveryButton();
    toast('Saved data cleared', 'i-check');
  }

  /* ------------------------------------------------------------------ *
   *  Welcome dialog
   * ------------------------------------------------------------------ */
  function dismissOnboarding(never) {
    if (never) { state.prefs.onboardingDone = true; saveStore(); }
    closeModal($('onboardingModal'));
    const m = $('main'); if (m) m.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ *
   *  Ambient audio: synthesised in the browser, nothing is downloaded
   * ------------------------------------------------------------------ */
  const audio = { ctx: null, master: null, nodes: [], on: false };

  function buildAudio() {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC();
    const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.6; lp.connect(master);

    // slow filter movement
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 190;
    lfo.connect(lfoGain); lfoGain.connect(lp.frequency); lfo.start();

    // a low chord of detuned voices
    [[55.0, 0.30, 'sine'], [82.41, 0.20, 'sine'], [110.3, 0.14, 'triangle'], [164.9, 0.07, 'sine'], [220.4, 0.04, 'sine']].forEach((v, i) => {
      const o = ctx.createOscillator(); o.type = v[2]; o.frequency.value = v[0]; o.detune.value = (i % 2 ? 1 : -1) * (3 + i * 2);
      const g = ctx.createGain(); g.gain.value = v[1];
      const trem = ctx.createOscillator(); trem.frequency.value = 0.05 + i * 0.019;
      const tg = ctx.createGain(); tg.gain.value = v[1] * 0.45;
      trem.connect(tg); tg.connect(g.gain); trem.start();
      o.connect(g); g.connect(lp); o.start();
      audio.nodes.push(o, trem);
    });

    // a faint bed of filtered noise, like distant air
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const ng = ctx.createGain(); ng.gain.value = 0.18;
    src.connect(ng); ng.connect(lp); src.start();
    audio.nodes.push(lfo, src);

    audio.ctx = ctx; audio.master = master;
    return true;
  }

  function setAudio(on) {
    if (on) {
      if (!audio.ctx && !buildAudio()) { toast('Audio is not supported in this browser', 'i-sound-off'); state.sound = false; syncSoundUI(); return; }
      audio.ctx.resume().catch(() => {});
      const t = audio.ctx.currentTime;
      audio.master.gain.cancelScheduledValues(t);
      audio.master.gain.setValueAtTime(audio.master.gain.value, t);
      audio.master.gain.linearRampToValueAtTime(0.2, t + 3);
    } else if (audio.ctx) {
      const t = audio.ctx.currentTime;
      audio.master.gain.cancelScheduledValues(t);
      audio.master.gain.setValueAtTime(audio.master.gain.value, t);
      audio.master.gain.linearRampToValueAtTime(0, t + 1.1);
      global.setTimeout(() => { if (!state.sound && audio.ctx) audio.ctx.suspend().catch(() => {}); }, 1300);
    }
  }

  function syncSoundUI() {
    const btn = $('soundToggleBtn');
    if (btn) {
      btn.setAttribute('aria-pressed', state.sound ? 'true' : 'false');
      btn.setAttribute('aria-label', state.sound ? 'Turn ambient sound off' : 'Turn ambient sound on');
    }
    const ic = $('soundIcon'); if (ic) ic.setAttribute('href', state.sound ? '#i-sound-on' : '#i-sound-off');
    const cb = $('modalSoundBtn'); if (cb) cb.checked = state.sound;
  }

  function toggleAudio() {
    state.sound = !state.sound;
    setAudio(state.sound);
    syncSoundUI();
  }

  document.addEventListener('visibilitychange', () => {
    if (!audio.ctx || !state.sound) return;
    if (document.hidden) audio.ctx.suspend().catch(() => {}); else audio.ctx.resume().catch(() => {});
  });

  /* ------------------------------------------------------------------ *
   *  Meteor shower (a short overlay on the 2D canvas above the scene)
   * ------------------------------------------------------------------ */
  let meteorBusy = false;
  function triggerMeteorShower() {
    if (meteorBusy) return;
    const cv = $('meteorCanvas');
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    meteorBusy = true;
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    const W = global.innerWidth, H = global.innerHeight;
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv.hidden = false;

    const calm = reduced();
    const n = calm ? 5 : 18;
    const streaks = [];
    for (let i = 0; i < n; i++) {
      const a = 0.95 + Math.random() * 0.3;                           // heading down and to the left
      streaks.push({
        x: Math.random() * W * 1.3, y: -40 - Math.random() * H * 0.35,
        dx: -Math.cos(a), dy: Math.sin(a),
        speed: (calm ? 260 : 620) + Math.random() * (calm ? 120 : 520),
        len: 110 + Math.random() * 190, width: 1 + Math.random() * 1.3,
        delay: Math.random() * (calm ? 2.4 : 3.2), hue: Math.random() < 0.7 ? '235,240,255' : '170,230,245'
      });
    }

    const t0 = performance.now();
    const total = calm ? 5200 : 6200;
    (function tick(now) {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      streaks.forEach((s) => {
        const life = t - s.delay;
        if (life < 0) return;
        const hx = s.x + s.dx * s.speed * life, hy = s.y + s.dy * s.speed * life;
        if (hy - s.len > H || hx + s.len < 0) return;
        const tx = hx - s.dx * s.len, ty = hy - s.dy * s.len;
        const g = ctx.createLinearGradient(tx, ty, hx, hy);
        g.addColorStop(0, 'rgba(' + s.hue + ',0)');
        g.addColorStop(0.75, 'rgba(' + s.hue + ',0.35)');
        g.addColorStop(1, 'rgba(255,255,255,0.95)');
        ctx.strokeStyle = g; ctx.lineWidth = s.width; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
      });
      if (now - t0 < total) global.requestAnimationFrame(tick);
      else { ctx.clearRect(0, 0, W, H); cv.hidden = true; meteorBusy = false; }
    })(t0);
  }

  /* ------------------------------------------------------------------ *
   *  Global keys
   * ------------------------------------------------------------------ */
  document.addEventListener('keydown', (e) => {
    const settings = $('settingsModal'), welcome = $('onboardingModal');
    if (e.key === 'Escape') {
      if (isOpen(settings)) { closeSettingsModal(); e.preventDefault(); }
      else if (isOpen(welcome)) { dismissOnboarding(false); e.preventDefault(); }
      else if (state.mode === 'explore' && state.selected) { closeInspector(); e.preventDefault(); }
      return;
    }
    if (isOpen(settings)) trapFocus(e, settings);
    else if (isOpen(welcome)) trapFocus(e, welcome);
  });

  function bindModalBackdrop(id, close) {
    const el = $(id);
    el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  }

  /* ------------------------------------------------------------------ *
   *  Boot
   * ------------------------------------------------------------------ */
  function init() {
    loadStore();
    applyMotionPref();
    renderBodyList();
    renderChips();
    renderLog();
    renderSandboxList([]);
    syncSettingsUI();
    paintDiscoveryButton();

    bindRange('createRadius', (v) => parseFloat(v).toFixed(1));
    bindRange('createDistance', (v) => String(parseFloat(v)));
    bindRange('createSpeed', (v) => parseFloat(v).toFixed(1));
    bindRange('galaxyArms', (v) => v);
    bindRange('galaxySize', (v) => v);
    bindRange('galaxyTilt', (v) => v + '°');

    // arrow keys move between the two lab tabs
    $('tab-world').parentNode.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const toGalaxy = e.key === 'ArrowRight' || e.key === 'End';
      setLabTab(toGalaxy ? 'galaxy' : 'world');
      $(toGalaxy ? 'tab-galaxy' : 'tab-world').focus();
    });

    bindModalBackdrop('settingsModal', closeSettingsModal);
    let rz = 0;
    global.addEventListener('resize', () => { global.clearTimeout(rz); rz = global.setTimeout(updateViewShift, 120); });
    $('enterUniverseBtn').setAttribute('aria-busy', 'true');
    initIntro();

    // let the video and poster take the first bandwidth, then build the universe
    const start = () => global.setTimeout(bootEngine, 350);
    if (document.readyState === 'complete') start(); else global.addEventListener('load', start, { once: true });
  }

  // handlers used by the markup
  Object.assign(global, {
    enterUniverse, switchMode, toggleAudio, openSettingsModal, closeSettingsModal, closeInspector,
    triggerMeteorShower, logCurrentDiscovery, handleChatSubmit, toggleLab, setLabTab, addCustomPlanet,
    addCustomGalaxy, toggleSandboxPause, resetSandbox, toggleSandboxOrbits, dismissOnboarding,
    toggleReducedMotion, toggleLabels, resetAllData, focusBody
  });

  init();
})(window);
