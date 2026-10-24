import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  addMonths,
  durationMinutes,
  epochToLocal,
  fmtClock,
  fmtDuration,
  isValidDate,
  localToEpochMs,
  monthDays,
  parseHM,
  weekday,
} from './time.ts';

const TZ = 'Europe/Lisbon';

test('durata semplice nello stesso giorno', () => {
  assert.equal(durationMinutes('2026-10-10', 8 * 60, 12 * 60 + 30, TZ), 270);
});

test('turno a cavallo della mezzanotte', () => {
  assert.equal(durationMinutes('2026-10-10', 22 * 60, 24 * 60 + 6 * 60, TZ), 8 * 60);
});

test('cambio ora legale primaverile (29 marzo 2026, 01:00 -> 02:00)', () => {
  // 00:00 -> 06:00 locali: in realtà 5 ore
  assert.equal(durationMinutes('2026-03-29', 0, 6 * 60, TZ), 5 * 60);
});

test('cambio ora legale autunnale (25 ottobre 2026, 02:00 -> 01:00)', () => {
  // 00:00 -> 06:00 locali: in realtà 7 ore
  assert.equal(durationMinutes('2026-10-25', 0, 6 * 60, TZ), 7 * 60);
});

test('andata e ritorno epoch <-> locale', () => {
  const t = localToEpochMs('2026-07-15', 9 * 60 + 5, TZ);
  assert.deepEqual(epochToLocal(t, TZ), { date: '2026-07-15', minutes: 545 });
  // luglio a Lisbona = UTC+1
  assert.equal(new Date(t).toISOString(), '2026-07-15T08:05:00.000Z');
});

test('date e mesi', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(monthDays('2028-02').length, 29);
  assert.equal(weekday('2026-10-24'), 6);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-02-28'), true);
});

test('formattazione', () => {
  assert.equal(parseHM('08:05'), 485);
  assert.equal(parseHM('24:00'), null);
  assert.equal(fmtClock(1500), '01:00');
  assert.equal(fmtDuration(485), '8:05');
});
