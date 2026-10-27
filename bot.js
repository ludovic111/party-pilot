/* BombParty Bot, page world. Socket events drive the hot path; the timer is only a safety net. */
(() => {
  'use strict';
  if (!location.pathname.startsWith('/games/bombparty')) return;
  globalThis.__bpBot?.stop();
  const {normalize, detectLanguage, Dict} = globalThis.BPBotCore;

  const DEFAULTS = {enabled: true, mode: 'instant', wpm: 300, reactionMs: 0, collapsed: false, x: 12, y: 12};
  const MAX_ATTEMPTS = 12, LOST_REPLY_MS = 400;
  let settings = {...DEFAULTS};
  let dict = null, lang = null, loadingKey = null;
  const used = new Set(), rejected = new Set(), tried = new Set(), playerWords = new Map();
  const blocked = w => used.has(w) || rejected.has(w) || tried.has(w);
  let client = null, stopped = false, timer = null;
  let generation = 0, pending = null, pendingAt = 0, turnStart = 0, attempts = 0, typingTimer = null;
  let note = 'Connexion au jeu…', last = null, flash = null;
  const listeners = [];
  const toBridge = data => document.dispatchEvent(new CustomEvent('bpbot:req', {detail: JSON.stringify(data)}));

  function game() {
    try { return {m: milestone, me: selfPeerId, rules, socket}; } catch { return null; }
  }
  const self = g => g?.m?.playerStatesByPeerId?.[g.me];
  function myTurn(g) {
    const p = self(g);
    return g?.m?.name === 'round' && g.m.currentPlayerPeerId === g.me && p?.lives > 0 && !p.wasWordValidated;
  }
  function needMask(g) {
    let mask = 0;
    for (const [letter, n] of Object.entries(self(g)?.bonusLetters || {})) {
      const c = normalize(letter).charCodeAt(0) - 97;
      if (n > 0 && c >= 0 && c < 26) mask |= 1 << c;
    }
    return mask;
  }

  // ── Language ──────────────────────────────────────────────────────────────
  function syncLanguage(g) {
    const info = detectLanguage(g?.rules?.dictionaryId?.value, g?.m?.dictionaryManifest?.name);
    if (!info || info.key === loadingKey || (info.key === lang?.key && dict)) return;
    lang = info; dict = null; loadingKey = info.key; rejected.clear();
    note = `Chargement : ${info.label}…`; scheduleRender();
    toBridge({type: 'load', lang: info.key, file: info.file});
  }
  function onWords(msg) {
    if (msg.lang !== loadingKey) return;
    scheduleRender();
    setTimeout(() => { // let the panel paint "loading" before the index build blocks the thread
      if (msg.lang !== loadingKey) return;
      const t = performance.now();
      dict = new Dict(msg.text, msg.mem.learned, msg.mem.rejected);
      loadingKey = null;
      note = `${lang.label} prêt (${Math.round(performance.now() - t)} ms)`;
      if (!msg.text) note = `${lang.label} : pas de liste, apprentissage en cours`;
      play(); scheduleRender();
    }, 16);
  }
  function remember(list, word) {
    if (lang && word) toBridge({type: 'remember', lang: lang.key, [list]: [word]});
  }

  // ── Turn ──────────────────────────────────────────────────────────────────
  function cancel() {
    generation++; pending = null;
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
  }
  function play() {
    const g = game();
    if (stopped || !settings.enabled || !dict || !client || pending || typingTimer || !myTurn(g)) return;
    if (attempts >= MAX_ATTEMPTS) { note = 'Trop de refus sur ce tour, à toi de jouer'; return scheduleRender(); }
    const syllable = g.m.syllable;
    const pick = dict.choose(syllable, needMask(g), blocked);
    if (!pick) { note = `Aucun mot connu pour « ${String(syllable).toUpperCase()} »`; return scheduleRender(); }
    const token = ++generation;
    attempts++;
    const alive = () => token === generation && !stopped && settings.enabled && myTurn(game()) && game().m.syllable === syllable;
    const submit = () => {
      typingTimer = null;
      if (!alive()) return;
      pending = pick.word; pendingAt = performance.now(); tried.add(pick.word);
      client.emit('setWord', pick.word, true);
      last = {word: pick.word, syllable: normalize(syllable), gain: pick.gain, reactionMs: pendingAt - turnStart, serverMs: null, ok: null};
      note = 'Validation…'; scheduleRender();
    };
    if (settings.mode !== 'human') {
      if (settings.reactionMs > 0) typingTimer = setTimeout(submit, settings.reactionMs);
      else submit();
      return;
    }
    const charMs = 12000 / Math.max(30, settings.wpm), input = document.querySelector('.selfTurn input');
    let typed = 0;
    const step = () => {
      if (!alive()) { typingTimer = null; return; }
      const partial = pick.word.slice(0, ++typed);
      if (input) input.value = partial;
      client.emit('setWord', partial, false);
      typingTimer = setTimeout(typed < pick.word.length ? step : () => { if (input) input.value = ''; submit(); }, charMs);
    };
    note = `Frappe : ${pick.word}`; scheduleRender();
    typingTimer = setTimeout(step, settings.reactionMs);
  }

  function newGame() { cancel(); used.clear(); tried.clear(); playerWords.clear(); attempts = 0; }
  function seed(g) {
    for (const [id, p] of Object.entries(g?.m?.playerStatesByPeerId || {})) {
      playerWords.set(String(id), normalize(p.word));
      if (p.wasWordValidated && p.word) used.add(normalize(p.word));
    }
  }

  function attach(g) {
    client = g.socket;
    const on = (name, fn) => { client.on(name, fn); listeners.push([name, fn]); };
    on('nextTurn', (peerId) => {
      turnStart = performance.now();
      cancel(); tried.clear(); attempts = 0;
      if (peerId === game()?.me) play();
      scheduleRender();
    });
    on('setPlayerWord', (peerId, word) => playerWords.set(String(peerId), normalize(word)));
    on('correctWord', ({playerPeerId}) => {
      const g = game(), mine = playerPeerId === g?.me;
      const word = mine ? pending : playerWords.get(String(playerPeerId)) || normalize(g?.m?.playerStatesByPeerId?.[playerPeerId]?.word);
      if (word) used.add(word);
      if (!mine && word && dict?.learn(word)) remember('learned', word);
      if (mine && last && pending) {
        last.serverMs = performance.now() - pendingAt; last.ok = true;
        toBridge({type: 'stats', words: 1, letters: last.gain, reactionMs: Math.round(last.reactionMs * 100) / 100});
        note = 'Mot accepté';
      }
      if (mine) pending = null;
      scheduleRender();
    });
    on('failWord', (peerId, reason) => {
      const g = game(), mine = peerId === g?.me;
      const word = mine ? pending : playerWords.get(String(peerId));
      if (word && reason === 'notInDictionary' && dict?.has(word)) { rejected.add(word); remember('rejected', word); }
      if (word && reason === 'alreadyUsed') used.add(word);
      if (!mine) return;
      if (last && pending) last.ok = false;
      note = `Refusé (${reason}), essai suivant`;
      pending = null; generation++;
      play(); scheduleRender();
    });
    on('bonusAlphabetCompleted', peerId => {
      if (peerId !== game()?.me) return;
      toBridge({type: 'stats', lives: 1});
      note = 'Alphabet complété : vie gagnée !'; flash = performance.now(); scheduleRender();
    });
    on('livesLost', peerId => { if (peerId === game()?.me) { cancel(); note = 'Vie perdue'; scheduleRender(); } });
    on('setMilestone', m => {
      if (m?.name !== 'round' || !m.usedWordCount) newGame(); else cancel();
      const g = game(); seed(g); syncLanguage(g); play(); scheduleRender();
    });
    on('setup', () => { newGame(); const g = game(); seed(g); syncLanguage(g); play(); scheduleRender(); });
    on('setRules', data => { if (data && 'dictionaryId' in data) syncLanguage(game()); });
    on('setDictionaryManifest', () => syncLanguage(game()));
    on('disconnect', () => { cancel(); note = 'Déconnecté du serveur'; scheduleRender(); });
    seed(g);
  }

  function tick() {
    if (stopped) return;
    const g = game();
    if (g?.socket && !client) attach(g);
    if (g?.m) syncLanguage(g);
    if (pending && performance.now() - pendingAt > LOST_REPLY_MS) { pending = null; note = 'Pas de réponse, nouvel essai'; }
    play();
    scheduleRender();
  }

  // ── Panel ─────────────────────────────────────────────────────────────────
  const LOGO = `<svg aria-hidden="true" viewBox="0 0 128 128"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a3c"/><stop offset="1" stop-color="#ff3d77"/></linearGradient><radialGradient id="bomb" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#3a4160"/><stop offset="1" stop-color="#121522"/></radialGradient></defs><rect width="128" height="128" rx="30" fill="url(#bg)"/><circle cx="58" cy="74" r="36" fill="url(#bomb)"/><rect x="71" y="30" width="22" height="17" rx="4" transform="rotate(40 82 38.5)" fill="#121522"/><path d="M89 31c5-9 13-12 19-8" stroke="#121522" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M111 9l3.5 8.5 8.5 3.5-8.5 3.5-3.5 8.5-3.5-8.5-8.5-3.5 8.5-3.5z" fill="#fff6c2"/><path d="M64 48 45 80h13l-5 24 22-34H61l6-22z" fill="#ffd34d"/></svg>`;
  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;margin:0;font-family:Inter,"Segoe UI",system-ui,sans-serif}
    .card{position:fixed;width:288px;color:#e8ecf6;background:rgba(16,19,31,.88);backdrop-filter:blur(14px) saturate(140%);
      border:1px solid rgba(255,255,255,.09);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.45);overflow:hidden;
      font-size:12px;line-height:1.4;user-select:none;transition:box-shadow .3s}
    .card.flash{box-shadow:0 0 0 2px #ffd34d,0 0 40px rgba(255,211,77,.55)}
    header{display:flex;align-items:center;gap:9px;padding:10px 12px;cursor:grab;background:linear-gradient(90deg,rgba(255,154,60,.16),rgba(255,61,119,.12))}
    header:active{cursor:grabbing}
    header svg{width:26px;height:26px;flex:none;border-radius:7px}
    .title{font-weight:700;font-size:13px;letter-spacing:.2px;flex:1}
    .title small{display:block;font-weight:500;font-size:10.5px;color:#9aa3bd}
    .pill{font-size:10px;font-weight:700;letter-spacing:.6px;padding:3px 8px;border-radius:99px;background:#2b3146;color:#9aa3bd}
    .pill.on{background:rgba(52,211,153,.16);color:#34d399}
    .icon{border:0;background:rgba(255,255,255,.06);color:#c9d0e3;width:24px;height:24px;border-radius:7px;cursor:pointer;font-size:13px}
    .icon:hover{background:rgba(255,255,255,.14)}
    .body{padding:12px;display:grid;gap:12px}
    .collapsed .body{display:none}
    .lang{display:flex;align-items:center;gap:8px;color:#9aa3bd}
    .code{font-weight:800;font-size:10px;padding:3px 6px;border-radius:6px;background:#ffd34d;color:#141826}
    .hero{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px 12px}
    .word{font-size:20px;font-weight:800;letter-spacing:.5px;word-break:break-all;color:#fff}
    .word.bad{color:#f87171;text-decoration:line-through}
    .word mark{background:none;color:#ff9a3c}
    .meta{display:flex;gap:10px;margin-top:4px;color:#9aa3bd;font-variant-numeric:tabular-nums}
    .meta b{color:#e8ecf6}
    .note{color:#9aa3bd;font-size:11px;min-height:15px}
    .letters{display:grid;grid-template-columns:repeat(13,1fr);gap:3px}
    .letters span{display:grid;place-items:center;height:18px;border-radius:5px;font-size:10px;font-weight:700;background:rgba(255,255,255,.04);color:#4b5370}
    .letters span.need{background:rgba(255,211,77,.14);color:#ffd34d}
    .row{display:flex;justify-content:space-between;align-items:center;color:#9aa3bd}
    .hearts{color:#ff5d8a;letter-spacing:1px}
    .seg{display:grid;grid-template-columns:1fr 1fr;background:rgba(255,255,255,.05);border-radius:10px;padding:3px}
    .seg button{border:0;background:none;color:#9aa3bd;padding:6px;border-radius:8px;font-weight:600;font-size:11.5px;cursor:pointer}
    .seg button.sel{background:linear-gradient(90deg,#ff9a3c,#ff3d77);color:#fff}
    label{display:grid;gap:4px;color:#9aa3bd}
    label span{display:flex;justify-content:space-between}
    label b{color:#e8ecf6;font-variant-numeric:tabular-nums}
    input[type=range]{width:100%;accent-color:#ff6a5a}
    .toggle{border:0;border-radius:10px;padding:9px;font-weight:700;font-size:12px;cursor:pointer;color:#141826;background:#34d399}
    .toggle.off{background:#2b3146;color:#e8ecf6}
    .hint{text-align:center;color:#5d6684;font-size:10px}`;
  const LANG_CODES = {'pt-br': 'BR', br: 'BZH', nah: 'NAH', 'pok-en': 'PKM', 'pok-fr': 'PKM', 'pok-de': 'PKM'};
  let host, root, els = {}, renderQueued = false;

  function build() {
    host = document.createElement('div');
    root = host.attachShadow({mode: 'closed'});
    root.innerHTML = `<style>${CSS}</style><div class="card">
      <header><span class="logo">${LOGO}</span><div class="title">BombParty Bot<small>toutes langues · lettres bonus</small></div>
        <span class="pill"></span><button class="icon collapse" title="Réduire">–</button></header>
      <div class="body">
        <div class="lang"><span class="code"></span><span class="langName"></span></div>
        <div class="hero"><div class="word">—</div><div class="meta"></div></div>
        <div class="note"></div>
        <div><div class="row" style="margin-bottom:6px"><span>Lettres bonus restantes</span><span class="hearts"></span></div><div class="letters"></div></div>
        <div class="seg"><button data-mode="instant">⚡ Instantané</button><button data-mode="human">⌨ Humain</button></div>
        <label class="wpm"><span>Vitesse de frappe <b class="wpmVal"></b></span><input type="range" min="60" max="1500" step="20" name="wpm"></label>
        <label><span>Délai de réaction <b class="reactVal"></b></span><input type="range" min="0" max="1500" step="10" name="reactionMs"></label>
        <button class="toggle"></button>
        <div class="hint">Alt+W : pause · usage éducatif uniquement</div>
      </div></div>`;
    for (const k of ['card', 'pill', 'collapse', 'code', 'langName', 'word', 'meta', 'note', 'letters', 'hearts', 'toggle', 'wpm', 'wpmVal', 'reactVal'])
      els[k] = root.querySelector('.' + k);
    els.seg = [...root.querySelectorAll('.seg button')];
    els.ranges = [...root.querySelectorAll('input[type=range]')];
    els.toggle.addEventListener('click', () => setSettings({enabled: !settings.enabled}));
    els.collapse.addEventListener('click', () => setSettings({collapsed: !settings.collapsed}));
    for (const b of els.seg) b.addEventListener('click', () => setSettings({mode: b.dataset.mode}));
    for (const r of els.ranges) {
      r.addEventListener('input', () => { settings[r.name] = Number(r.value); render(); });
      r.addEventListener('change', () => setSettings({[r.name]: Number(r.value)}));
    }
    const header = root.querySelector('header');
    header.addEventListener('pointerdown', e => {
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
  function setSettings(patch) {
    settings = {...settings, ...patch};
    if ('enabled' in patch || 'mode' in patch) { cancel(); if (settings.enabled) play(); }
    toBridge({type: 'settings', settings: patch});
    render();
  }
  function scheduleRender() {
    if (renderQueued || stopped) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function render() {
    if (stopped || !document.body) return;
    if (!host) build();
    const g = game(), me = self(g);
    const {card} = els;
    card.style.left = settings.x + 'px'; card.style.top = settings.y + 'px';
    card.classList.toggle('collapsed', !!settings.collapsed);
    card.classList.toggle('flash', flash != null && performance.now() - flash < 1500);
    els.collapse.textContent = settings.collapsed ? '+' : '–';
    els.pill.textContent = settings.enabled ? 'ACTIF' : 'PAUSE';
    els.pill.classList.toggle('on', settings.enabled);
    els.code.textContent = lang ? LANG_CODES[lang.file] || (lang.file || lang.key).slice(0, 3).toUpperCase() : '…';
    els.langName.textContent = !lang ? 'Détection de la langue…'
      : dict ? `${lang.label} · ${dict.size.toLocaleString('fr-CH')} mots` : `${lang.label} · chargement…`;
    if (last) {
      const i = last.word.indexOf(last.syllable);
      els.word.innerHTML = '';
      els.word.append(last.word.slice(0, i < 0 ? 0 : i));
      const mark = document.createElement('mark'); mark.textContent = i < 0 ? '' : last.syllable;
      els.word.append(mark, i < 0 ? last.word : last.word.slice(i + last.syllable.length));
      els.word.classList.toggle('bad', last.ok === false);
      els.meta.innerHTML = '';
      const stat = (label, value) => { const s = document.createElement('span'); s.append(label + ' '); const b = document.createElement('b'); b.textContent = value; s.append(b); els.meta.append(s); };
      stat('+', `${last.gain} lettre${last.gain > 1 ? 's' : ''}`);
      stat('réaction', `${last.reactionMs.toFixed(1)} ms`);
      if (last.serverMs != null) stat('serveur', `${Math.round(last.serverMs)} ms`);
    }
    const partial = g?.m?.name === 'round' && (g.m.usedWordCount || 0) > used.size;
    els.note.textContent = (settings.enabled ? note : 'En pause, tu joues toi-même') + (partial ? ' · historique partiel' : '');
    const alphabet = Object.entries(g?.rules?.customBonusAlphabet?.value || {}).filter(([, n]) => n > 0).map(([l]) => l);
    const letters = alphabet.length ? alphabet : [...'abcdefghijklmnopqrstuvwxyz'];
    const bonus = me?.bonusLetters || {};
    if (els.letters.childElementCount !== letters.length) {
      els.letters.innerHTML = '';
      for (const l of letters) { const s = document.createElement('span'); s.textContent = l.toUpperCase(); els.letters.append(s); }
    }
    letters.forEach((l, i) => els.letters.children[i].classList.toggle('need', (bonus[l] ?? 1) > 0));
    const max = g?.rules?.maxLives?.value;
    els.hearts.textContent = me ? '♥'.repeat(Math.max(0, me.lives)) + (max ? ` ${me.lives}/${max}` : '') : '';
    for (const b of els.seg) b.classList.toggle('sel', b.dataset.mode === settings.mode);
    els.wpm.style.display = settings.mode === 'human' ? '' : 'none';
    for (const r of els.ranges) if (root.activeElement !== r) r.value = settings[r.name];
    els.wpmVal.textContent = `${settings.wpm} WPM`;
    els.reactVal.textContent = settings.reactionMs ? `${settings.reactionMs} ms` : '0 ms (immédiat)';
    els.toggle.textContent = settings.enabled ? 'Mettre en pause' : 'Reprendre';
    els.toggle.classList.toggle('off', !settings.enabled);
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  function onBridge(event) {
    let msg;
    try { msg = JSON.parse(event.detail); } catch { return; }
    if (msg.type === 'words') onWords(msg);
    else if (msg.type === 'settings') {
      const was = settings.enabled;
      settings = {...DEFAULTS, ...settings, ...msg.settings};
      if (was !== settings.enabled) { cancel(); play(); }
      scheduleRender();
    } else if (msg.type === 'error') { note = `Erreur : ${msg.message}`; scheduleRender(); }
  }
  function keydown(e) {
    if (e.altKey && e.key.toLowerCase() === 'w') { e.preventDefault(); setSettings({enabled: !settings.enabled}); }
  }
  document.addEventListener('bpbot:res', onBridge);
  window.addEventListener('keydown', keydown);
  globalThis.__bpBot = {
    stop() {
      stopped = true; cancel(); clearInterval(timer);
      for (const [name, fn] of listeners) client?.off(name, fn);
      document.removeEventListener('bpbot:res', onBridge);
      window.removeEventListener('keydown', keydown);
      host?.remove();
    },
  };
  toBridge({type: 'hello'});
  timer = setInterval(tick, 100);
  tick();
})();
