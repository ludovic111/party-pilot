/* Party Pilot for PopSauce, page world. Known challenges are answered from a learned database; new ones go to Claude. */
(() => {
  'use strict';
  if (!location.pathname.startsWith('/games/popsauce')) return;
  globalThis.__psBot?.stop();

  const DEFAULTS = {enabled: true, ai: true, delayMs: 0, collapsed: false, x: 12, y: 12};
  let settings = {...DEFAULTS}, db = {}, client = null, stopped = false, timer = null;
  let current = null; // {key, prompt, startedAt, tried:Set, source}
  let note = 'Connexion au jeu…', last = null, askId = 0;
  const listeners = [], pendingAsks = new Map();
  const toBridge = data => document.dispatchEvent(new CustomEvent('psbot:req', {detail: JSON.stringify(data)}));
  const game = () => { try { return {m: milestone, me: selfPeerId, rules, socket}; } catch { return null; } };
  const LANGS = {en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', 'pt-br': 'Brazilian Portuguese', pt: 'Portuguese'};

  async function challengeKey(c) {
    const head = new TextEncoder().encode(`${c.prompt}\n${c.text ?? ''}\n`);
    const body = c.image?.data ? new Uint8Array(c.image.data) : new Uint8Array(0);
    const all = new Uint8Array(head.length + body.length);
    all.set(head); all.set(body, head.length);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
    return [...hash.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const joined = g => g?.m?.name === 'round' && g.m.playerStatesByPeerId?.[g.me] != null;
  const found = g => g?.m?.playerStatesByPeerId?.[g.me]?.hasFoundSource;

  function guess(answer, source) {
    const g = game();
    if (!current || !answer || !joined(g) || found(g) || current.tried.has(answer.toLowerCase())) return false;
    current.tried.add(answer.toLowerCase());
    const send = () => {
      if (!current || found(game())) return;
      client.emit('submitGuess', answer);
      last = {answer, source, ms: performance.now() - current.startedAt, ok: null};
      current.lastGuess = last;
      scheduleRender();
    };
    if (settings.delayMs > 0) setTimeout(send, settings.delayMs); else send();
    return true;
  }

  async function onChallenge(challenge) {
    const startedAt = performance.now();
    current = {startedAt, tried: new Set(), key: null, prompt: challenge.prompt};
    const mine = current;
    mine.key = await challengeKey(challenge);
    if (current !== mine || stopped || !settings.enabled) return;
    const known = db[mine.key];
    if (known) {
      note = 'Réponse connue (base)';
      if (guess(known, 'base')) toBridge({type: 'stats', fromDb: 1});
      return;
    }
    if (!settings.ai) { note = 'Question inconnue, IA désactivée'; return scheduleRender(); }
    note = 'Question inconnue → Claude…'; scheduleRender();
    const answers = await askClaude(challenge);
    if (current !== mine) return;
    if (!answers.length) return scheduleRender();
    note = `Claude : ${answers.join(' · ')}`;
    // Fire the first guess now; the others go out only if the server says the first was wrong.
    mine.queue = answers;
    if (guess(mine.queue.shift(), 'IA')) toBridge({type: 'stats', fromAi: 1});
    scheduleRender();
  }

  function askClaude(c) {
    const lang = LANGS[normalizeLang(game()?.rules?.dictionaryId?.value)] || 'the language of the question';
    const content = [];
    if (c.image?.data) content.push({type: 'image', source: {type: 'base64', media_type: c.image.type || 'image/png', data: toBase64(c.image.data)}});
    content.push({type: 'text', text: `${c.prompt}${c.text ? `\n\n${c.text}` : ''}`});
    const system = `You play PopSauce, a fast trivia game. Answer the question (and image if any). Reply ONLY with a JSON array of up to 3 guesses, most likely first, each as short as the game accepts (just the name or answer, no explanation). Use ${lang} names when they differ.`;
    const id = ++askId;
    toBridge({type: 'ask', id, system, content});
    // maxTokens is set by the bridge (200): a JSON list of three names fits easily.
    return new Promise(resolve => {
      const t = setTimeout(() => { pendingAsks.delete(id); note = 'Claude : délai dépassé'; resolve([]); }, 15000);
      pendingAsks.set(id, msg => {
        clearTimeout(t);
        if (!msg.ok) { note = `Claude : ${msg.error}`; return resolve([]); }
        try {
          const list = JSON.parse(msg.text.slice(msg.text.indexOf('['), msg.text.lastIndexOf(']') + 1));
          resolve(list.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 3));
        } catch { resolve(msg.text ? [msg.text.split('\n')[0].slice(0, 60)] : []); }
      });
    });
  }
  const normalizeLang = v => String(v || '').toLowerCase();
  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function attach(g) {
    client = g.socket;
    const on = (name, fn) => { client.on(name, fn); listeners.push([name, fn]); };
    on('startChallenge', challenge => { void onChallenge(challenge); });
    on('setPlayerState', (peerId, state) => {
      if (peerId !== game()?.me || !current) return;
      if (state.hasFoundSource) {
        if (current.lastGuess) current.lastGuess.ok = true;
        note = 'Trouvé !'; toBridge({type: 'stats', found: 1});
      } else {
        if (current.lastGuess) current.lastGuess.ok = false;
        const next = current.queue?.shift();
        if (next) guess(next, 'IA'); else note = 'Raté, à toi de jouer';
      }
      scheduleRender();
    });
    on('endChallenge', result => {
      const done = current;
      current = null;
      if (done?.key && result?.source) {
        const isNew = db[done.key] !== result.source;
        db[done.key] = result.source;
        if (isNew) { toBridge({type: 'learn', key: done.key, answer: result.source}); toBridge({type: 'stats', learned: 1}); }
      }
      last = last && {...last, truth: result?.source};
      scheduleRender();
    });
    // Joined mid-challenge: play the one on screen.
    if (g.m?.challenge) void onChallenge(g.m.challenge);
  }

  function tick() {
    if (stopped) return;
    const g = game();
    if (g?.socket && !client) attach(g);
    if (!g?.m || g.m.name !== 'round') note = client ? 'En attente de la partie' : note;
    scheduleRender();
  }

  // ── Panel ─────────────────────────────────────────────────────────────────
  const LOGO = `<svg aria-hidden="true" viewBox="0 0 128 128"><defs><linearGradient id="psbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a3c"/><stop offset=".55" stop-color="#ff3d77"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient><radialGradient id="psbubble" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#2c3352"/><stop offset="1" stop-color="#121522"/></radialGradient></defs><rect width="128" height="128" rx="30" fill="url(#psbg)"/><path d="M30 30h68a14 14 0 0 1 14 14v36a14 14 0 0 1-14 14H62l-20 16v-16H30a14 14 0 0 1-14-14V44a14 14 0 0 1 14-14z" fill="url(#psbubble)"/><path d="M70 38 50 68h14l-6 22 22-32H66l4-20z" fill="#ffd34d"/><path d="M104 10l3 7.5 7.5 3-7.5 3-3 7.5-3-7.5-7.5-3 7.5-3z" fill="#fff6c2"/></svg>`;
  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;margin:0;font-family:Inter,"Segoe UI",system-ui,sans-serif}
    .card{position:fixed;width:280px;color:#e8ecf6;background:rgba(16,19,31,.88);backdrop-filter:blur(14px) saturate(140%);
      border:1px solid rgba(255,255,255,.09);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.45);overflow:hidden;
      font-size:12px;line-height:1.4;user-select:none;z-index:2147483647}
    header{display:flex;align-items:center;gap:9px;padding:10px 12px;cursor:grab;background:linear-gradient(90deg,rgba(255,154,60,.16),rgba(255,61,119,.12))}
    header svg{width:26px;height:26px;flex:none;border-radius:7px}
    .title{font-weight:700;font-size:13px;flex:1}
    .title small{display:block;font-weight:500;font-size:10.5px;color:#9aa3bd}
    .pill{font-size:10px;font-weight:700;letter-spacing:.6px;padding:3px 8px;border-radius:99px;background:#2b3146;color:#9aa3bd}
    .pill.on{background:rgba(52,211,153,.16);color:#34d399}
    .icon{border:0;background:rgba(255,255,255,.06);color:#c9d0e3;width:24px;height:24px;border-radius:7px;cursor:pointer}
    .body{padding:12px;display:grid;gap:10px}
    .collapsed .body{display:none}
    .hero{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px 12px}
    .answer{font-size:18px;font-weight:800;color:#fff;word-break:break-word}
    .answer.bad{color:#f87171;text-decoration:line-through}
    .answer.good{color:#34d399}
    .meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:4px;color:#9aa3bd;font-variant-numeric:tabular-nums}
    .meta b{color:#e8ecf6}
    .note{color:#9aa3bd;font-size:11px;min-height:15px}
    .row{display:flex;justify-content:space-between;align-items:center;color:#9aa3bd}
    .switch{border:0;border-radius:99px;padding:4px 10px;font-weight:700;font-size:11px;cursor:pointer;background:#2b3146;color:#9aa3bd}
    .switch.on{background:linear-gradient(90deg,#ff9a3c,#ff3d77);color:#fff}
    label{display:grid;gap:4px;color:#9aa3bd}
    label span{display:flex;justify-content:space-between}
    label b{color:#e8ecf6}
    input[type=range]{width:100%;accent-color:#ff6a5a}
    .toggle{border:0;border-radius:10px;padding:9px;font-weight:700;font-size:12px;cursor:pointer;color:#141826;background:#34d399}
    .toggle.off{background:#2b3146;color:#e8ecf6}
    .hint{text-align:center;color:#5d6684;font-size:10px}`;
  let host, root, els = {}, renderQueued = false;
  function build() {
    host = document.createElement('div');
    root = host.attachShadow({mode: 'closed'});
    root.innerHTML = `<style>${CSS}</style><div class="card">
      <header>${LOGO}<div class="title">Party Pilot<small>PopSauce · mémoire + Claude</small></div><span class="pill"></span><button class="icon collapse">–</button></header>
      <div class="body">
        <div class="hero"><div class="answer">—</div><div class="meta"></div></div>
        <div class="note"></div>
        <div class="row"><span class="dbsize"></span><button class="switch ai">IA Claude</button></div>
        <label><span>Délai avant réponse <b class="delayVal"></b></span><input type="range" min="0" max="5000" step="50" name="delayMs"></label>
        <button class="toggle"></button>
        <div class="hint">Alt+W : pause · usage éducatif uniquement</div>
      </div></div>`;
    for (const k of ['card', 'pill', 'collapse', 'answer', 'meta', 'note', 'dbsize', 'ai', 'delayVal', 'toggle']) els[k] = root.querySelector('.' + k);
    els.range = root.querySelector('input[type=range]');
    els.toggle.addEventListener('click', () => setSettings({enabled: !settings.enabled}));
    els.collapse.addEventListener('click', () => setSettings({collapsed: !settings.collapsed}));
    els.ai.addEventListener('click', () => setSettings({ai: !settings.ai}));
    els.range.addEventListener('input', () => { settings.delayMs = Number(els.range.value); render(); });
    els.range.addEventListener('change', () => setSettings({delayMs: Number(els.range.value)}));
    root.querySelector('header').addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const dx = e.clientX - settings.x, dy = e.clientY - settings.y;
      const move = ev => {
        settings.x = Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx));
        settings.y = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy));
        els.card.style.left = settings.x + 'px'; els.card.style.top = settings.y + 'px';
      };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); setSettings({x: settings.x, y: settings.y}); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    document.body.append(host);
  }
  function setSettings(patch) { settings = {...settings, ...patch}; toBridge({type: 'settings', settings: patch}); render(); }
  function scheduleRender() {
    if (renderQueued || stopped) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function render() {
    if (stopped || !document.body) return;
    if (!host) build();
    els.card.style.left = settings.x + 'px'; els.card.style.top = settings.y + 'px';
    els.card.classList.toggle('collapsed', !!settings.collapsed);
    els.collapse.textContent = settings.collapsed ? '+' : '–';
    els.pill.textContent = settings.enabled ? 'ACTIF' : 'PAUSE';
    els.pill.classList.toggle('on', settings.enabled);
    if (last) {
      els.answer.textContent = last.answer;
      els.answer.className = 'answer' + (last.ok === true ? ' good' : last.ok === false ? ' bad' : '');
      els.meta.innerHTML = '';
      const stat = (label, value) => { const s = document.createElement('span'); s.append(label + ' '); const b = document.createElement('b'); b.textContent = value; s.append(b); els.meta.append(s); };
      stat('source', last.source);
      stat('en', `${Math.round(last.ms)} ms`);
      if (last.truth && last.ok !== true) stat('réponse', last.truth);
    }
    els.note.textContent = settings.enabled ? note : 'En pause, tu joues toi-même';
    els.dbsize.textContent = `${Object.keys(db).length.toLocaleString('fr-CH')} questions en mémoire`;
    els.ai.classList.toggle('on', settings.ai);
    if (root.activeElement !== els.range) els.range.value = settings.delayMs;
    els.delayVal.textContent = settings.delayMs ? `${settings.delayMs} ms` : '0 ms (immédiat)';
    els.toggle.textContent = settings.enabled ? 'Mettre en pause' : 'Reprendre';
    els.toggle.classList.toggle('off', !settings.enabled);
  }

  function onBridge(event) {
    let msg;
    try { msg = JSON.parse(event.detail); } catch { return; }
    if (msg.type === 'hello') { db = {...msg.db, ...db}; settings = {...DEFAULTS, ...settings, ...msg.settings}; }
    else if (msg.type === 'settings') settings = {...DEFAULTS, ...settings, ...msg.settings};
    else if (msg.type === 'answer') { pendingAsks.get(msg.id)?.(msg); pendingAsks.delete(msg.id); }
    scheduleRender();
  }
  function keydown(e) { if (e.altKey && e.key.toLowerCase() === 'w') { e.preventDefault(); setSettings({enabled: !settings.enabled}); } }
  document.addEventListener('psbot:res', onBridge);
  window.addEventListener('keydown', keydown);
  globalThis.__psBot = {stop() {
    stopped = true; clearInterval(timer);
    for (const [name, fn] of listeners) client?.off(name, fn);
    document.removeEventListener('psbot:res', onBridge); window.removeEventListener('keydown', keydown); host?.remove();
  }};
  toBridge({type: 'hello'});
  timer = setInterval(tick, 250);
  tick();
})();
