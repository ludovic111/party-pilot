/* Isolated-world bridge: word lists, settings, stats and per-language memory for the page-world bot. */
(() => {
  'use strict';
  if (!location.pathname.startsWith('/games/bombparty')) return;
  const send = data => document.dispatchEvent(new CustomEvent('bpbot:res', {detail: JSON.stringify(data)}));
  let writes = Promise.resolve();
  const update = (key, fn) => (writes = writes.then(async () => {
    const value = fn((await chrome.storage.local.get(key))[key]);
    await chrome.storage.local.set({[key]: value});
  }).catch(() => {}));

  document.addEventListener('bpbot:req', async event => {
    let msg;
    try { msg = JSON.parse(event.detail); } catch { return; }
    try {
      if (msg.type === 'hello') {
        const {settings} = await chrome.storage.local.get('settings');
        send({type: 'settings', settings: settings || {}});
      } else if (msg.type === 'load') {
        const key = `mem:${msg.lang}`;
        const [text, stored] = await Promise.all([
          msg.file ? fetch(chrome.runtime.getURL(`words/${msg.file}.txt`)).then(r => r.ok ? r.text() : '') : '',
          chrome.storage.local.get(key),
        ]);
        send({type: 'words', lang: msg.lang, text, mem: stored[key] || {learned: [], rejected: []}});
      } else if (msg.type === 'remember') {
        update(`mem:${msg.lang}`, mem => {
          mem ||= {learned: [], rejected: []};
          for (const list of ['learned', 'rejected']) mem[list] = [...new Set([...mem[list], ...(msg[list] || [])])];
          return mem;
        });
      } else if (msg.type === 'settings') {
        update('settings', old => ({...old, ...msg.settings}));
      } else if (msg.type === 'stats') {
        update('stats', old => {
          const stats = {words: 0, lives: 0, letters: 0, best: null, ...old};
          stats.words += msg.words || 0; stats.lives += msg.lives || 0; stats.letters += msg.letters || 0;
          if (msg.reactionMs != null && (stats.best == null || msg.reactionMs < stats.best)) stats.best = msg.reactionMs;
          return stats;
        });
      }
    } catch (error) { send({type: 'error', message: String(error)}); }
  });

  // The toolbar popup edits the same settings: forward them to the running game.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) send({type: 'settings', settings: changes.settings.newValue || {}});
  });
})();
