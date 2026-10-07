// Calibration maths, level labels and small formatting helpers. Pure; no DOM globals.
// Numbers are returned as numbers: the on-screen minus sign (U+2212) is the UI helpers' job.

export const QUIET_ROOM_DB = 25.0;
export const UNCAL_NUDGE_BASE = 100.0;

export const round1 = (x) => Math.round(x * 10) / 10;

export function energyMean(dbs) {
  if (!dbs.length) return null;
  const mean = dbs.reduce((a, v) => a + 10 ** (v / 10), 0) / dbs.length;
  return 10 * Math.log10(mean);
}

export const offsetFromReference = (refDb, phoneLeqDbfs) => round1(refDb - phoneLeqDbfs);
export const offsetFromQuietRoom = (phoneLeqDbfs) => round1(QUIET_ROOM_DB - phoneLeqDbfs);
export const nudge = (offsetDb, steps) => round1((offsetDb ?? UNCAL_NUDGE_BASE) + 0.5 * steps);

export function parseReading(text) {
  const t = String(text ?? '').trim();
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return { error: 'Enter a number' };
  const value = Number(t.replace(',', '.'));
  if (!Number.isFinite(value)) return { error: 'Enter a number' };
  if (value < 20 || value > 140) return { error: 'Use a reading between 20 and 140 dB' };
  return { value };
}

export const displayLevel = (dbfs, offsetDb) => (offsetDb == null ? dbfs : dbfs + offsetDb);
export const unitLabel = (weighting, offsetDb) => (offsetDb == null ? 'dBFS' : `dB(${weighting})`);
export const floorDb = (s) => (s.floorDbfs == null ? null : s.floorDbfs + (s.offsetDb ?? 0));
export const ceilingDb = (s) => s.offsetDb ?? 0;

export function describe(levelDbfs, s) {
  if (s.floorDbfs != null && levelDbfs < s.floorDbfs + 3) return 'Near mic floor';
  if (s.offsetDb == null) return 'Uncalibrated: relative level';
  const db = levelDbfs + s.offsetDb;
  if (db < 40) return 'Quiet room';
  if (db < 55) return 'Calm office, fridge hum';
  if (db < 70) return 'Conversation';
  if (db < 85) return 'Busy street, loud TV';
  return 'Loud: limit long exposure';
}

export function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function todayIso(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function sourceText(s) {
  if (s.offsetDb == null) return 'Not calibrated: levels in dBFS';
  const when = s.calibratedAt ? `, ${formatDate(s.calibratedAt)}` : '';
  if (s.calMethod === 'reference') return `Set from reference meter${when}`;
  if (s.calMethod === 'quiet') return `Rough: quiet room${when} (±10 dB)`;
  return `Adjusted by hand${when}`;
}
