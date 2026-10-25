// Ripristino del database da una copia (notturna, preventiva alla migrazione o scaricata).
// Va fatto a server FERMO. Prima di sostituire il database attuale se ne salva una copia
// ("prima-del-ripristino_…"), così anche il ripristino si può annullare.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { inspectDatabaseFile, stamp } from './migrations.ts';

export interface RestoreResult {
  /** copia del database che c'era prima del ripristino (null se non esisteva) */
  savedCurrent: string | null;
  /** versione dello schema del database ripristinato */
  version: number;
}

export function listBackups(backupDir: string): { name: string; kind: string; bytes: number; modified: Date }[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((name) => {
      const st = fs.statSync(path.join(backupDir, name));
      const kind = name.startsWith('pre-migrazione_') ? 'prima di una migrazione' : name.startsWith('prima-del-ripristino_') ? 'prima di un ripristino' : 'notturna';
      return { name, kind, bytes: st.size, modified: st.mtime };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Se un altro processo (il server) ha il database aperto, non si può sostituire. */
function assertNotInUse(dbFile: string) {
  const cur = new DatabaseSync(dbFile);
  try {
    cur.exec('PRAGMA busy_timeout = 500');
    // Passare da WAL a DELETE richiede l'accesso esclusivo: con un'altra connessione aperta resta "wal".
    const mode = (cur.prepare('PRAGMA journal_mode = DELETE').get() as { journal_mode: string }).journal_mode;
    if (mode.toLowerCase() !== 'delete') throw new Error('in uso');
  } catch {
    throw new Error('Il database è in uso da un altro processo (il server?). Ferma prima il container e riprova.');
  } finally {
    cur.close();
  }
}

export function restoreDatabase(dbFile: string, backupFile: string, savedDir: string): RestoreResult {
  if (!fs.existsSync(backupFile)) throw new Error(`File non trovato: ${backupFile}`);
  let info;
  try {
    info = inspectDatabaseFile(backupFile);
  } catch (e) {
    throw new Error(`Il file indicato non è una copia valida del database: ${e instanceof Error ? e.message : e}`);
  }
  if (info.tables === 0) throw new Error('La copia indicata è un database vuoto: ripristino annullato.');

  let savedCurrent: string | null = null;
  if (fs.existsSync(dbFile)) {
    assertNotInUse(dbFile);
    // copia del database attuale, per poter tornare indietro anche dal ripristino
    fs.mkdirSync(savedDir, { recursive: true });
    savedCurrent = path.join(savedDir, `prima-del-ripristino_${stamp()}.db`);
    const cur = new DatabaseSync(dbFile);
    try {
      cur.exec(`VACUUM INTO '${savedCurrent.replace(/'/g, "''")}'`);
    } finally {
      cur.close();
    }
  }

  const tmp = `${dbFile}.ripristino`;
  fs.copyFileSync(backupFile, tmp);
  fs.rmSync(`${dbFile}-wal`, { force: true });
  fs.rmSync(`${dbFile}-shm`, { force: true });
  fs.renameSync(tmp, dbFile);
  return { savedCurrent, version: info.version };
}
