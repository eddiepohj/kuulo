// Audio graph: one AudioContext, one meter worklet, one analyser, one silent sink.
// Nothing is created at import time. The mic (or the desktop test tone) is opened on every start().
//
// Graph:  source -> meter (worklet) -> sink(gain 0) -> destination
//                -> analyser        -> sink

import { design } from './weighting.js';

const FFT_SIZE = 16384;
const WORKLET_URL = new URL('./meter-worklet.js', import.meta.url).href;

let ctx = null;
let node = null;
let analyser = null;
let sink = null;
let graphPromise = null; // single in-flight/finished graph build
let startPromise = null; // single in-flight/finished start (cleared by stop())
let generation = 0; // bumped by every start() and stop(); lets a stale start tear itself down
let isRunning = false;
let source = null; // current source node (MediaStreamAudioSourceNode or tone mixer)
let stream = null;
let tone = null; // { osc, gains, noise, timer }
let lastInfo = { sampleRate: null, source: null, trackSettings: null };
let weighting = 'A';
let response = 'F';
const meterSubs = new Set();
const sourceSubs = new Set();

function fail(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

function mapError(err) {
  if (err && err.code) return err;
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return fail('denied', (err && err.message) || 'Microphone access denied', err);
  }
  return fail('failed', (err && err.message) || String(err), err);
}

const wantsTone = () => typeof location !== 'undefined' && /[?&]tone(?:[=&]|$)/.test(location.search);

function post(msg) {
  if (node) node.port.postMessage(msg);
}

function emit(set, ...args) {
  for (const cb of [...set]) {
    try { cb(...args); } catch (e) { console.error(e); }
  }
}

// Must run synchronously in the tap handler's call path (before any await).
function createContext() {
  if (ctx) return;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  ctx = new AC({ latencyHint: 'interactive' });
}

function ensureGraph() {
  if (graphPromise) return graphPromise;
  createContext();
  const c = ctx;
  graphPromise = (async () => {
    await c.audioWorklet.addModule(WORKLET_URL);
    const sr = c.sampleRate;
    node = new AudioWorkletNode(c, 'kuulo-meter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sections: design(weighting, sr), sectionsA: design('A', sr), response },
    });
    node.port.onmessage = (e) => emit(meterSubs, e.data);
    analyser = c.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    sink = c.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    analyser.connect(sink);
    sink.connect(c.destination);
  })();
  graphPromise.catch(() => {
    // Let the next start() try again from scratch.
    graphPromise = null;
    node = null;
    analyser = null;
    sink = null;
    try { c.close(); } catch { /* ignore */ }
    if (ctx === c) ctx = null;
  });
  return graphPromise;
}

function openMic() {
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

function makeTone(c) {
  const mixer = c.createGain();
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 440;
  const oscGain = c.createGain();
  oscGain.gain.value = 0.1;
  osc.connect(oscGain).connect(mixer);

  const len = c.sampleRate * 2;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const noise = c.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0.003;
  noise.connect(noiseGain).connect(mixer);

  osc.start();
  noise.start();
  let hi = false;
  const timer = setInterval(() => {
    hi = !hi;
    osc.frequency.setValueAtTime(hi ? 1250 : 440, c.currentTime);
  }, 2000);
  return { mixer, osc, noise, timer, nodes: [oscGain, noiseGain] };
}

function teardownTone() {
  if (!tone) return;
  clearInterval(tone.timer);
  for (const n of [tone.osc, tone.noise]) {
    try { n.stop(); } catch { /* already stopped */ }
  }
  for (const n of [tone.osc, tone.noise, ...tone.nodes, tone.mixer]) {
    try { n.disconnect(); } catch { /* ignore */ }
  }
  tone = null;
}

function stopStream(s) {
  if (!s) return;
  for (const t of s.getTracks()) {
    try { t.stop(); } catch { /* ignore */ }
  }
}

async function doStart(opts, gen) {
  const useTone = wantsTone();
  const hasWorklet = !!(globalThis.AudioContext || globalThis.webkitAudioContext)
    && typeof globalThis.AudioWorkletNode !== 'undefined';
  if (!hasWorklet || (!useTone && !(typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia))) {
    throw fail('unsupported', 'AudioWorklet or microphone access is not available');
  }
  // Posts to the worklet only when the value differs (a sections change resets the filter memory).
  if (opts && ['A', 'C', 'Z'].includes(opts.weighting) && opts.weighting !== weighting) setWeighting(opts.weighting);
  if (opts && ['F', 'S'].includes(opts.response) && opts.response !== response) setResponse(opts.response);

  // Everything below up to the first await runs inside the user's tap.
  let graphP;
  try { graphP = ensureGraph(); } catch (e) { throw mapError(e); }
  const c = ctx;
  const resumeP = Promise.resolve(c.resume()).catch(() => {});
  const micP = useTone ? Promise.resolve(null) : openMic();

  const [g, m] = await Promise.allSettled([graphP, micP]);
  await resumeP;
  const mic = m.status === 'fulfilled' ? m.value : null;
  if (g.status === 'rejected' || m.status === 'rejected' || gen !== generation) {
    stopStream(mic);
    // A failed latest start leaves nothing using the context. (A stale start must not touch it: stop() suspended it.)
    if (gen === generation) Promise.resolve(c.suspend()).catch(() => {});
    if (g.status === 'rejected') throw mapError(g.reason);
    if (m.status === 'rejected') throw mapError(m.reason);
    throw fail('failed', 'Start cancelled');
  }

  // Synchronous from here: no await between connecting the source and publishing state.
  let trackSettings = null;
  if (useTone) {
    tone = makeTone(c);
    source = tone.mixer;
  } else {
    stream = mic;
    source = c.createMediaStreamSource(mic);
    const track = mic.getAudioTracks()[0];
    trackSettings = track && track.getSettings ? track.getSettings() : null;
  }
  source.connect(node);
  source.connect(analyser);
  isRunning = true;
  lastInfo = { sampleRate: c.sampleRate, source: useTone ? 'tone' : 'mic', trackSettings };
  emit(sourceSubs, source, c);
  return { ...lastInfo };
}

export function start(opts = {}) {
  if (startPromise) return startPromise;
  const gen = ++generation;
  const p = doStart(opts, gen);
  startPromise = p;
  p.catch(() => {
    if (startPromise === p) startPromise = null;
  });
  return p;
}

export function stop() {
  generation++; // cancels a start still waiting on the mic or the worklet
  startPromise = null;
  if (!isRunning) {
    // A start may be in flight (it will see the new generation and cancel); make sure the context is not left running.
    if (ctx) Promise.resolve(ctx.suspend()).catch(() => {});
    return;
  }
  isRunning = false;
  stopStream(stream);
  stream = null;
  if (source) {
    try { source.disconnect(); } catch { /* ignore */ }
    source = null;
  }
  teardownTone();
  try { Promise.resolve(ctx && ctx.suspend()).catch(() => {}); } catch { /* ignore */ }
}

export const running = () => isRunning;
export const info = () => ({ ...lastInfo });
export const getContext = () => ctx;
export const getAnalyser = () => analyser;

export function onMeter(cb) {
  meterSubs.add(cb);
  return () => { meterSubs.delete(cb); };
}

export function onSource(cb) {
  sourceSubs.add(cb);
  return () => { sourceSubs.delete(cb); };
}

export function setWeighting(w) {
  weighting = w;
  if (node && ctx) post({ type: 'sections', sections: design(w, ctx.sampleRate) });
}

export function setResponse(r) {
  response = r;
  post({ type: 'response', response: r });
}

export function resetMeter() {
  post({ type: 'reset' });
}
