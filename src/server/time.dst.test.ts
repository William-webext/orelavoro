import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, durationMinutes, epochToLocal, localToEpochMs, tzOffsetMinutes } from './time.ts';

const ZONES = ['Europe/Lisbon', 'Europe/Rome', 'America/New_York', 'Australia/Sydney', 'Pacific/Auckland', 'Asia/Kolkata', 'UTC'];
const MIN = 60000;

/** Giorni dell'anno in cui lo scarto UTC cambia (cambio d'ora). */
function transitionDays(tz: string, year: number): string[] {
  const days: string[] = [];
  let prev = tzOffsetMinutes(Date.UTC(year, 0, 1, 12), tz);
  for (let d = 1; d <= 366; d++) {
    const t = Date.UTC(year, 0, 1 + d, 12);
    if (new Date(t).getUTCFullYear() !== year) break;
    const off = tzOffsetMinutes(t, tz);
    if (off !== prev) days.push(new Date(t).toISOString().slice(0, 10));
    prev = off;
  }
  return days;
}

test('ora legale: ogni minuto reale attorno ai cambi d’ora fa andata e ritorno (7 fusi, 2024-2030)', () => {
  let checked = 0;
  let transitions = 0;
  for (const tz of ZONES) {
    for (let year = 2024; year <= 2030; year++) {
      for (const day of transitionDays(tz, year)) {
        transitions++;
        const start = localToEpochMs(addDays(day, -1), 0, tz) - 6 * 3600000;
        const end = localToEpochMs(addDays(day, 1), 0, tz) + 6 * 3600000;
        let lastLocalEpoch = -Infinity;
        for (let t = start; t < end; t += MIN) {
          const loc = epochToLocal(t, tz);
          const back = localToEpochMs(loc.date, loc.minutes, tz);
          const delta = Math.abs(back - t);
          // nell'ora ripetuta (autunno) lo stesso orario locale esiste due volte: si accetta l'altra occorrenza
          assert.ok(delta === 0 || delta === 3600000 || delta === 1800000, `${tz} ${new Date(t).toISOString()}: ritorno con scarto ${delta / MIN} min`);
          // l'orario locale mostrato non salta all'indietro se non nel cambio d'ora legale
          const localEpoch = Date.UTC(+loc.date.slice(0, 4), +loc.date.slice(5, 7) - 1, +loc.date.slice(8, 10)) + loc.minutes * MIN;
          assert.ok(localEpoch >= lastLocalEpoch - 3600000, `${tz}: orario locale torna indietro di più di un'ora`);
          lastLocalEpoch = localEpoch;
          checked++;
        }
      }
    }
  }
  assert.ok(transitions >= 40, `attesi molti cambi d'ora, trovati ${transitions}`);
  assert.ok(checked > 100000);
});

test('ora legale: le durate dei turni sono quelle reali', () => {
  // primavera Lisbona (29/03/2026): 00:00 → 06:00 locali sono 5 ore; autunno (25/10/2026): 7 ore
  assert.equal(durationMinutes('2026-03-29', 0, 360, 'Europe/Lisbon'), 300);
  assert.equal(durationMinutes('2026-10-25', 0, 360, 'Europe/Lisbon'), 420);
  // turno notturno a cavallo del cambio: 22:00 del giorno prima → 06:00
  assert.equal(durationMinutes('2026-03-28', 22 * 60, 24 * 60 + 6 * 60, 'Europe/Lisbon'), 420);
  assert.equal(durationMinutes('2026-10-24', 22 * 60, 24 * 60 + 6 * 60, 'Europe/Lisbon'), 540);
  // Roma e New York: stesso principio in date diverse
  assert.equal(durationMinutes('2026-03-29', 0, 360, 'Europe/Rome'), 300);
  assert.equal(durationMinutes('2026-11-01', 0, 360, 'America/New_York'), 420);
  // un fuso senza ora legale non cambia mai
  assert.equal(durationMinutes('2026-03-29', 0, 360, 'Asia/Kolkata'), 360);
});

test('ora legale: orari locali inesistenti (salto in avanti) non fanno errori e restano nello stesso giorno', () => {
  for (const [day, tz] of [['2026-03-29', 'Europe/Lisbon'], ['2026-03-29', 'Europe/Rome'], ['2026-03-08', 'America/New_York']] as const) {
    for (let m = 0; m < 1440; m++) {
      const t = localToEpochMs(day, m, tz);
      const loc = epochToLocal(t, tz);
      assert.equal(loc.date, day, `${tz} ${day} minuto ${m}`);
      assert.ok(Math.abs(loc.minutes - m) <= 60);
    }
  }
});
