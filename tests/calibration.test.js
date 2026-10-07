import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../js/calibration.js';
import { defaults } from '../js/settings.js';

const cal = (o) => ({ ...defaults(), ...o });

test('offset maths', () => {
  assert.equal(c.offsetFromReference(47.6, -60.4), 108);
  assert.equal(c.offsetFromQuietRoom(-80.2), 105.2);
  assert.equal(c.nudge(108, 1), 108.5);
  assert.equal(c.nudge(108, -3), 106.5);
  assert.equal(c.nudge(null, 1), 100.5);
});

test('energyMean is an energy average', () => {
  assert.ok(Math.abs(c.energyMean([60, 60]) - 60) < 1e-9);
  assert.ok(Math.abs(c.energyMean([60, 50]) - 57.4036) < 1e-3);
  assert.equal(c.energyMean([]), null);
});

test('parseReading accepts comma and dot decimals, rejects junk and out-of-range', () => {
  assert.deepEqual(c.parseReading('72,5'), { value: 72.5 });
  assert.deepEqual(c.parseReading(' 72.5 '), { value: 72.5 });
  assert.deepEqual(c.parseReading('60'), { value: 60 });
  for (const t of ['', '  ', 'abc', '7 2', '72,5,1']) assert.ok(c.parseReading(t).error, t);
  for (const t of ['5', '300', '-60']) assert.equal(c.parseReading(t).error, 'Use a reading between 20 and 140 dB', t);
});

test('display level, unit, floor and ceiling', () => {
  assert.equal(c.displayLevel(-60, null), -60);
  assert.equal(c.displayLevel(-60, 108), 48);
  assert.equal(c.unitLabel('A', null), 'dBFS');
  assert.equal(c.unitLabel('C', 108), 'dB(C)');
  assert.equal(c.floorDb(cal({ floorDbfs: -77, offsetDb: 108 })), 31);
  assert.equal(c.floorDb(cal({ floorDbfs: -77 })), -77);
  assert.equal(c.floorDb(cal({})), null);
  assert.equal(c.ceilingDb(cal({ offsetDb: 108 })), 108);
  assert.equal(c.ceilingDb(cal({})), 0);
});

test('describe thresholds', () => {
  const s = cal({ offsetDb: 100 });
  assert.equal(c.describe(-61, s), 'Quiet room');
  assert.equal(c.describe(-60, s), 'Calm office, fridge hum');
  assert.equal(c.describe(-46, s), 'Calm office, fridge hum');
  assert.equal(c.describe(-45, s), 'Conversation');
  assert.equal(c.describe(-30, s), 'Busy street, loud TV');
  assert.equal(c.describe(-15, s), 'Loud: limit long exposure');
  assert.equal(c.describe(-50, cal({})), 'Uncalibrated: relative level');
  assert.equal(c.describe(-75, cal({ offsetDb: 100, floorDbfs: -77 })), 'Near mic floor');
  assert.equal(c.describe(-74, cal({ offsetDb: 100, floorDbfs: -77 })), 'Quiet room');
});

test('dates and source text', () => {
  assert.equal(c.formatDate('2026-10-07'), '07.10.2026');
  assert.equal(c.todayIso(new Date(2026, 9, 7, 23, 30)), '2026-10-07');
  assert.equal(c.sourceText(cal({ offsetDb: 108, calMethod: 'reference', calibratedAt: '2026-10-07' })), 'Set from reference meter, 07.10.2026');
  assert.equal(c.sourceText(cal({ offsetDb: 105.2, calMethod: 'quiet', calibratedAt: '2026-10-07' })), 'Rough: quiet room, 07.10.2026 (±10 dB)');
  assert.equal(c.sourceText(cal({ offsetDb: 108.5, calMethod: 'manual', calibratedAt: '2026-10-07' })), 'Adjusted by hand, 07.10.2026');
  assert.equal(c.sourceText(cal({})), 'Not calibrated: levels in dBFS');
});
