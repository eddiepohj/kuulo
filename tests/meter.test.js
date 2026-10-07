import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_DBFS, toDbfs, createMeterState, processBlock, readout, setResponse, resetStats } from '../js/meter-worklet.js';
import { design } from '../js/weighting.js';

const FS = 48000;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

function run(state, seconds, gen, t0 = 0) {
  const n = Math.round(seconds * FS);
  for (let i = 0; i < n; i += 128) {
    const blk = new Float32Array(128);
    for (let j = 0; j < 128; j++) blk[j] = gen((t0 + i + j) / FS);
    if (processBlock(state, blk)) readout(state);
  }
  return readout(state); // level at the end of the last processed block
}
const sine = (amp, f = 1000) => (t) => amp * Math.sin(2 * Math.PI * f * t);
const zMeter = (response = 'F') => createMeterState({ sampleRate: FS, sections: [], sectionsA: design('A', FS), response });

test('toDbfs: full-scale sine mean square 0.5 → 0 dBFS; zero → MIN_DBFS', () => {
  close(toDbfs(0.5), 0, 1e-9, 'fs sine');
  assert.equal(toDbfs(0), MIN_DBFS);
  assert.equal(toDbfs(-1), MIN_DBFS);
});

test('full-scale 1 kHz sine reads 0.0 dBFS, 0.1 amplitude reads −20.0', () => {
  close(run(zMeter(), 1, sine(1)).level, 0, 0.1, 'full scale');
  close(run(zMeter(), 1, sine(0.1)).level, -20, 0.1, '0.1 amp');
});

test('A-weighted 1 kHz reads the same as Z', () => {
  const s = createMeterState({ sampleRate: FS, sections: design('A', FS), sectionsA: design('A', FS), response: 'F' });
  close(run(s, 1, sine(0.1)).level, -20, 0.1, 'A 1k');
});

test('Leq of 1 s at amp 1 then 1 s at amp 0.1 is the energy average', () => {
  const s = zMeter();
  run(s, 1, sine(1));
  const r = run(s, 1, sine(0.1), FS);
  close(r.leq, 10 * Math.log10(2 * (0.5 + 0.005) / 2), 0.05, 'leq');
});

for (const [resp, rate] of [['F', 34.7], ['S', 4.3]]) {
  test(`${resp} decay rate is ${rate} dB/s within 5 %`, () => {
    const s = zMeter(resp);
    run(s, resp === 'F' ? 1 : 6, sine(1));
    const t1 = resp === 'F' ? 0.1 : 1, t2 = resp === 'F' ? 0.5 : 4; // stay above the −120 clamp
    const a = run(s, t1, () => 0).level;
    const b = run(s, t2 - t1, () => 0).level;
    const measured = (a - b) / (t2 - t1);
    assert.ok(Math.abs(measured - rate) / rate < 0.05, `measured ${measured}`);
  });
}

test('silence gives finite MIN_DBFS values, never -Infinity or NaN', () => {
  const r = run(zMeter(), 2, () => 0);
  for (const k of ['level', 'leq', 'max', 'min']) {
    assert.ok(Number.isFinite(r[k]), k);
    assert.equal(r[k], MIN_DBFS, k);
  }
});

test('Min ignores the first second (filter settling)', () => {
  const r = run(zMeter(), 2, sine(1));
  assert.ok(r.min > -0.5, `min ${r.min}`);
});

test('resetStats restarts Leq, Max and Min', () => {
  const s = zMeter();
  run(s, 1, sine(1));
  run(s, 1, sine(0.1)); // let the Fast level settle at −20 before resetting
  resetStats(s);
  const r = run(s, 2, sine(0.1));
  close(r.leq, -20, 0.1, 'leq after reset');
  close(r.max, -20, 0.3, 'max after reset');
});

test('clip flag at |x| ≥ 0.99, held for 1 s', () => {
  const s = zMeter();
  assert.equal(run(s, 0.2, sine(0.98)).clipped, false);
  assert.equal(run(s, 0.2, sine(1)).clipped, true);
  assert.equal(run(s, 0.5, () => 0).clipped, true);
  assert.equal(run(s, 0.6, () => 0).clipped, false);
});

test('secondLeq and secondLeqA appear once per second', () => {
  const s = zMeter();
  let seconds = 0;
  for (let i = 0; i < 2 * FS; i += 128) {
    const blk = new Float32Array(128).fill(0);
    for (let j = 0; j < 128; j++) blk[j] = 0.1 * Math.sin(2 * Math.PI * 1000 * (i + j) / FS);
    if (processBlock(s, blk)) {
      const r = readout(s);
      if (r.secondLeq !== undefined) {
        seconds++;
        close(r.secondLeq, -20, 0.2, 'secondLeq');
        close(r.secondLeqA, -20, 0.2, 'secondLeqA');
      }
    }
  }
  assert.equal(seconds, 2);
});

test('posts every ~50 ms', () => {
  const s = zMeter();
  let posts = 0;
  for (let i = 0; i < FS; i += 128) if (processBlock(s, new Float32Array(128))) { posts++; readout(s); }
  assert.ok(posts >= 19 && posts <= 22, `posts ${posts}`);
});

test('setResponse switches τ', () => {
  const s = zMeter('F');
  setResponse(s, 'S');
  run(s, 6, sine(1));
  const a = run(s, 1, () => 0).level;
  const b = run(s, 1, () => 0).level;
  close(a - b, 4.34, 0.25, 'slow decay per second');
});
