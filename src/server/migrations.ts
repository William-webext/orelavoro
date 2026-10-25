// Migrazione dello schema del database con rete di sicurezza:
//   1. prima di toccare qualsiasi cosa si fa una copia completa e verificata del database
//      (in /data/backups, "pre-migrazione_vX-vY_data.db");
//   2. tutte le migrazioni in sospeso vengono applicate in UNA transazione, con controlli di
//      integrità prima del commit: o passa tutto, o il database resta com'era;
//   3. se la copia preventiva non riesce, la migrazione NON parte;
//   4. un database più nuovo dell'app (ad esempio dopo aver rimesso un'immagine vecchia) non
//      viene toccato: l'app si ferma con un messaggio chiaro.
// Il ripristino da una copia è in restore.ts (comando "restore" della riga di comando).
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const PRE_MIGRATION_PREFIX = 'pre-migrazione_';
const KEEP_PRE_MIGRATION_BACKUPS = 10;
const REUSE_BACKUP_MS = 10 * 60 * 1000;

export interface MigrationResult {
  from: number;
  to: number;
  /** percorso della copia preventiva (null se non serviva: database nuovo o già aggiornato) */
  backup: string | null;
}

export class MigrationError extends Error {
  backup: string | null;
  constructor(message: string, backup: string | null) {
    super(message);
    this.backup = backup;
  }
}

export function userVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function hasTables(database: DatabaseSync): boolean {
  const r = database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number };
  return r.n > 0;
}

/** "2026-10-25T14-32-10-123": con i millisecondi, così due copie non hanno mai lo stesso nome. */
export function stamp(d = new Date()): string {
  return d.toISOString().slice(0, 23).replace(/[:.]/g, '-');
}

/** Controlla che un file sia un database SQLite leggibile; restituisce la sua versione dello schema. */
export function inspectDatabaseFile(file: string): { version: number; tables: number } {
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const qc = check.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (qc.quick_check !== 'ok') throw new Error(`il file non supera il controllo di integrità (${qc.quick_check})`);
    const tables = (check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n;
    return { version: userVersion(check), tables };
  } finally {
    check.close();
  }
}

/** Impronta del CONTENUTO del database (schema e tutte le righe), indipendente da date e nomi dei file. */
export function fingerprint(database: DatabaseSync): string {
  const hash = createHash('sha256');
  const tables = database
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];
  for (const t of tables) {
    hash.update(`${t.name}|${t.sql}\n`);
    for (const row of database.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}" ORDER BY rowid`).iterate()) {
      hash.update(JSON.stringify(row) + '\n');
    }
  }
  return hash.digest('hex');
}

/**
 * Copia preventiva consistente (VACUUM INTO), verificata aprendola.
 * Se l'app riparte in ciclo dopo un errore non si riempie il disco di copie identiche: si riusa
 * una copia di pochi minuti fa SOLO se contiene esattamente gli stessi dati del database attuale
 * (confronto sul contenuto: vale anche dopo un ripristino, anche fatto a mano copiando il file).
 */
function backupBeforeMigration(database: DatabaseSync, backupDir: string, from: number, to: number): string {
  fs.mkdirSync(backupDir, { recursive: true });
  const prefix = `${PRE_MIGRATION_PREFIX}v${from}-v${to}_`;
  let current: string | null = null;
  for (const f of fs.readdirSync(backupDir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.db')) continue;
    const full = path.join(backupDir, f);
    if (Date.now() - fs.statSync(full).mtimeMs >= REUSE_BACKUP_MS) continue;
    try {
      current ??= fingerprint(database);
      const candidate = new DatabaseSync(full, { readOnly: true });
      try {
        if (userVersion(candidate) === from && fingerprint(candidate) === current) return full;
      } finally {
        candidate.close();
      }
    } catch {
      /* copia recente ma illeggibile o diversa: se ne fa una nuova */
    }
  }
  const file = path.join(backupDir, `${prefix}${stamp()}.db`);
  fs.rmSync(file, { force: true });
  database.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const info = inspectDatabaseFile(file);
  if (info.version !== from) throw new Error(`la copia preventiva ha versione ${info.version} invece di ${from}`);
  pruneBackups(backupDir);
  return file;
}

function pruneBackups(backupDir: string) {
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith(PRE_MIGRATION_PREFIX) && f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(KEEP_PRE_MIGRATION_BACKUPS)) fs.rmSync(path.join(backupDir, old.f), { force: true });
}

export function runMigrations(database: DatabaseSync, migrations: string[], backupDir: string): MigrationResult {
  const from = userVersion(database);
  const to = migrations.length;

  if (from > to) {
    throw new MigrationError(
      `Il database è alla versione ${from}, più recente di quella che questa app conosce (${to}). ` +
        `Probabilmente è stata avviata un'immagine più vecchia: riavvia con l'immagine aggiornata. ` +
        `Il database non è stato modificato. Copie di sicurezza in ${backupDir}.`,
      null,
    );
  }
  if (from === to) return { from, to, backup: null };

  // 1) copia preventiva (solo se c'è già qualcosa da proteggere)
  let backup: string | null = null;
  if (hasTables(database)) {
    try {
      backup = backupBeforeMigration(database, backupDir, from, to);
    } catch (e) {
      throw new MigrationError(
        `Migrazione annullata: non è stato possibile fare la copia preventiva del database (${e instanceof Error ? e.message : e}). ` +
          `Il database non è stato modificato. Controlla lo spazio libero in ${backupDir}.`,
        null,
      );
    }
  }

  // 2) tutto o niente
  database.exec('BEGIN IMMEDIATE');
  try {
    for (let v = from; v < to; v++) {
      database.exec(migrations[v]);
      database.exec(`PRAGMA user_version = ${v + 1}`);
    }
    const fk = database.prepare('PRAGMA foreign_key_check').all();
    if (fk.length > 0) throw new Error(`controllo dei riferimenti fallito (${fk.length} righe incoerenti)`);
    const qc = database.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (qc.quick_check !== 'ok') throw new Error(`controllo di integrità fallito (${qc.quick_check})`);
    database.exec('COMMIT');
  } catch (e) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* già annullata */
    }
    throw new MigrationError(
      `Migrazione del database fallita (v${from} → v${to}): ${e instanceof Error ? e.message : e}. ` +
        `Nessuna modifica è stata applicata: il database è rimasto alla versione ${from}.` +
        (backup ? ` Copia di sicurezza: ${backup}` : ''),
      backup,
    );
  }
  return { from, to, backup };
}
