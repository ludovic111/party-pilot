/* Krillion helper, page world, document_start. Puffer Party only: forwards the room updates the page
   itself receives (party WebSocket, SSE fallback, join reply) to helper.js. Sends nothing anywhere. */
(() => {
  'use strict';
  if (globalThis.__krTap) return;
  globalThis.__krTap = true;
  const PARTY = /^https:\/\/party\.krillion\.io\//;
  const emit = msg => document.dispatchEvent(new CustomEvent('krhelper:tap', {detail: JSON.stringify(msg)}));

  const NativeWS = window.WebSocket;
  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget === window.WebSocket ? target : newTarget);
      if (PARTY.test(String(args[0]).replace(/^ws/, 'http'))) {
        ws.addEventListener('message', e => { if (typeof e.data === 'string' && !e.data.includes('"pong"')) emit({kind: 'ws', data: e.data}); });
      }
      return ws;
    },
  });

  const NativeES = window.EventSource;
  if (NativeES) {
    window.EventSource = new Proxy(NativeES, {
      construct(target, args, newTarget) {
        const es = Reflect.construct(target, args, newTarget === window.EventSource ? target : newTarget);
        if (/\/api\/party\/[^/]+\/stream/.test(String(args[0]))) es.addEventListener('room', e => emit({kind: 'room', data: e.data}));
        return es;
      },
    });
  }

  // The join reply carries our own player id, which the room state never marks.
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = nativeFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (/\/rooms\/[A-Za-z0-9]+\/join$|\/api\/party\/[^/]+\/join$|party\.krillion\.io\/rooms$/.test(url.split('?')[0])) {
      p.then(res => res.clone().json()).then(d => { if (d?.playerId) emit({kind: 'join', code: d.code, playerId: d.playerId}); }).catch(() => {});
    }
    return p;
  };
})();
