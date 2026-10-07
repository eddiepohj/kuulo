import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPeak, noteName, formatHz, formatNote } from '../js/peak.js';
import { curve } from '../js/weighting.js';

const FS = 48000, N = 16384, BINS = N / 2;
// Gaussian main lobe: parabolic in dB, so interpolation is exact.
function tone(hz, peakDb = -20, floor = -100, width = 1.5) {
  const k0 = hz * N / FS, b = new Float32Array(BINS);
  for (let k = 0; k < BINS; k++) b[k] = Math.max(floor, peakDb - 8.686 * ((k - k0) / width) ** 2 / 2);
  return b;
}

test('finds a 1250 Hz tone within 1 Hz', () => {
  const p = findPeak(tone(1250), { sampleRate: FS, fftSize: N });
  assert.ok(Math.abs(p.hz - 1250) < 1, `hz ${p.hz}`);
  assert.ok(Math.abs(p.db - -20) < 0.5, `db ${p.db}`);
});

test('flat spectrum → null', () => {
  assert.equal(findPeak(new Float32Array(BINS).fill(-80), { sampleRate: FS, fftSize: N }), null);
});

test('silence with -Infinity bins → null, no throw', () => {
  assert.equal(findPeak(new Float32Array(BINS).fill(-Infinity), { sampleRate: FS, fftSize: N }), null);
});

test('ignores peaks outside 25 Hz–16 kHz', () => {
  assert.equal(findPeak(tone(18000), { sampleRate: FS, fftSize: N }), null);
});

test('weighting is applied before picking the peak', () => {
  const a = tone(50, -12), b = tone(1000, -20);
  const both = a.map((v, i) => Math.max(v, b[i]));
  const z = findPeak(both, { sampleRate: FS, fftSize: N });
  const w = findPeak(both, { sampleRate: FS, fftSize: N, weightDb: (f) => curve('A', f) });
  assert.ok(Math.abs(z.hz - 50) < 2);
  assert.ok(Math.abs(w.hz - 1000) < 1);
});

test('note names', () => {
  assert.deepEqual(noteName(440), { name: 'A4', cents: 0 });
  assert.deepEqual(noteName(261.6256), { name: 'C4', cents: 0 });
  assert.equal(noteName(1250).name, 'D♯6');
  assert.equal(noteName(1250).cents, 8);
});

test('formatting', () => {
  assert.equal(formatHz(440.4), '440 Hz');
  assert.equal(formatHz(1250), '1.25 kHz');
  assert.equal(formatNote(440), '≈ A4 +0 ct');
  assert.equal(formatNote(1250), '≈ D♯6 +8 ct');
  assert.equal(formatNote(1200), '≈ D6 +37 ct');
  assert.equal(formatNote(1170), '≈ D6 −7 ct');
});
