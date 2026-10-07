// Persistent settings: per-field validation, load/save through an injected storage, and a tiny store.
// Pure: touches storage only through the object passed in. No DOM globals.

export const STORAGE_KEY = 'kuulo.v1.settings';

export function defaults() {
  return {
    offsetDb: null,
    calMethod: null,
    calibratedAt: null,
    floorDbfs: null,
    meter: { weighting: 'A', response: 'F' },
    spectrum: { view: 'fall', res: 3, weighting: 'A' },
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finiteIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const oneOf = (v, list) => (list.includes(v) ? v : undefined);

export function parseSettings(text) {
  const d = defaults();
  let raw;
  try { raw = JSON.parse(text); } catch { return d; }
  if (!isObj(raw)) return d;

  const out = d;
  if (finiteIn(raw.offsetDb, 0, 200)) out.offsetDb = raw.offsetDb;
  out.calMethod = oneOf(raw.calMethod, ['reference', 'quiet', 'manual']) ?? null;
  if (typeof raw.calibratedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.calibratedAt)) out.calibratedAt = raw.calibratedAt;
  if (finiteIn(raw.floorDbfs, -160, 0)) out.floorDbfs = raw.floorDbfs;

  const m = isObj(raw.meter) ? raw.meter : {};
  out.meter.weighting = oneOf(m.weighting, ['A', 'C', 'Z']) ?? out.meter.weighting;
  out.meter.response = oneOf(m.response, ['F', 'S']) ?? out.meter.response;

  const sp = isObj(raw.spectrum) ? raw.spectrum : {};
  out.spectrum.view = oneOf(sp.view, ['fall', 'bars']) ?? out.spectrum.view;
  out.spectrum.res = oneOf(sp.res, [3, 6]) ?? out.spectrum.res;
  out.spectrum.weighting = oneOf(sp.weighting, ['A', 'C', 'Z']) ?? out.spectrum.weighting;
  return out;
}

export function loadSettings(storage) {
  try { return parseSettings(storage.getItem(STORAGE_KEY)); } catch { return defaults(); }
}

export function saveSettings(storage, s) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(s)); return true; } catch { return false; }
}

const clone = (s) => JSON.parse(JSON.stringify(s));

export function createStore(storage) {
  let current = loadSettings(storage);
  const subs = new Set();
  return {
    get: () => clone(current),
    update(fn) {
      const draft = clone(current);
      fn(draft);
      current = parseSettings(JSON.stringify(draft));
      saveSettings(storage, current);
      for (const cb of [...subs]) cb(clone(current));
    },
    subscribe(cb) {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
  };
}
