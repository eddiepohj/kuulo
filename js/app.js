// App shell: tabs, Start overlay, lifecycle (stop the mic when hidden), settings wiring, service worker.

import { createStore } from './settings.js';
import * as audio from './audio.js';
import * as meterScreen from './ui-meter.js';
import * as spectrumScreen from './ui-spectrum.js';
import * as calibrateScreen from './ui-calibrate.js';

const DEFAULT_NOTE = 'Uses the microphone. Nothing is recorded or sent.';
const MESSAGES = {
  denied: 'Microphone access is off. Open iOS Settings › Safari › Microphone (or Settings › kuulo if installed) and allow it, then tap again.',
  unsupported: 'This browser cannot measure sound (needs microphone access over HTTPS and AudioWorklet).',
};

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

function pickStorage() {
  try {
    const s = window.localStorage;
    s.getItem('kuulo.probe');
    return s;
  } catch {
    return memoryStorage();
  }
}

const store = createStore(pickStorage());

// Settings -> audio. Non-throwing: a throwing subscriber would abort the ones after it.
let applied = { weighting: store.get().meter.weighting, response: store.get().meter.response };
store.subscribe((s) => {
  try {
    if (s.meter.weighting !== applied.weighting) audio.setWeighting(s.meter.weighting);
    if (s.meter.response !== applied.response) audio.setResponse(s.meter.response);
    applied = { weighting: s.meter.weighting, response: s.meter.response };
  } catch (e) {
    console.error(e);
  }
});

// Screens
const screens = {
  meter: { mod: meterScreen, section: document.getElementById('screen-meter') },
  spectrum: { mod: spectrumScreen, section: document.getElementById('screen-spectrum') },
  calibrate: { mod: calibrateScreen, section: document.getElementById('screen-calibrate') },
};
for (const s of Object.values(screens)) s.ctl = s.mod.init(s.section, { store, audio });

const tabButtons = [...document.querySelectorAll('.tabbar [data-tab]')];
let activeTab = null;
function showTab(name) {
  if (name === activeTab) return;
  if (activeTab) {
    screens[activeTab].section.classList.remove('active');
    screens[activeTab].ctl.hide();
  }
  activeTab = name;
  screens[name].section.classList.add('active');
  screens[name].ctl.show();
  for (const b of tabButtons) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
}
for (const b of tabButtons) b.addEventListener('click', () => showTab(b.dataset.tab));
// Screens can ask for another tab (e.g. the Meter's CAL pill opens Calibrate).
document.addEventListener('kuulo:tab', (e) => { if (screens[e.detail]) showTab(e.detail); });
showTab('meter');

// Start overlay
const overlay = document.getElementById('start');
const startBtn = document.getElementById('start-btn');
const startMsg = document.getElementById('start-msg');
let epoch = 0; // bumped when the page goes to the background; stale start results are ignored
let starting = false;
let wakeLock = null;

function setNote(text, isError) {
  startMsg.textContent = text;
  startMsg.classList.toggle('error', !!isError);
}

function showOverlay() {
  setNote(DEFAULT_NOTE, false);
  startBtn.disabled = false;
  overlay.hidden = false;
}

function requestWake() {
  if (wakeLock || !navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then((lock) => {
    if (document.hidden || !audio.running()) { lock.release().catch(() => {}); return; }
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
  }).catch(() => { /* not supported or refused: ignore */ });
}

function releaseWake() {
  const lock = wakeLock;
  wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

function onTap() {
  if (starting) return;
  starting = true;
  startBtn.disabled = true;
  const mine = epoch;
  // audio.start creates and resumes the AudioContext synchronously, inside this tap.
  audio.start(store.get().meter).then(
    () => {
      if (mine !== epoch) return;
      starting = false;
      overlay.hidden = true;
      requestWake();
    },
    (err) => {
      if (mine !== epoch) return;
      starting = false;
      startBtn.disabled = false;
      const msg = MESSAGES[err && err.code] || `Could not start the microphone: ${err && err.message}`;
      setNote(msg, true);
    },
  );
}
startBtn.addEventListener('click', onTap);

function toBackground() {
  epoch++;
  starting = false;
  audio.stop();
  releaseWake();
  showOverlay();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) toBackground();
  else if (audio.running()) requestWake();
});
window.addEventListener('pagehide', toBackground);

// Offline shell. Skipped on localhost so development never sees a stale cache.
if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  navigator.serviceWorker?.register('sw.js').catch(() => {});
}
