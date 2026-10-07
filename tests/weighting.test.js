import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curve, design, responseDb } from '../js/weighting.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

test('analytic curves are 0 dB at 1 kHz and match IEC table values', () => {
  close(curve('A', 1000), 0, 0.01, 'A 1k');
  close(curve('C', 1000), 0, 0.01, 'C 1k');
  assert.equal(curve('Z', 1000), 0);
  // IEC 61672-1 nominal values
  // IEC table lists -39.4 for the exact 1/3-octave centre 10^1.5 = 31.62 Hz (nominal 31.5)
  close(curve('A', 10 ** 1.5), -39.4, 0.1, 'A 31.62');
  close(curve('A', 100), -19.1, 0.1, 'A 100');
  close(curve('A', 4000), 1.0, 0.1, 'A 4k');
  close(curve('A', 8000), -1.1, 0.1, 'A 8k');
  close(curve('C', 31.5), -3.0, 0.1, 'C 31.5');
  close(curve('C', 8000), -3.0, 0.1, 'C 8k');
});

const OCT3 = [31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
  1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000];

for (const fs of [48000, 44100]) {
  for (const type of ['A', 'C']) {
    test(`${type} biquads at ${fs} Hz match the curve within 0.5 dB, 31.5 Hz–8 kHz`, () => {
      const s = design(type, fs);
      for (const f of OCT3) close(responseDb(s, f, fs), curve(type, f), 0.5, `${type} ${f} Hz`);
    });
    test(`${type} biquads at ${fs} Hz stay within class 2 style limits up to 16 kHz`, () => {
      const s = design(type, fs);
      for (const [f, hi, lo] of [[10000, 2.0, -3.0], [12500, 3.0, -5.0], [16000, 3.5, -17.0]]) {
        const err = responseDb(s, f, fs) - curve(type, f);
        assert.ok(err <= hi && err >= lo, `${type} ${f} Hz error ${err.toFixed(2)} dB`);
      }
    });
  }
}

test('Z is an empty cascade with 0 dB response', () => {
  assert.deepEqual(design('Z', 48000), []);
  assert.equal(responseDb([], 1234, 48000), 0);
});

test('stable, finite and 0 dB at 1 kHz for 8–96 kHz sample rates', () => {
  for (const fs of [8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000]) {
    for (const type of ['A', 'C']) {
      const s = design(type, fs);
      for (const q of s) {
        for (const k of ['b0', 'b1', 'b2', 'a1', 'a2']) assert.ok(Number.isFinite(q[k]), `${type}@${fs} ${k}`);
        // poles of 1 + a1 z^-1 + a2 z^-2 inside the unit circle
        assert.ok(Math.abs(q.a2) < 1 && Math.abs(q.a1) < 1 + q.a2, `${type}@${fs} unstable`);
      }
      close(responseDb(s, 1000, fs), 0, 1e-6, `${type}@${fs} 1k`);
    }
  }
});
