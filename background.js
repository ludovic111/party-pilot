/* Service worker: the one place that talks to the Claude API (PopSauce and Krillion helpers). */
// Haiku: answers are short facts, and every call should cost a fraction of a cent.
const AI_DEFAULTS = {baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-haiku-5-5'};
let localKey; // optional ai-key.local.json next to the manifest (gitignored): {apiKey, model?, baseUrl?}

async function aiSettings() {
  localKey ??= await fetch(chrome.runtime.getURL('ai-key.local.json')).then(r => r.json()).catch(() => ({}));
  const {ai} = await chrome.storage.local.get('ai');
  const merged = {...AI_DEFAULTS, ...localKey};
  for (const [k, v] of Object.entries(ai || {})) if (v) merged[k] = v;
  return merged;
}

// content: Messages API user content (string or blocks, images included). Returns the reply text.
async function askClaude({system, content, maxTokens = 400}) {
  const ai = await aiSettings();
  if (!ai.apiKey) throw new Error('Aucune clé API Claude (popup → IA)');
  const body = {
    model: ai.model,
    max_tokens: maxTokens,
    system,
    messages: [{role: 'user', content}],
    output_config: {effort: 'low'}, // answers are short facts: depth costs seconds we don't have
  };
  // Haiku accepts thinking off at low effort; otherwise thinking can eat the whole small token budget.
  if (ai.model.startsWith('claude-haiku')) body.thinking = {type: 'disabled'};
  const started = performance.now();
  const res = await fetch(`${ai.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': ai.apiKey, 'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true', // the key stays on this machine; the request comes from the extension
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  if (data.stop_reason === 'refusal') throw new Error('Refus du modèle');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return {text, ms: Math.round(performance.now() - started), model: data.model};
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'claude') return false;
  askClaude(msg).then(r => reply({ok: true, ...r}), e => reply({ok: false, error: e.message}));
  return true; // async reply
});
