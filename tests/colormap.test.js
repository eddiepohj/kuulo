import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOPS, buildLut, dbToIndex } from '../js/colormap.js';

const lum = (r, g, b) => {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

test('five stops from the spec', () => assert.deepEqual(STOPS, ['#0F1113', '#2B1D3A', '#8A2F4A', '#E0702E', '#FFE2AE']));

test('LUT endpoints and alpha', () => {
  const l = buildLut();
  assert.equal(l.length, 1024);
  assert.deepEqual([...l.slice(0, 4)], [15, 17, 19, 255]);
  assert.deepEqual([...l.slice(1020, 1024)], [255, 226, 174, 255]);
});

test('lightness never decreases', () => {
  const l = buildLut();
  let prev = -1;
  for (let i = 0; i < 256; i++) {
    const y = lum(l[i * 4], l[i * 4 + 1], l[i * 4 + 2]);
    assert.ok(y >= prev - 1e-9, `index ${i}`);
    prev = y;
  }
});

test('dbToIndex clamps and maps', () => {
  assert.equal(dbToIndex(10), 0);
  assert.equal(dbToIndex(70), 255);
  assert.equal(dbToIndex(-5), 0);
  assert.equal(dbToIndex(99), 255);
  assert.equal(dbToIndex(40), 128);
  assert.equal(dbToIndex(NaN), 0);
  assert.equal(dbToIndex(-Infinity), 0);
  assert.equal(dbToIndex(-60, -90, -30), 128);
});
