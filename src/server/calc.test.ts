import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Il database usa DATA_DIR al momento dell'import: lo puntiamo a una cartella temporanea.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orelavoro-test-'));
process.env.APP_TZ = 'Europe/Lisbon';

const { db } = await import('./db.ts');
const calc = await import('./calc.ts');
const { hashPin, verifyPin } = await import('./auth.ts');

let user: import('./db.ts').UserRow;

function addEntry(date: string, start: number, end: number | null) {
  db.prepare('INSERT INTO entries (user_id, date, start_min, end_min, note, created_at, updated_at) VALUES (?,?,?,?,?,0,0)').run(user.id, date, start, end, '');
}

before(() => {
  db.prepare("INSERT INTO users (username, display_name, pin_hash, created_at) VALUES ('t','Test','x',0)").run();
  user = db.prepare("SELECT * FROM users WHERE username = 't'").get() as unknown as import('./db.ts').UserRow;
});

test('due turni nello stesso giorno: si sommano, la pausa non conta', () => {
  addEntry('2026-03-10', 8 * 60, 12 * 60 + 30); // 4:30
  addEntry('2026-03-10', 13 * 60 + 30, 17 * 60); // 3:30
  const m = calc.buildMonth(user, '2026-03');
  const d = m.days.find((x) => x.date === '2026-03-10')!;
  assert.equal(d.minutes, 8 * 60);
  assert.equal(m.totals.minutes, 8 * 60);
  assert.equal(m.totals.workedDays, 1);
});

test('turno a cavallo della mezzanotte', () => {
  addEntry('2026-03-11', 22 * 60, 24 * 60 + 6 * 60);
  const m = calc.buildMonth(user, '2026-03');
  assert.equal(m.days.find((x) => x.date === '2026-03-11')!.minutes, 8 * 60);
});

test('turno aperto non conta nel totale ma viene segnalato', () => {
  addEntry('2026-03-12', 9 * 60, null);
  const m = calc.buildMonth(user, '2026-03');
  assert.equal(m.days.find((x) => x.date === '2026-03-12')!.minutes, 0);
  assert.equal(m.totals.openEntries, 1);
});

test('sovrapposizioni rifiutate, turni adiacenti ammessi', () => {
  assert.throws(() => calc.assertNoOverlap(user.id, '2026-03-10', 12 * 60, 14 * 60), /sovrappone/);
  assert.doesNotThrow(() => calc.assertNoOverlap(user.id, '2026-03-10', 12 * 60 + 30, 13 * 60 + 30));
  // a cavallo di mezzanotte: il 12 mattina non può iniziare dentro il turno notturno dell'11
  assert.throws(() => calc.assertNoOverlap(user.id, '2026-03-12', 1 * 60, 2 * 60), /sovrappone/);
});

test('giorni passati vuoti = da compilare; tipo di giornata li riempie', () => {
  const before = calc.buildMonth(user, '2026-03');
  assert.equal(before.days.find((x) => x.date === '2026-03-20')!.todo, true);
  db.prepare("INSERT INTO day_types (user_id, date, type) VALUES (?, '2026-03-20', 'ferie')").run(user.id);
  const after = calc.buildMonth(user, '2026-03');
  assert.equal(after.days.find((x) => x.date === '2026-03-20')!.todo, false);
  assert.equal(after.totals.byType.ferie, 1);
  assert.equal(after.totals.todoDays, before.totals.todoDays - 1);
});

test('paga oraria netta e lorda', () => {
  assert.deepEqual(calc.hourlyRates(120000, 150000, 16 * 60), { net: 75, gross: 93.75 });
  assert.deepEqual(calc.hourlyRates(120000, null, 16 * 60), { net: 75, gross: null });
  assert.deepEqual(calc.hourlyRates(120000, null, 0), { net: null, gross: null });
});

test('PIN: hash verificabile e non riutilizzabile con PIN diverso', () => {
  const h = hashPin('123456');
  assert.equal(verifyPin('123456', h), true);
  assert.equal(verifyPin('123457', h), false);
  assert.notEqual(hashPin('123456'), h); // sale diverso
});
