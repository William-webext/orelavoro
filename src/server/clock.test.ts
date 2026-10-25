import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orelavoro-clock-'));
process.env.APP_TZ = 'Europe/Lisbon';

const { db } = await import('./db.ts');
const { applyClock } = await import('./clock.ts');
const { epochToLocal, fmtClock } = await import('./time.ts');

let user: import('./db.ts').UserRow;
const TZ = 'Europe/Lisbon';
const MIN = 60000;

before(() => {
  db.prepare("INSERT INTO users (username, display_name, pin_hash, created_at) VALUES ('c','Clock','x',0)").run();
  user = db.prepare("SELECT * FROM users WHERE username = 'c'").get() as unknown as import('./db.ts').UserRow;
});

function entries() {
  return db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY id').all(user.id) as unknown as import('./db.ts').EntryRow[];
}

test('timbratura in tempo reale: ingresso e uscita non sono "offline"', () => {
  const r = applyClock(user, 'in', { clientId: 'live-in-0001' });
  assert.equal(r.duplicate, false);
  assert.equal(r.entry!.offline, 0);
  // stesso minuto: l'uscita è rifiutata con messaggio chiaro
  assert.throws(() => applyClock(user, 'out', { clientId: 'live-out-001' }), /almeno un minuto/);
  db.prepare('DELETE FROM entries').run();
  db.prepare('DELETE FROM clock_log').run();
});

test('timbratura differita: usa l’ora indicata dal telefono e viene marcata offline', () => {
  const now = Date.now();
  const inAt = now - 5 * 3600000;
  const outAt = now - 1 * 3600000;
  const a = applyClock(user, 'in', { clientId: 'off-in-00001', at: inAt });
  assert.equal(a.entry!.offline, 1);
  assert.equal(fmtClock(a.entry!.start_min), fmtClock(epochToLocal(inAt, TZ).minutes));
  const b = applyClock(user, 'out', { clientId: 'off-out-0001', at: outAt });
  assert.equal(b.entry!.offline, 1);
  assert.equal(fmtClock(b.entry!.end_min! % 1440), fmtClock(epochToLocal(outAt, TZ).minutes));
  assert.equal(entries().length, 1);
});

test('ripetere lo stesso invio non duplica nulla (idempotenza)', () => {
  const again = applyClock(user, 'in', { clientId: 'off-in-00001', at: Date.now() - 5 * 3600000 });
  assert.equal(again.duplicate, true);
  assert.equal(again.entry, null);
  assert.equal(entries().length, 1);
  const again2 = applyClock(user, 'out', { clientId: 'off-out-0001', at: Date.now() - 3600000 });
  assert.equal(again2.duplicate, true);
});

test('ingresso quando ce n’è già uno aperto: errore e nessuna traccia nel registro', () => {
  const at = Date.now() - 30 * MIN;
  applyClock(user, 'in', { clientId: 'second-in-001', at });
  assert.throws(() => applyClock(user, 'in', { clientId: 'second-in-002', at: Date.now() - 10 * MIN }), /già un ingresso/);
  // l'evento fallito non è registrato: si può riprovare dopo averlo sistemato
  assert.equal(db.prepare("SELECT 1 FROM clock_log WHERE client_id = 'second-in-002'").get(), undefined);
  applyClock(user, 'out', { clientId: 'second-out-01', at: Date.now() - 5 * MIN });
});

test('orari impossibili: futuro, troppo vecchi, uscita senza ingresso', () => {
  assert.throws(() => applyClock(user, 'in', { clientId: 'future-0001', at: Date.now() + 10 * MIN }), /futuro/);
  assert.throws(() => applyClock(user, 'in', { clientId: 'ancient-0001', at: Date.now() - 30 * 86400000 }), /più vecchia/);
  assert.throws(() => applyClock(user, 'out', { clientId: 'orphan-0001', at: Date.now() - MIN }), /nessun ingresso aperto/);
});

test('la sincronizzazione in ordine di orario ricostruisce il turno anche se inviata alla rinfusa', () => {
  db.prepare('DELETE FROM entries').run();
  const base = Date.now() - 6 * 3600000;
  const events = [
    { clientId: 'batch-out-001', kind: 'out' as const, at: base + 4 * 3600000 },
    { clientId: 'batch-in-0001', kind: 'in' as const, at: base },
  ].sort((a, b) => a.at - b.at); // come fa la route /clock/sync
  for (const ev of events) applyClock(user, ev.kind, { clientId: ev.clientId, at: ev.at });
  const [e] = entries();
  assert.equal(entries().length, 1);
  assert.equal(e.end_min! - e.start_min, 240);
});

test('conflitti: i messaggi dicono quando e da quale dispositivo è già stata fatta la timbratura', () => {
  db.prepare('DELETE FROM entries').run();
  db.prepare('DELETE FROM clock_log').run();
  const t = Date.now() - 30 * MIN;
  applyClock(user, 'in', { clientId: 'dev-in-00001', at: t, device: 'iPhone' });
  // il tablet, con la pagina non aggiornata, prova a timbrare l'entrata di nuovo
  assert.throws(
    () => applyClock(user, 'in', { clientId: 'dev-in-00002', device: 'tablet Android' }),
    (e: Error) => /già un ingresso aperto dalle \d\d:\d\d da iPhone/.test(e.message) && /non era aggiornata/.test(e.message),
  );
  const row = entries()[0];
  assert.equal(row.device, 'iPhone');
  // il telefono chiude il turno; il tablet, ancora vecchio, prova a chiuderlo di nuovo
  applyClock(user, 'out', { clientId: 'dev-out-0001', at: Date.now() - 5 * MIN, device: 'iPhone' });
  assert.equal(entries()[0].end_device, 'iPhone');
  assert.throws(
    () => applyClock(user, 'out', { clientId: 'dev-out-0002', device: 'tablet Android' }),
    /nessun ingresso aperto: l’uscita risulta già registrata alle \d\d:\d\d da iPhone/,
  );
});
