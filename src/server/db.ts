import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });

export const dbFile = path.join(config.dataDir, 'orelavoro.db');
export const db = new DatabaseSync(dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','superadmin')),
    email TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    autorest INTEGER NOT NULL DEFAULT 0,
    rest_weekdays TEXT NOT NULL DEFAULT '',
    notify_open INTEGER NOT NULL DEFAULT 1,
    monthly_report INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    start_min INTEGER NOT NULL CHECK (start_min >= 0 AND start_min < 1440),
    end_min INTEGER CHECK (end_min IS NULL OR (end_min > start_min AND end_min <= start_min + 1440)),
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX entries_user_date ON entries(user_id, date);

  CREATE TABLE day_types (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('ferie','malattia','permesso','festivo','riposo')),
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE salaries (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    net_cents INTEGER NOT NULL CHECK (net_cents >= 0),
    gross_cents INTEGER CHECK (gross_cents IS NULL OR gross_cents >= 0),
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, month)
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor_id INTEGER NOT NULL,
    actor_name TEXT NOT NULL,
    target_id INTEGER,
    target_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE mail_log (
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, ref)
  );
  `,
];

function migrate() {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let v = row.user_version;
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      v += 1;
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

migrate();

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
