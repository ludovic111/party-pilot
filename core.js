/* Word search core: language detection, dictionary index and word choice. No DOM, no game state. */
(() => {
  'use strict';
  const normalize = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/ß/g, 'ss').trim();
  const VALID = /^[a-z][a-z-]*$/;

  // Tested against the dictionary id and the manifest name; first match wins.
  const LANGS = [
    [/pok.*(fr|franc)|fr.*pok/, 'pok-fr', 'Pokémon (FR)'], [/pok.*(de|germ|deutsch)|de.*pok/, 'pok-de', 'Pokémon (DE)'],
    [/pok/, 'pok-en', 'Pokémon (EN)'], [/portug|^pt/, 'pt-br', 'Portugais (BR)'],
    [/breton|brezhoneg|^br$/, 'br', 'Breton'], [/nahuatl|^nah/, 'nah', 'Nahuatl'],
    [/french|francais|^fr/, 'fr', 'Français'], [/german|deutsch|^de/, 'de', 'Allemand'],
    [/spanish|espanol|^es/, 'es', 'Espagnol'], [/english|^en/, 'en', 'Anglais'],
  ];
  function detectLanguage(id, name) {
    for (const key of [normalize(id), normalize(name)]) {
      if (!key) continue;
      for (const [test, file, label] of LANGS) if (test.test(key)) return {key: normalize(id) || key, file, label};
    }
    const key = normalize(id) || normalize(name);
    return key ? {key, file: null, label: name || id} : null;
  }

  const code = c => c === 45 ? 26 : c - 97; // a-z → 0-25, '-' → 26
  const byLengthThenAlpha = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

  class Dict {
    // words: shortest first, so the first best candidate is also the quickest to send.
    constructor(text, learned = [], rejected = []) {
      const set = new Set(text ? text.split('\n') : []);
      for (const w of learned) set.add(w);
      for (const w of rejected) set.delete(w);
      set.delete('');
      const words = this.words = [...set].filter(w => VALID.test(w)).sort(byLengthThenAlpha);
      const n = words.length, masks = this.masks = new Int32Array(n);
      const letterCount = new Float64Array(26), bucketCount = new Int32Array(729), stamp = new Int32Array(729).fill(-1);
      for (let i = 0; i < n; i++) {
        const w = words[i];
        let m = 0, prev = -1;
        for (let j = 0; j < w.length; j++) {
          const c = code(w.charCodeAt(j));
          if (c < 26) m |= 1 << c;
          if (prev >= 0) { const b = prev * 27 + c; if (stamp[b] !== i) { stamp[b] = i; bucketCount[b]++; } }
          prev = c;
        }
        masks[i] = m;
        for (let c = 0; c < 26; c++) if (m & (1 << c)) letterCount[c]++;
      }
      // Bigram postings: candidates for a prompt come from its rarest bigram instead of a full scan.
      const start = this.start = new Int32Array(730);
      for (let b = 0; b < 729; b++) start[b + 1] = start[b] + bucketCount[b];
      const fill = start.slice(0, 729), postings = this.postings = new Int32Array(start[729]);
      stamp.fill(-1);
      for (let i = 0; i < n; i++) {
        const w = words[i];
        for (let j = 1; j < w.length; j++) {
          const b = code(w.charCodeAt(j - 1)) * 27 + code(w.charCodeAt(j));
          if (stamp[b] !== i) { stamp[b] = i; postings[fill[b]++] = i; }
        }
      }
      // Rare letters weigh more: grabbing a Q or a Z now saves a turn later.
      this.weights = new Float64Array(26);
      for (let c = 0; c < 26; c++) this.weights[c] = 1 + Math.log2((n + 1) / (letterCount[c] + 1));
      this.extra = []; // words learned during this game, outside the index
    }
    get size() { return this.words.length + this.extra.length; }
    has(word) {
      let lo = 0, hi = this.words.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, cmp = byLengthThenAlpha(this.words[mid], word);
        if (cmp === 0) return true;
        if (cmp < 0) lo = mid + 1; else hi = mid - 1;
      }
      return this.extra.includes(word);
    }
    learn(word) {
      if (!VALID.test(word) || this.has(word)) return false;
      this.extra.push(word);
      return true;
    }
    static mask(word) {
      let m = 0;
      for (let j = 0; j < word.length; j++) { const c = code(word.charCodeAt(j)); if (c < 26) m |= 1 << c; }
      return m;
    }
    score(m) {
      let s = 0;
      while (m) { const low = m & -m; s += this.weights[31 - Math.clz32(low)]; m ^= low; }
      return s;
    }
    // Best word containing the prompt: most weighted missing bonus letters, then shortest.
    choose(prompt, need, blocked) {
      prompt = normalize(prompt);
      if (!prompt) return null;
      const {words, masks} = this, ceiling = this.score(need);
      let best = -1, bestScore = -1;
      const consider = (i, w, m) => {
        const s = need ? this.score(m & need) : 0;
        if (s > bestScore && !blocked(w)) { best = i; bestScore = s; return s >= ceiling; }
        return false;
      };
      let from = 0, to = words.length, list = null;
      if (prompt.length >= 2 && VALID.test(prompt[0] === '-' ? 'a' + prompt : prompt)) {
        let bucket = -1;
        for (let j = 1; j < prompt.length; j++) {
          const b = code(prompt.charCodeAt(j - 1)) * 27 + code(prompt.charCodeAt(j));
          if (bucket < 0 || this.start[b + 1] - this.start[b] < this.start[bucket + 1] - this.start[bucket]) bucket = b;
        }
        list = this.postings; from = this.start[bucket]; to = this.start[bucket + 1];
      }
      const exact = !list || prompt.length > 2;
      for (let k = from; k < to; k++) {
        const i = list ? list[k] : k, w = words[i];
        if (exact && !w.includes(prompt)) continue;
        if (consider(i, w, masks[i])) break;
      }
      let word = best >= 0 ? words[best] : null;
      for (const w of this.extra) {
        if (!w.includes(prompt) || blocked(w)) continue;
        const s = need ? this.score(Dict.mask(w) & need) : 0;
        if (s > bestScore || (s === bestScore && word && w.length < word.length)) { word = w; bestScore = s; }
      }
      return word && {word, score: bestScore, gain: need ? popcount(Dict.mask(word) & need) : 0};
    }
  }
  function popcount(m) { let n = 0; while (m) { m &= m - 1; n++; } return n; }

  globalThis.BPBotCore = {normalize, detectLanguage, Dict, VALID};
})();
