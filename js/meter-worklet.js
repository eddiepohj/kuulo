// Level meter DSP and the AudioWorklet processor that runs it.
// Dual use: Node imports the named exports for tests; in the browser
// audioWorklet.addModule() loads this file and the guarded registerProcessor
// block below runs. No imports (worklet scope), no allocation per sample.

export const MIN_DBFS = -120;

const TAU = { F: 0.125, S: 1 };
const POST_SECONDS = 0.05;
const CLIP_LEVEL = 0.99;
const FLUSH_BELOW = 1e-20; // keeps the time-weighted value out of denormals

/** Mean square of a signal in sample units → dBFS (full-scale sine = 0 dBFS). */
export function toDbfs(meanSquare) {
  if (!(meanSquare > 0)) return MIN_DBFS;
  const db = 10 * Math.log10(2 * meanSquare);
  return db > MIN_DBFS ? db : MIN_DBFS;
}

function alphaFor(response, sampleRate) {
  const tau = TAU[response];
  if (tau === undefined) throw new Error(`Unknown response: ${response}`);
  return 1 - Math.exp(-1 / (tau * sampleRate));
}

// Flatten biquad objects into one coefficient array (b0 b1 b2 a1 a2 per section).
function flatten(sections) {
  const c = new Float64Array(sections.length * 5);
  for (let k = 0; k < sections.length; k++) {
    const q = sections[k];
    c[5 * k] = q.b0;
    c[5 * k + 1] = q.b1;
    c[5 * k + 2] = q.b2;
    c[5 * k + 3] = q.a1;
    c[5 * k + 4] = q.a2;
  }
  return c;
}

export function createMeterState({ sampleRate, sections, sectionsA, response }) {
  const state = {
    sampleRate,
    postSamples: Math.round(POST_SECONDS * sampleRate),
    response,
    alpha: alphaFor(response, sampleRate),
    coef: flatten(sections),
    mem: new Float64Array(sections.length * 4), // x1 x2 y1 y2 per section
    coefA: flatten(sectionsA),
    memA: new Float64Array(sectionsA.length * 4),
    ms: 0, // time-weighted mean square
    level: MIN_DBFS,
    sinceClip: sampleRate, // ≥ sampleRate means "no recent clip"
    sinceReadout: 0,
    secSum: 0,
    secSumA: 0,
    secN: 0,
    secondPending: false,
    secondLeq: MIN_DBFS,
    secondLeqA: MIN_DBFS,
    leqSum: 0,
    leqN: 0,
    max: MIN_DBFS,
    min: MIN_DBFS,
    hasMin: false,
    elapsed: 0,
  };
  return state;
}

export function setSections(state, sections) {
  state.coef = flatten(sections);
  state.mem = new Float64Array(sections.length * 4);
}

export function setResponse(state, response) {
  state.alpha = alphaFor(response, state.sampleRate);
  state.response = response;
}

export function resetStats(state) {
  state.leqSum = 0;
  state.leqN = 0;
  state.max = MIN_DBFS;
  state.min = MIN_DBFS;
  state.hasMin = false;
  state.elapsed = 0;
}

// Direct form I cascade over a flat coefficient/memory pair; no allocation.
function cascade(coef, mem, x) {
  let v = x;
  for (let k = 0, n = coef.length / 5; k < n; k++) {
    const c = 5 * k;
    const m = 4 * k;
    const out = coef[c] * v + coef[c + 1] * mem[m] + coef[c + 2] * mem[m + 1]
      - coef[c + 3] * mem[m + 2] - coef[c + 4] * mem[m + 3];
    mem[m + 1] = mem[m];
    mem[m] = v;
    mem[m + 3] = mem[m + 2];
    mem[m + 2] = out;
    v = out;
  }
  return v;
}

/**
 * Process one block. Returns true when a post is due: at least 50 ms since the
 * last readout(), or a 1 s period completed in this block.
 */
export function processBlock(state, input) {
  const fs = state.sampleRate;
  const alpha = state.alpha;
  let ms = state.ms;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    if (x >= CLIP_LEVEL || x <= -CLIP_LEVEL) state.sinceClip = 0;
    else if (state.sinceClip < fs) state.sinceClip++;

    const y = cascade(state.coef, state.mem, x);
    const yA = cascade(state.coefA, state.memA, x);
    const y2 = y * y;

    ms += (y2 - ms) * alpha;
    state.leqSum += y2;
    state.leqN++;
    state.secSum += y2;
    state.secSumA += yA * yA;
    if (++state.secN >= fs) {
      state.secondLeq = toDbfs(state.secSum / state.secN);
      state.secondLeqA = toDbfs(state.secSumA / state.secN);
      state.secondPending = true;
      state.secSum = 0;
      state.secSumA = 0;
      state.secN = 0;
    }
  }
  if (ms < FLUSH_BELOW) ms = 0;
  state.ms = ms;
  state.elapsed += input.length;
  state.sinceReadout += input.length;

  const level = toDbfs(ms);
  state.level = level;
  if (level > state.max) state.max = level;
  if (state.elapsed >= fs) {
    if (!state.hasMin || level < state.min) state.min = level;
    state.hasMin = true;
  }
  return state.secondPending || state.sinceReadout >= state.postSamples;
}

/** Snapshot in dBFS. secondLeq/secondLeqA appear once per completed second. */
export function readout(state) {
  const r = {
    level: state.level,
    leq: toDbfs(state.leqN > 0 ? state.leqSum / state.leqN : 0),
    max: state.max,
    min: state.hasMin ? state.min : MIN_DBFS,
    clipped: state.sinceClip < state.sampleRate,
  };
  if (state.secondPending) {
    r.secondLeq = state.secondLeq;
    r.secondLeqA = state.secondLeqA;
    state.secondPending = false;
  }
  state.sinceReadout = 0;
  return r;
}

if (typeof registerProcessor === 'function') {
  class KuuloMeter extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = options.processorOptions;
      this.state = createMeterState({
        sampleRate,
        sections: o.sections,
        sectionsA: o.sectionsA,
        response: o.response,
      });
      this.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'sections') setSections(this.state, m.sections);
        else if (m.type === 'response') setResponse(this.state, m.response);
        else if (m.type === 'reset') resetStats(this.state);
      };
    }

    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch && processBlock(this.state, ch)) this.port.postMessage(readout(this.state));
      return true; // output stays silent (zero-filled by the engine)
    }
  }
  registerProcessor('kuulo-meter', KuuloMeter);
}
