import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { runMigrations } from './migrations.ts';
import { MIGRATIONS } from './schema.ts';

fs.mkdirSync(config.dataDir, { recursive: true });

export const dbFile = path.join(config.dataDir, 'orelavoro.db');
export const db = new DatabaseSync(dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// Migrazione con copia preventiva (in /data/backups) e rollback totale se qualcosa va storto.
export const backupDir = path.join(config.dataDir, 'backups');
try {
  const r = runMigrations(db, MIGRATIONS, backupDir);
  if (r.from !== r.to) {
    console.log(`[db] migrazione dello schema v${r.from} → v${r.to} completata. Copia preventiva: ${r.backup ?? 'nessuna (database nuovo)'}`);
  }
} catch (e) {
  console.error(`[db] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  pin_hash: string;
  role: 'user' | 'superadmin';
  email: string;
  active: number;
  failed_attempts: number;
  locked_until: number;
  autorest: number;
  rest_weekdays: string;
  notify_open: number;
  monthly_report: number;
  created_at: number;
}

export interface EntryRow {
  id: number;
  user_id: number;
  date: string;
  start_min: number;
  end_min: number | null;
  note: string;
  /** 1 se l'ingresso o l'uscita sono stati registrati offline e sincronizzati dopo */
  offline: number;
  /** dispositivo che ha registrato l'ingresso / l'uscita (es. "iPhone") */
  device: string;
  end_device: string;
  created_at: number;
  updated_at: number;
}

export type DayType = 'ferie' | 'malattia' | 'permesso' | 'festivo' | 'riposo';
export const DAY_TYPES: DayType[] = ['ferie', 'malattia', 'permesso', 'festivo', 'riposo'];

export interface SalaryRow {
  user_id: number;
  month: string;
  net_cents: number;
  gross_cents: number | null;
  note: string;
}

/** Copia consistente del database (usabile a caldo). */
export function backupTo(file: string) {
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}
