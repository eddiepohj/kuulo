import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, defaults, parseSettings, loadSettings, saveSettings, createStore } from '../js/settings.js';

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }; };
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };

test('key name', () => assert.equal(STORAGE_KEY, 'kuulo.v1.settings'));

test('null, garbage and non-object give defaults', () => {
  for (const t of [null, '', '{', 'null', '42', '"x"', '[]']) assert.deepEqual(parseSettings(t), defaults(), String(t));
});

test('valid settings round-trip', () => {
  const s = { offsetDb: 108, calMethod: 'reference', calibratedAt: '2026-10-07', floorDbfs: -77,
    meter: { weighting: 'C', response: 'S' }, spectrum: { view: 'bars', res: 6, weighting: 'Z' } };
  assert.deepEqual(parseSettings(JSON.stringify(s)), s);
});

test('bad fields fall back one by one, good siblings survive', () => {
  const s = parseSettings(JSON.stringify({ offsetDb: 'x', calMethod: 'guess', calibratedAt: '7.10.2026', floorDbfs: 5,
    meter: { weighting: 'B', response: 'S' }, spectrum: { view: 'fall', res: 12 } }));
  assert.equal(s.offsetDb, null);
  assert.equal(s.calMethod, null);
  assert.equal(s.calibratedAt, null);
  assert.equal(s.floorDbfs, null);
  assert.deepEqual(s.meter, { weighting: 'A', response: 'S' });
  assert.deepEqual(s.spectrum, { view: 'fall', res: 3, weighting: 'A' });
});

test('throwing storage: load gives defaults, save returns false', () => {
  assert.deepEqual(loadSettings(throwing), defaults());
  assert.equal(saveSettings(throwing, defaults()), false);
});

test('store updates, persists and notifies', () => {
  const st = memStorage();
  const store = createStore(st);
  let seen = null;
  store.subscribe((s) => { seen = s; });
  store.update((d) => { d.offsetDb = 101.5; d.meter.weighting = 'C'; });
  assert.equal(store.get().offsetDb, 101.5);
  assert.equal(seen.meter.weighting, 'C');
  assert.equal(JSON.parse(st._m.get(STORAGE_KEY)).offsetDb, 101.5);
  assert.equal(createStore(st).get().offsetDb, 101.5);
});

test('store rejects invalid updates via validation', () => {
  const store = createStore(memStorage());
  store.update((d) => { d.spectrum.res = 7; });
  assert.equal(store.get().spectrum.res, 3);
});
