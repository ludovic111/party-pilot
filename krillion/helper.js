/* Krillion helper, isolated world. Reads the current prompt from the page, asks Claude (through the
   service worker) for rare but valid answers, shows them as chips and can type them in.
   Puffer Party: answers on your turn from a batch prefetched when the category appears. */
(() => {
  'use strict';
  if (globalThis.__krHelper) return;
  globalThis.__krHelper = true;

  const DEFAULTS = {enabled: true, auto: false, partyAuto: true, partyDelayMs: 0, collapsed: false, x: null, y: 70};
  const SOLO_GAP_MS = 1000;   // between two submissions on one prompt (human pace)
  const PARTY_GAP_MS = 700;   // between a rejected answer and the next one on our turn
  const REPLY_WAIT_MS = 3000; // give up waiting for the page's verdict after this
  const NEXT_DELAY_MS = 1800; // auto: time to see the result before pressing "descend"
  const SOLO_COUNT = 14, PARTY_COUNT = 24, MAX_TOKENS = 200, MAX_FETCHES = 3;
  let settings = {...DEFAULTS};

  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // ── Claude ────────────────────────────────────────────────────────────────
  const SYSTEM = 'You help a player of Krillion, a category game. Each prompt (e.g. "Name a noodle dish") is answered '
    + 'with one short answer that is checked against the list of answers real players give; rarer valid answers score more, '
    + 'invalid ones score nothing. Reply with ONLY a JSON array of strings: no prose, no numbering, no markdown.';
  const cache = new Map(); // norm(prompt) -> {answers: string[], ms, fetches, loading, error}

  function parseList(text) {
    const m = String(text).match(/\[[\s\S]*\]/);
    let list = [];
    if (m) { try { list = JSON.parse(m[0]); } catch { list = []; } }
    if (!list.length) list = String(text).split(/\n|,/).map(s => s.replace(/^[\s\-*\d.)"']+|["'\s]+$/g, ''));
    return list.filter(s => typeof s === 'string' && s.trim() && s.length <= 60).map(s => s.trim());
  }

  // Fetches once per prompt; again only when asked for more, or to retry a failed first call.
  function ask(prompt, party, avoid, more = false) {
    const key = norm(prompt);
    let entry = cache.get(key);
    if (!entry) cache.set(key, entry = {answers: [], ms: null, fetches: 0, loading: false, error: null, errorAt: 0});
    if (entry.loading || entry.fetches >= MAX_FETCHES) return entry;
    const retry = entry.error && !entry.answers.length && performance.now() - entry.errorAt > 5000;
    if (entry.fetches && !more && !retry) return entry;
    entry.loading = true; entry.fetches++; entry.error = null;
    const known = [...new Set([...entry.answers, ...avoid])].slice(-60);
    const n = party ? PARTY_COUNT : SOLO_COUNT;
    const order = party
      ? 'Order: answers you are absolutely sure are valid first; among equally sure ones, put the less obvious first.'
      : 'Order: rarest answers that are still certainly valid first, then safer well-known ones. Never invent: a rare answer must be real and clearly fit the prompt.';
    const content = `Prompt: "${prompt}"\nGive ${n} distinct answers, each as people would commonly type it (a name or a few words). ${order}`
      + (known.length ? `\nDo not repeat any of these: ${JSON.stringify(known)}` : '');
    note = `Claude réfléchit… (${prompt})`; scheduleRender();
    chrome.runtime.sendMessage({type: 'claude', system: SYSTEM, content, maxTokens: MAX_TOKENS}).then(r => {
      entry.loading = false;
      if (!r?.ok) { entry.error = r?.error || 'pas de réponse'; entry.errorAt = performance.now(); note = `Erreur IA : ${entry.error}`; return; }
      const seen = new Set(entry.answers.map(norm));
      for (const a of parseList(r.text)) if (!seen.has(norm(a))) { seen.add(norm(a)); entry.answers.push(a); }
      entry.ms = r.ms;
      note = `${entry.answers.length} réponses en ${r.ms} ms`;
    }, e => {
      entry.loading = false; entry.error = String(e?.message || e); entry.errorAt = performance.now();
      note = /context invalidated/i.test(entry.error) ? 'Extension rechargée : recharge la page' : `Erreur IA : ${entry.error}`;
    }).finally(() => { scheduleRender(); tick(); });
    return entry;
  }

  // ── Page ──────────────────────────────────────────────────────────────────
  function pageMode() {
    const p = location.pathname;
    if (p.startsWith('/party/')) return {key: 'party', label: 'Puffer Party'};
    if (p.startsWith('/party')) return null;
    if (p === '/') return {key: 'daily', label: 'Plongée du jour'};
    if (p.startsWith('/unlimited')) return {key: 'unlimited', label: 'Illimité'};
    if (p.startsWith('/archive')) return {key: 'archive', label: 'Archive'};
    const pack = p.match(/^\/(lexicon|movies|sports|geography|packs\/[^/]+)/);
    if (pack) return {key: 'pack', label: `Pack ${pack[1].replace('packs/', '')}`};
    return null;
  }
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  function readPage() {
    const prompts = [...document.querySelectorAll('.prompt')].filter(e => visible(e) && e.textContent.trim());
    const input = document.querySelector('input.ds-input');
    const reject = document.querySelector('.ds-reject');
    const correction = document.querySelector('.ds-correction');
    return {
      prompt: prompts.length ? prompts[prompts.length - 1].textContent.trim() : null,
      phase: document.querySelector('.ds-root')?.dataset.phase || null,
      input: input && !input.disabled ? input : null,
      rejectText: reject && visible(reject) ? reject.textContent.trim() : '',
      correction: correction && correction.textContent.trim() ? correction.textContent.trim() : '',
    };
  }
  function fill(input, text) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  }
  function submit(input) {
    if (input.form) input.form.requestSubmit();
    else input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true}));
  }

  // ── Solo modes (daily, unlimited, archive, packs) ─────────────────────────
  let promptKey = null, promptText = null;
  let tried = new Set(), rejected = new Set(), accepted = null, waiting = null, lastSubmit = 0, lastReject = '', feedbackAt = 0;
  let note = 'En attente d’une question…';

  function onPrompt(text) {
    promptKey = norm(text); promptText = text;
    tried = new Set(); rejected = new Set(); accepted = null; waiting = null; lastReject = '';
  }

  function solo(page) {
    if (page.prompt && norm(page.prompt) !== promptKey) onPrompt(page.prompt);
    if (!promptKey) return;
    const entry = ask(promptText, false, [...tried]);
    if (page.rejectText && page.rejectText !== lastReject) {
      lastReject = page.rejectText;
      const m = page.rejectText.match(/^"(.+)"/);
      if (m) { rejected.add(norm(m[1])); tried.add(norm(m[1])); }
      if (waiting) waiting = null;
    }
    if (waiting && page.phase === 'feedback') { accepted = waiting.text; waiting = null; note = `Accepté : ${accepted}`; }
    if (waiting && performance.now() - waiting.at > REPLY_WAIT_MS) waiting = null;
    if (page.phase !== 'feedback') feedbackAt = 0;
    else if (!feedbackAt) feedbackAt = performance.now();
    if (settings.enabled && settings.auto && feedbackAt && performance.now() - feedbackAt > NEXT_DELAY_MS) {
      const next = document.querySelector('.ds-next-btn'); // "DESCEND ▼": on to the next prompt
      if (next && visible(next)) { feedbackAt = Infinity; next.click(); }
    }
    if (!settings.enabled || !settings.auto || page.phase !== 'answering' || !page.input || waiting) return;
    if (performance.now() - lastSubmit < SOLO_GAP_MS) return;
    if (page.correction && page.input.value) { // the game proposes a spelling fix: accept it
      lastSubmit = performance.now(); waiting = {text: page.input.value, at: lastSubmit};
      note = `Correction acceptée : ${page.input.value}`; submit(page.input); return;
    }
    const pick = entry.answers.find(a => !tried.has(norm(a)));
    if (!pick) { if (!entry.loading && entry.answers.length) { note = 'Plus de réponses, nouvelle demande…'; ask(promptText, false, [...tried], true); } return; }
    tried.add(norm(pick));
    fill(page.input, pick); submit(page.input);
    lastSubmit = performance.now(); waiting = {text: pick, at: lastSubmit};
    note = `Envoyé : ${pick}`;
  }

  // ── Puffer Party ──────────────────────────────────────────────────────────
  let room = null, me = null, lastSeq = 0, gameId = null, catKey = null;
  let used = new Set(), partyTried = new Set(), turnKey = null, partyWaiting = null, partyLast = 0, turnStarted = 0;
  const stats = {accepted: 0, rejected: 0, latency: []};

  function applyRoom(next) {
    room = next;
    if (room.gameId !== gameId) { gameId = room.gameId; lastSeq = 0; used = new Set(); }
    for (const ev of room.events || []) if (ev.seq > lastSeq) { lastSeq = ev.seq; onEvent(ev); }
    for (const p of room.players || []) if (p.lastAnswer?.text) used.add(norm(p.lastAnswer.text));
    const cat = room.category;
    const key = cat ? `${room.gameId}:${cat.index}:${norm(cat.text)}` : null;
    if (key && key !== catKey) { catKey = key; partyTried = new Set(); ask(cat.text, true, [...used]); }
    scheduleRender(); tick();
  }
  function onEvent(ev) {
    if (ev.kind === 'pass' && ev.answer) {
      used.add(norm(ev.answer));
      if (ev.from === me && partyWaiting) {
        stats.accepted++; stats.latency.push(Math.round(performance.now() - turnStarted));
        note = `Passé : ${ev.answer} (${ev.tier || '?'})`; partyWaiting = null;
      }
    } else if (ev.kind === 'reject') {
      if (ev.text) { partyTried.add(norm(ev.text)); if (ev.why && ev.why !== 'miss') used.add(norm(ev.text)); }
      if (ev.playerId === me && partyWaiting) { stats.rejected++; note = `Refusé : ${ev.text} (${ev.why})`; partyWaiting = null; partyLast = performance.now(); }
    }
  }
  function onTap(event) {
    let msg;
    try { msg = JSON.parse(event.detail); } catch { return; }
    if (msg.kind === 'join') { me = msg.playerId; return; }
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }
    if (msg.kind === 'room') return applyRoom(data);
    if (data.t === 'snap' && data.room) return applyRoom(data.room);
    if (data.t !== 'patch' || !room) return;
    const p = data.patch;
    if (p.base !== room.version) return; // the page asks for a fresh snapshot, we get it too
    const next = {...room, ...(p.set || {}), version: p.v, now: p.now};
    if (p.players || p.drop) {
      const byId = new Map(room.players.map(x => [x.id, x]));
      for (const id of p.drop || []) byId.delete(id);
      for (const x of p.players || []) byId.set(x.id, x);
      next.players = [...byId.values()].sort((a, b) => a.seat - b.seat);
    }
    if (p.eventsAll) next.events = p.eventsAll; else if (p.events) next.events = [...room.events, ...p.events].slice(-200);
    applyRoom(next);
  }

  function party(page) {
    const domTurn = !!page.input && /your puffer/i.test(page.input.placeholder || '');
    if (domTurn && room?.holderId && !me) me = room.holderId; // our seat restored without a join call
    const cat = room?.category?.text || page.prompt;
    if (!cat) return;
    if (!room && norm(cat) !== promptKey) { onPrompt(cat); ask(cat, true, []); }
    promptText = cat; promptKey = norm(cat);
    const myTurn = room ? room.phase === 'round' && room.holderId === me && domTurn : domTurn;
    if (!myTurn) { turnKey = null; partyWaiting = null; return; }
    const key = room ? `${room.holderSince}` : 'dom';
    if (key !== turnKey) { turnKey = key; turnStarted = performance.now(); partyWaiting = null; partyLast = 0; }
    if (!settings.enabled || !settings.partyAuto) return;
    if (partyWaiting && performance.now() - partyWaiting.at < REPLY_WAIT_MS) return;
    partyWaiting = null;
    if (performance.now() - partyLast < PARTY_GAP_MS) return;
    if (performance.now() - turnStarted < settings.partyDelayMs) return;
    const entry = ask(cat, true, [...used, ...partyTried]);
    const pick = entry.answers.find(a => !used.has(norm(a)) && !partyTried.has(norm(a)));
    const left = entry.answers.filter(a => !used.has(norm(a)) && !partyTried.has(norm(a))).length;
    if (left < 5 && entry.answers.length && !entry.loading) ask(cat, true, [...used, ...partyTried], true);
    if (!pick) { note = entry.loading ? 'Claude réfléchit…' : 'Plus de réponses inédites'; return; }
    partyTried.add(norm(pick));
    fill(page.input, pick); submit(page.input);
    partyLast = performance.now(); partyWaiting = {text: pick, at: partyLast};
    note = `Envoyé : ${pick} (${Math.round(partyLast - turnStarted)} ms après le début du tour)`;
  }

  // ── Loop ──────────────────────────────────────────────────────────────────
  let mode = null, timer = null;
  function tick() {
    const m = pageMode();
    if (m?.key !== mode?.key) { mode = m; promptKey = null; }
    if (!mode) { if (host) host.style.display = 'none'; return; }
    if (host) host.style.display = '';
    const page = readPage();
    if (mode.key === 'party') party(page); else solo(page);
    scheduleRender();
  }

  // ── Panel (same look as the BombParty panel) ──────────────────────────────
  const LOGO = `<svg aria-hidden="true" viewBox="0 0 128 128"><defs><linearGradient id="krpp-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a3c"/><stop offset=".55" stop-color="#ff3d77"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient><radialGradient id="krpp-bubble" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#2c3352"/><stop offset="1" stop-color="#121522"/></radialGradient></defs><rect width="128" height="128" rx="30" fill="url(#krpp-bg)"/><path d="M30 30h68a14 14 0 0 1 14 14v36a14 14 0 0 1-14 14H62l-20 16v-16H30a14 14 0 0 1-14-14V44a14 14 0 0 1 14-14z" fill="url(#krpp-bubble)"/><path d="M70 38 50 68h14l-6 22 22-32H66l4-20z" fill="#ffd34d"/><path d="M104 10l3 7.5 7.5 3-7.5 3-3 7.5-3-7.5-7.5-3 7.5-3z" fill="#fff6c2"/></svg>`; // icons/logo.svg, ids prefixed
  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;margin:0;font-family:Inter,"Segoe UI",system-ui,sans-serif}
    .card{position:fixed;z-index:2147483647;width:300px;color:#e8ecf6;background:rgba(16,19,31,.88);backdrop-filter:blur(14px) saturate(140%);
      border:1px solid rgba(255,255,255,.09);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.45);overflow:hidden;
      font-size:12px;line-height:1.4;user-select:none}
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
    .hero{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px 12px}
    .prompt{font-size:15px;font-weight:800;color:#fff;letter-spacing:.2px}
    .meta{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:4px;white-space:nowrap;color:#9aa3bd;font-variant-numeric:tabular-nums}
    .meta b{color:#e8ecf6}
    .chips{display:flex;flex-wrap:wrap;gap:5px;max-height:190px;overflow:auto}
    .chips button{border:1px solid rgba(255,154,60,.35);background:rgba(255,154,60,.08);color:#ffd8b8;border-radius:99px;
      padding:4px 9px;font-size:11.5px;font-weight:600;cursor:pointer}
    .chips button:hover{background:linear-gradient(90deg,#ff9a3c,#ff3d77);color:#fff;border-color:transparent}
    .chips button.first{border-color:#ff9a3c;color:#fff}
    .chips button.tried{opacity:.4;text-decoration:line-through}
    .chips button.ok{border-color:#34d399;background:rgba(52,211,153,.16);color:#34d399;text-decoration:none;opacity:1}
    .empty{color:#5d6684}
    .note{color:#9aa3bd;font-size:11px;min-height:15px}
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
  let host, root, els = {}, renderQueued = false, chipKey = '';

  function build() {
    host = document.createElement('div');
    root = host.attachShadow({mode: 'closed'});
    root.innerHTML = `<style>${CSS}</style><div class="card">
      <header><span class="logo">${LOGO}</span><div class="title">Party Pilot<small class="sub"></small></div>
        <span class="pill"></span><button class="icon collapse" title="Réduire">–</button></header>
      <div class="body">
        <div class="hero"><div class="prompt">—</div><div class="meta"></div></div>
        <div class="chips"></div>
        <div class="note"></div>
        <div class="seg"><button data-auto="0">💡 Suggestions</button><button data-auto="1">⚡ Auto</button></div>
        <label class="delay"><span>Délai avant de répondre <b class="delayVal"></b></span><input type="range" min="0" max="3000" step="50" name="partyDelayMs"></label>
        <button class="toggle"></button>
        <div class="hint">clic : taper · double-clic : envoyer · Alt+W : pause<br>usage éducatif uniquement</div>
      </div></div>`;
    for (const k of ['card', 'sub', 'pill', 'collapse', 'prompt', 'meta', 'chips', 'note', 'toggle', 'delay', 'delayVal']) els[k] = root.querySelector('.' + k);
    els.seg = [...root.querySelectorAll('.seg button')];
    els.range = root.querySelector('input[type=range]');
    els.range.addEventListener('input', () => { settings.partyDelayMs = Number(els.range.value); render(); });
    els.range.addEventListener('change', () => setSettings({partyDelayMs: Number(els.range.value)}));
    els.toggle.addEventListener('click', () => setSettings({enabled: !settings.enabled}));
    els.collapse.addEventListener('click', () => setSettings({collapsed: !settings.collapsed}));
    for (const b of els.seg) b.addEventListener('click', () => setSettings({[mode?.key === 'party' ? 'partyAuto' : 'auto']: b.dataset.auto === '1'}));
    els.chips.addEventListener('click', e => {
      const b = e.target.closest('button'); const input = document.querySelector('input.ds-input');
      if (!b || !input || input.disabled) return;
      fill(input, b.dataset.answer); input.focus();
    });
    els.chips.addEventListener('dblclick', e => {
      const b = e.target.closest('button'); const input = document.querySelector('input.ds-input');
      if (!b || !input || input.disabled) return;
      fill(input, b.dataset.answer); (mode?.key === 'party' ? partyTried : tried).add(norm(b.dataset.answer)); submit(input);
    });
    const header = root.querySelector('header');
    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const r = els.card.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => {
        settings.x = Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx));
        settings.y = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy));
        place();
      };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); setSettings({x: settings.x, y: settings.y}); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    document.documentElement.append(host);
  }
  function place() {
    const x = settings.x ?? Math.max(0, innerWidth - 316);
    els.card.style.left = Math.min(x, innerWidth - 60) + 'px'; els.card.style.top = settings.y + 'px';
  }
  function setSettings(patch) {
    settings = {...settings, ...patch};
    chrome.storage.local.set({krillion: settings}).catch(() => {});
    render(); tick();
  }
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function render() {
    if (!mode || !document.documentElement) return;
    if (!host) build();
    const party = mode.key === 'party', auto = party ? settings.partyAuto : settings.auto;
    place();
    els.card.classList.toggle('collapsed', !!settings.collapsed);
    els.collapse.textContent = settings.collapsed ? '+' : '–';
    els.sub.textContent = `Krillion · ${mode.label}`;
    els.pill.textContent = !settings.enabled ? 'PAUSE' : auto ? 'AUTO' : 'ACTIF';
    els.pill.classList.toggle('on', settings.enabled);
    els.prompt.textContent = promptText || '—';
    const entry = promptKey ? cache.get(promptKey) : null;
    els.meta.textContent = '';
    const stat = (label, value) => { const s = document.createElement('span'); s.append(label + ' '); const b = document.createElement('b'); b.textContent = value; s.append(b); els.meta.append(s); };
    if (entry) { stat('réponses', entry.answers.length); if (entry.ms != null) stat('IA', `${entry.ms} ms`); }
    if (party) {
      stat('déjà dites', used.size);
      if (stats.accepted || stats.rejected) stat('✓', `${stats.accepted}/${stats.accepted + stats.rejected}`);
    }
    const blocked = party ? a => used.has(a) || partyTried.has(a) : a => tried.has(a);
    const list = entry?.answers || [];
    const key = [promptKey, list.join('|'), [...(party ? partyTried : tried)].join('|'), party ? used.size : accepted].join('#');
    if (key !== chipKey) {
      chipKey = key;
      els.chips.textContent = '';
      if (!list.length) { const s = document.createElement('span'); s.className = 'empty'; s.textContent = entry?.loading ? 'Claude cherche des réponses rares…' : entry?.error ? 'Pas de suggestions' : 'Pas encore de question'; els.chips.append(s); }
      let first = true;
      for (const a of list) {
        const b = document.createElement('button'), n = norm(a), out = blocked(n);
        b.textContent = a; b.dataset.answer = a; b.title = 'clic : taper · double-clic : envoyer';
        if (out) b.classList.add('tried');
        if (accepted && norm(accepted) === n && !party) b.classList.add('ok');
        if (!out && first) { b.classList.add('first'); first = false; }
        els.chips.append(b);
      }
    }
    els.note.textContent = settings.enabled ? note : 'En pause, tu joues toi-même';
    for (const b of els.seg) b.classList.toggle('sel', (b.dataset.auto === '1') === !!auto);
    els.delay.style.display = party ? '' : 'none';
    if (root.activeElement !== els.range) els.range.value = settings.partyDelayMs;
    els.delayVal.textContent = settings.partyDelayMs ? `${settings.partyDelayMs} ms` : '0 ms (immédiat)';
    els.toggle.textContent = settings.enabled ? 'Mettre en pause' : 'Reprendre';
    els.toggle.classList.toggle('off', !settings.enabled);
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  document.addEventListener('krhelper:tap', onTap);
  addEventListener('keydown', e => {
    if (e.altKey && e.key.toLowerCase() === 'w') { e.preventDefault(); setSettings({enabled: !settings.enabled}); }
  }, true);
  chrome.storage.local.get('krillion').then(({krillion}) => { settings = {...DEFAULTS, ...krillion}; scheduleRender(); }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.krillion?.newValue) { settings = {...DEFAULTS, ...changes.krillion.newValue}; scheduleRender(); }
  });
  timer = setInterval(tick, 120);
  tick();
})();
