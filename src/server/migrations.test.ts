import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MigrationError, PRE_MIGRATION_PREFIX, runMigrations, userVersion } from './migrations.ts';
import { listBackups, restoreDatabase } from './restore.ts';
import { MIGRATIONS } from './schema.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orelavoro-mig-'));
}

/** Database "di una volta": solo le prime `n` migrazioni, con qualche dato dentro. */
function oldDatabase(dir: string, n: number): { file: string; db: DatabaseSync } {
  const file = path.join(dir, 'orelavoro.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, MIGRATIONS.slice(0, n), path.join(dir, 'backups'));
  db.prepare("INSERT INTO users (username, display_name, pin_hash, created_at) VALUES ('mario','Mario','x',1)").run();
  db.prepare("INSERT INTO entries (user_id, date, start_min, end_min, note, created_at, updated_at) VALUES (1,'2026-10-20',480,720,'',1,1)").run();
  return { file, db };
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const backupsOf = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(PRE_MIGRATION_PREFIX)) : []);

test('database nuovo: si crea lo schema, senza copia (non c’è nulla da proteggere)', () => {
  const dir = tmpDir();
  const db = new DatabaseSync(path.join(dir, 'orelavoro.db'));
  const r = runMigrations(db, MIGRATIONS, path.join(dir, 'backups'));
  assert.equal(r.from, 0);
  assert.equal(r.to, MIGRATIONS.length);
  assert.equal(r.backup, null);
  assert.equal(userVersion(db), MIGRATIONS.length);
});

test('database già aggiornato: non fa nulla', () => {
  const dir = tmpDir();
  const { db } = oldDatabase(dir, MIGRATIONS.length);
  const r = runMigrations(db, MIGRATIONS, path.join(dir, 'backups'));
  assert.equal(r.backup, null);
  assert.equal(backupsOf(path.join(dir, 'backups')).length, 0);
});

test('migrazione riuscita: copia preventiva verificata, dati intatti', () => {
  const dir = tmpDir();
  const { db } = oldDatabase(dir, 2);
  const r = runMigrations(db, MIGRATIONS, path.join(dir, 'backups'));
  assert.equal(r.from, 2);
  assert.equal(r.to, MIGRATIONS.length);
  assert.ok(r.backup && fs.existsSync(r.backup), 'la copia preventiva deve esistere');
  assert.match(path.basename(r.backup!), /^pre-migrazione_v2-v\d+_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.db$/);
  // dati dopo la migrazione
  assert.equal(userVersion(db), MIGRATIONS.length);
  assert.equal(count(db, 'users'), 1);
  assert.equal(count(db, 'entries'), 1);
  // la copia è il database di PRIMA: versione 2, stessi dati
  const old = new DatabaseSync(r.backup!, { readOnly: true });
  assert.equal(userVersion(old), 2);
  assert.equal(count(old, 'users'), 1);
  assert.equal(count(old, 'entries'), 1);
  assert.equal((old.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('entries') WHERE name = 'device'").get() as { n: number }).n, 0, 'la copia non ha le colonne nuove');
  old.close();
});

test('migrazione fallita: rollback totale, database com’era, copia disponibile', () => {
  const dir = tmpDir();
  const { db } = oldDatabase(dir, 2);
  const rotte = [...MIGRATIONS, 'CREATE TABLE a_meta_strada (x INTEGER); SELECT boom FROM tabella_che_non_esiste;'];
  assert.throws(
    () => runMigrations(db, rotte, path.join(dir, 'backups')),
    (e: Error) => e instanceof MigrationError && /Nessuna modifica è stata applicata/.test(e.message) && /Copia di sicurezza/.test(e.message) && !!e.backup,
  );
  // nemmeno le migrazioni "buone" 3 e 4 sono rimaste applicate: o tutto o niente
  assert.equal(userVersion(db), 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'a_meta_strada'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('entries') WHERE name = 'device'").get() as { n: number }).n, 0);
  assert.equal(count(db, 'users'), 1);
  assert.equal(count(db, 'entries'), 1);
  assert.equal(backupsOf(path.join(dir, 'backups')).length, 1);
  // dopo la correzione la migrazione riparte normalmente
  const ok = runMigrations(db, MIGRATIONS, path.join(dir, 'backups'));
  assert.equal(ok.to, MIGRATIONS.length);
  assert.equal(count(db, 'entries'), 1);
});

test('riavvii ripetuti dopo un errore non riempiono il disco di copie identiche', () => {
  const dir = tmpDir();
  const { db } = oldDatabase(dir, 2);
  const rotte = [...MIGRATIONS, 'SELECT boom FROM tabella_che_non_esiste;'];
  for (let i = 0; i < 5; i++) assert.throws(() => runMigrations(db, rotte, path.join(dir, 'backups')), MigrationError);
  assert.equal(backupsOf(path.join(dir, 'backups')).length, 1);
});

test('controllo finale: una migrazione che lascia dati incoerenti non viene confermata', () => {
  const dir = tmpDir();
  const { db } = oldDatabase(dir, 2);
  // inserisce una voce che punta a un utente inesistente (viola le chiavi esterne)
  const incoerente = [...MIGRATIONS, 'PRAGMA foreign_keys = OFF; INSERT INTO entries (user_id, date, start_min, end_min, note, created_at, updated_at) VALUES (999,\'2026-10-21\',480,720,\'\',1,1); PRAGMA foreign_keys = ON;'];
  assert.throws(() => runMigrations(db, incoerente, path.join(dir, 'backups')), (e: Error) => /riferimenti|Migrazione/.test(e.message));
  assert.equal(userVersion(db), 2);
  assert.equal(count(db, 'entries'), 1);
});

test('database più nuovo dell’app: non si tocca e si spiega perché', () => {
  const dir = tmpDir();
  const { db } = oldDatabase(dir, MIGRATIONS.length);
  assert.throws(
    () => runMigrations(db, MIGRATIONS.slice(0, MIGRATIONS.length - 1), path.join(dir, 'backups')),
    (e: Error) => /più recente/.test(e.message) && /non è stato modificato/.test(e.message),
  );
  assert.equal(userVersion(db), MIGRATIONS.length);
  assert.equal(count(db, 'entries'), 1);
});

test('copie preventive: se ne tengono al massimo 10', () => {
  const dir = tmpDir();
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  for (let i = 0; i < 12; i++) {
    const f = path.join(backups, `${PRE_MIGRATION_PREFIX}v0-v1_2020-01-${String(i + 1).padStart(2, '0')}T00-00-00.db`);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, new Date(2020, 0, i + 1), new Date(2020, 0, i + 1));
  }
  const { db } = oldDatabase(dir, 2);
  runMigrations(db, MIGRATIONS, backups);
  assert.equal(backupsOf(backups).length, 10);
});

test('ripristino: il database torna com’era prima della migrazione, e quello di dopo si salva', () => {
  const dir = tmpDir();
  const { file, db } = oldDatabase(dir, 2);
  const r = runMigrations(db, MIGRATIONS, path.join(dir, 'backups'));
  db.prepare("INSERT INTO users (username, display_name, pin_hash, created_at) VALUES ('anna','Anna','x',2)").run();
  db.close(); // server fermo

  const res = restoreDatabase(file, r.backup!, path.join(dir, 'backups'));
  assert.equal(res.version, 2);
  assert.ok(res.savedCurrent && fs.existsSync(res.savedCurrent));

  const ripristinato = new DatabaseSync(file);
  assert.equal(userVersion(ripristinato), 2);
  assert.equal(count(ripristinato, 'users'), 1, 'torna senza Anna, aggiunta dopo la migrazione');
  ripristinato.close();
  // e nulla è andato perso: il database "di dopo" è nella copia di sicurezza
  const dopo = new DatabaseSync(res.savedCurrent!, { readOnly: true });
  assert.equal(userVersion(dopo), MIGRATIONS.length);
  assert.equal(count(dopo, 'users'), 2);
  dopo.close();
  // rimigrando il database ripristinato si arriva di nuovo all'ultima versione senza perdere dati
  const rimigra = new DatabaseSync(file);
  runMigrations(rimigra, MIGRATIONS, path.join(dir, 'backups'));
  assert.equal(userVersion(rimigra), MIGRATIONS.length);
  assert.equal(count(rimigra, 'entries'), 1);
  rimigra.close();
  assert.ok(listBackups(path.join(dir, 'backups')).some((b) => b.kind === 'prima di un ripristino'));
});

test('ripristino: rifiuta file non validi e il database in uso da un altro processo', () => {
  const dir = tmpDir();
  const { file, db } = oldDatabase(dir, MIGRATIONS.length);
  const finto = path.join(dir, 'finto.db');
  fs.writeFileSync(finto, 'non sono un database');
  assert.throws(() => restoreDatabase(file, finto, path.join(dir, 'backups')), /non è una copia valida/);
  assert.throws(() => restoreDatabase(file, path.join(dir, 'non-esiste.db'), path.join(dir, 'backups')), /non trovato/);

  const vuoto = path.join(dir, 'vuoto.db');
  new DatabaseSync(vuoto).close();
  assert.throws(() => restoreDatabase(file, vuoto, path.join(dir, 'backups')), /vuoto/);

  // il "server" (db, ancora aperto in WAL) impedisce il ripristino
  const buona = path.join(dir, 'buona.db');
  db.exec(`VACUUM INTO '${buona.replace(/'/g, "''")}'`);
  assert.throws(() => restoreDatabase(file, buona, path.join(dir, 'backups')), /in uso/);
  assert.equal(count(db, 'users'), 1, 'il database in uso non è stato toccato');
  db.close();
});

test('dopo un ripristino la copia preventiva è dello stato attuale, non di una vecchia migrazione', () => {
  const dir = tmpDir();
  const backups = path.join(dir, 'backups');
  const { file, db } = oldDatabase(dir, 2); // 1 utente
  const x = path.join(dir, 'x.db'); // copia "di ieri": 1 utente
  db.exec(`VACUUM INTO '${x.replace(/'/g, "''")}'`);
  db.prepare("INSERT INTO users (username, display_name, pin_hash, created_at) VALUES ('anna','Anna','x',2)").run(); // ora 2 utenti
  const a = runMigrations(db, MIGRATIONS, backups).backup!;
  assert.equal(count(new DatabaseSync(a, { readOnly: true }), 'users'), 2);
  db.close();

  // si ripristina la copia di ieri (1 utente) e l'app riparte entro pochi minuti
  restoreDatabase(file, x, backups);
  const db2 = new DatabaseSync(file);
  const b = runMigrations(db2, MIGRATIONS, backups).backup!;
  assert.notEqual(b, a, 'non deve riusare la copia fatta prima del ripristino');
  const copiaB = new DatabaseSync(b, { readOnly: true });
  assert.equal(count(copiaB, 'users'), 1, 'la nuova copia riflette il database ripristinato');
  copiaB.close();
  db2.close();
});
