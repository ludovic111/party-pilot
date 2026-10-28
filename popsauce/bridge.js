/* Isolated-world bridge for PopSauce: answer database, settings and Claude requests for the page-world bot. */
(() => {
  'use strict';
  if (!location.pathname.startsWith('/games/popsauce')) return;
  const send = data => document.dispatchEvent(new CustomEvent('psbot:res', {detail: JSON.stringify(data)}));
  let writes = Promise.resolve();
  const update = (key, fn) => (writes = writes.then(async () => {
    await chrome.storage.local.set({[key]: fn((await chrome.storage.local.get(key))[key])});
  }).catch(() => {}));

  document.addEventListener('psbot:req', async event => {
    let msg;
    try { msg = JSON.parse(event.detail); } catch { return; }
    if (msg.type === 'hello') {
      const {psDb, psSettings} = await chrome.storage.local.get(['psDb', 'psSettings']);
      send({type: 'hello', db: psDb || {}, settings: psSettings || {}});
    } else if (msg.type === 'learn') {
      update('psDb', db => ({...db, [msg.key]: msg.answer}));
    } else if (msg.type === 'settings') {
      update('psSettings', old => ({...old, ...msg.settings}));
    } else if (msg.type === 'stats') {
      update('psStats', old => {
        const s = {found: 0, fromDb: 0, fromAi: 0, learned: 0, ...old};
        for (const k of ['found', 'fromDb', 'fromAi', 'learned']) s[k] += msg[k] || 0;
        return s;
      });
    } else if (msg.type === 'ask') {
      const reply = await chrome.runtime.sendMessage({type: 'claude', system: msg.system, content: msg.content, maxTokens: 200})
        .catch(e => ({ok: false, error: e.message}));
      send({type: 'answer', id: msg.id, ...reply});
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.psSettings) send({type: 'settings', settings: changes.psSettings.newValue || {}});
  });
})();
