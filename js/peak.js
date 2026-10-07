// Spectrum peak finder with parabolic interpolation, and note-name helpers.

const MINUS = '−';
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLOOR_DB = -200;

let scratch = new Float32Array(0); // reused between calls for the median

/**
 * Strongest weighted bin in [minHz, maxHz], refined by parabolic interpolation.
 * Returns null unless it stands at least minProminence dB above the median
 * weighted bin in range. Non-finite bins (and weights) count as −200 dB.
 */
export function findPeak(binsDb, {
  sampleRate, fftSize, minHz = 25, maxHz = 16000, weightDb = () => 0, minProminence = 10,
}) {
  const n = binsDb.length;
  const binHz = sampleRate / fftSize;
  const kLo = Math.max(1, Math.ceil(minHz / binHz));
  const kHi = Math.min(n - 2, Math.floor(maxHz / binHz));
  const count = kHi - kLo + 1;
  if (!(count > 0)) return null;

  const weighted = (k) => {
    const v = binsDb[k] + weightDb(k * binHz);
    return Number.isFinite(v) ? v : FLOOR_DB;
  };

  if (scratch.length < count) scratch = new Float32Array(count);
  const vals = scratch.subarray(0, count);
  let best = -Infinity, bestK = -1;
  for (let k = kLo; k <= kHi; k++) {
    const v = weighted(k);
    vals[k - kLo] = v;
    if (v > best) { best = v; bestK = k; }
  }
  if (bestK < 0) return null;

  vals.sort();
  const mid = count >> 1;
  const median = count % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  if (!(best - median >= minProminence)) return null;

  const a = weighted(bestK - 1), b = best, g = weighted(bestK + 1);
  const denom = a - 2 * b + g;
  let delta = denom < 0 ? (0.5 * (a - g)) / denom : 0;
  if (!Number.isFinite(delta)) delta = 0;
  delta = Math.max(-0.5, Math.min(0.5, delta));
  return { hz: (bestK + delta) * binHz, db: b - 0.25 * (a - g) * delta };
}

/** Nearest equal-tempered note (A4 = 440 Hz) and cents offset in [−50, 50]. */
export function noteName(hz) {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const n = Math.round(midi);
  const cents = Math.round((midi - n) * 100) + 0; // + 0 turns −0 into 0
  const octave = Math.floor(n / 12) - 1;
  return { name: NAMES[((n % 12) + 12) % 12] + octave, cents };
}

export function formatHz(hz) {
  const r = Math.round(hz);
  return r < 1000 ? `${r} Hz` : `${(hz / 1000).toFixed(2)} kHz`;
}

export function formatNote(hz) {
  const { name, cents } = noteName(hz);
  return `≈ ${name} ${cents < 0 ? MINUS : '+'}${Math.abs(cents)} ct`;
}
