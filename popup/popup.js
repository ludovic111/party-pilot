/* Toolbar popup: same settings as the in-game panel, plus lifetime stats. */
const DEFAULTS = {enabled: true, mode: 'instant', wpm: 300, reactionMs: 0};
const $ = id => document.getElementById(id);
let settings = {...DEFAULTS}, stats = {};

function render() {
  $('pill').textContent = settings.enabled ? 'ACTIF' : 'PAUSE';
  $('pill').classList.toggle('on', settings.enabled);
  for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('sel', b.dataset.mode === settings.mode);
  $('wpmRow').hidden = settings.mode !== 'human';
  $('wpm').value = settings.wpm;
  $('reactionMs').value = settings.reactionMs;
  $('wpmVal').textContent = `${settings.wpm} WPM`;
  $('reactVal').textContent = settings.reactionMs ? `${settings.reactionMs} ms` : '0 ms (immédiat)';
  $('toggle').textContent = settings.enabled ? 'Mettre en pause' : 'Reprendre';
  $('toggle').classList.toggle('off', !settings.enabled);
  $('words').textContent = (stats.words || 0).toLocaleString('fr-CH');
  $('lives').textContent = (stats.lives || 0).toLocaleString('fr-CH');
  $('letters').textContent = (stats.letters || 0).toLocaleString('fr-CH');
  $('best').textContent = stats.best == null ? '–' : `${stats.best} ms`;
}
async function load() {
  const stored = await chrome.storage.local.get(['settings', 'stats']);
  settings = {...DEFAULTS, ...stored.settings};
  stats = stored.stats || {};
  render();
}
async function save(patch) {
  const {settings: stored} = await chrome.storage.local.get('settings');
  settings = {...DEFAULTS, ...stored, ...patch};
  await chrome.storage.local.set({settings});
}

for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => save({mode: b.dataset.mode}));
for (const id of ['wpm', 'reactionMs']) {
  $(id).addEventListener('input', () => { settings[id] = Number($(id).value); render(); });
  $(id).addEventListener('change', () => save({[id]: Number($(id).value)}));
}
$('toggle').addEventListener('click', () => save({enabled: !settings.enabled}));
$('reset').addEventListener('click', () => chrome.storage.local.remove('stats'));
chrome.storage.onChanged.addListener(load);
load();
