// A/C/Z frequency weighting: analytic IEC 61672 curves and a cascaded-biquad
// design for any sample rate. Pure module: no DOM, no imports.

const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;

const db = (x) => 20 * Math.log10(x);

/** Analytic weighting curve in dB, 0 dB at 1 kHz (IEC 61672 normalisation). */
export function curve(type, f) {
  if (type === 'Z') return 0;
  const f2 = f * f;
  const a1 = F1 * F1;
  const a4 = F4 * F4;
  if (type === 'C') {
    return db((a4 * f2) / ((f2 + a1) * (f2 + a4))) + 0.06;
  }
  if (type === 'A') {
    const r = (a4 * f2 * f2)
      / ((f2 + a1) * Math.sqrt((f2 + F2 * F2) * (f2 + F3 * F3)) * (f2 + a4));
    return db(r) + 2.0;
  }
  throw new Error(`Unknown weighting type: ${type}`);
}

// First-order sections as { n0, n1, d1 }: (n0 + n1 z^-1) / (1 + d1 z^-1).
function highpass(f, fs) {
  const w = 2 * Math.PI * f;
  const K = 2 * fs;
  const g = 1 / (K + w);
  return { n0: K * g, n1: -K * g, d1: -(K - w) * g };
}

function lowpassBilinear(f, fs) {
  const w = 2 * Math.PI * f;
  const K = 2 * fs;
  const g = 1 / (K + w);
  return { n0: w * g, n1: w * g, d1: -(K - w) * g };
}

function lowpassMatched(f, fs) {
  const p = Math.exp(-2 * Math.PI * f / fs);
  return { n0: 1 - p, n1: 0, d1: -p };
}

// Multiply two first-order sections into one biquad.
function biquad(x, y) {
  return {
    b0: x.n0 * y.n0,
    b1: x.n0 * y.n1 + x.n1 * y.n0,
    b2: x.n1 * y.n1,
    a1: x.d1 + y.d1,
    a2: x.d1 * y.d1,
  };
}

/**
 * Cascaded biquads approximating the weighting at `sampleRate`.
 * Difference equation: y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2 (a0 = 1).
 * Overall gain is set on the first section so the response at 1 kHz is 0 dB.
 */
export function design(type, sampleRate) {
  if (type === 'Z') return [];
  const fs = sampleRate;
  const hp1 = highpass(F1, fs);
  const lp4 = biquad(lowpassBilinear(F4, fs), lowpassMatched(F4, fs));
  let sections;
  if (type === 'A') {
    sections = [biquad(hp1, hp1), biquad(highpass(F2, fs), highpass(F3, fs)), lp4];
  } else if (type === 'C') {
    sections = [biquad(hp1, hp1), lp4];
  } else {
    throw new Error(`Unknown weighting type: ${type}`);
  }
  const g = 10 ** (-responseDb(sections, 1000, fs) / 20);
  sections[0].b0 *= g;
  sections[0].b1 *= g;
  sections[0].b2 *= g;
  return sections;
}

/** Magnitude of the biquad cascade at `f` in dB; an empty cascade is 0 dB. */
export function responseDb(sections, f, sampleRate) {
  const w = 2 * Math.PI * f / sampleRate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  let mag = 1;
  for (const q of sections) {
    const nr = q.b0 + q.b1 * c1 + q.b2 * c2;
    const ni = -(q.b1 * s1 + q.b2 * s2);
    const dr = 1 + q.a1 * c1 + q.a2 * c2;
    const di = -(q.a1 * s1 + q.a2 * s2);
    mag *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return db(mag);
}
