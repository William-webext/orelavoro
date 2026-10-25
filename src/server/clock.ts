import { assertNoOverlap, openEntry } from './calc.ts';
import { HttpError } from './auth.ts';
import { config } from './config.ts';
import { db, tx, type EntryRow, type UserRow } from './db.ts';
import { diffDays, epochToLocal, fmtClock } from './time.ts';

export interface ClockOptions {
  /** Identificatore generato dal telefono: rende sicuro ripetere la stessa richiesta. */
  clientId?: string;
  /** Istante reale (ms epoch) della timbratura, per quelle salvate offline e inviate dopo. */
  at?: number;
}

export interface ClockResult {
  entry: EntryRow | null;
  /** true se questa timbratura era già stata registrata (tentativo ripetuto) */
  duplicate: boolean;
}

const itDate = (d: string) => d.split('-').reverse().join('/');

/**
 * Registra un ingresso o un'uscita. Senza `at` usa l'ora del server; con `at`
 * (timbratura differita) usa l'istante indicato, purché plausibile.
 */
export function applyClock(target: UserRow, kind: 'in' | 'out', opts: ClockOptions = {}): ClockResult {
  const nowMs = Date.now();
  const deferred = opts.at != null;
  if (deferred) {
    if (opts.at! > nowMs + 2 * 60000) throw new HttpError(422, 'L’ora della timbratura è nel futuro: controlla l’orologio del telefono.');
    if (opts.at! < nowMs - config.offlineMaxDays * 86400000) {
      throw new HttpError(422, `Timbratura più vecchia di ${config.offlineMaxDays} giorni: inseriscila a mano dal calendario.`);
    }
  }
  const atMs = deferred ? opts.at! : nowMs;
  const local = epochToLocal(atMs, config.tz);

  return tx(() => {
    if (opts.clientId) {
      const seen = db.prepare('SELECT 1 FROM clock_log WHERE client_id = ?').get(opts.clientId);
      if (seen) return { entry: null, duplicate: true };
    }

    let entry: EntryRow;
    if (kind === 'in') {
      if (openEntry(target.id)) throw new HttpError(409, 'Hai già un ingresso senza uscita. Segna prima l’uscita.');
      assertNoOverlap(target.id, local.date, local.minutes, null);
      const ts = Date.now();
      const r = db
        .prepare('INSERT INTO entries (user_id, date, start_min, end_min, note, offline, created_at, updated_at) VALUES (?,?,?,NULL,?,?,?,?)')
        .run(target.id, local.date, local.minutes, '', deferred ? 1 : 0, ts, ts);
      entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as EntryRow;
    } else {
      const open = openEntry(target.id);
      if (!open) throw new HttpError(409, 'Non c’è nessun ingresso aperto.');
      const end = local.minutes + 1440 * diffDays(open.date, local.date);
      if (end > open.start_min + 1440) {
        throw new HttpError(
          422,
          `L'ingresso del ${itDate(open.date)} alle ${fmtClock(open.start_min)} è troppo vecchio per chiuderlo con un tocco: inserisci tu l'ora di uscita.`,
        );
      }
      if (end <= open.start_min) {
        throw new HttpError(409, deferred ? 'L’uscita coincide o precede l’ingresso: inseriscila a mano.' : 'Hai appena timbrato l’ingresso: attendi almeno un minuto.');
      }
      assertNoOverlap(target.id, open.date, open.start_min, end, open.id);
      db.prepare('UPDATE entries SET end_min = ?, offline = ?, updated_at = ? WHERE id = ?').run(end, deferred ? 1 : open.offline, Date.now(), open.id);
      entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(open.id) as unknown as EntryRow;
    }

    if (opts.clientId) {
      db.prepare('INSERT INTO clock_log (client_id, user_id, kind, at, created_at) VALUES (?,?,?,?,?)').run(opts.clientId, target.id, kind, atMs, Date.now());
    }
    return { entry, duplicate: false };
  });
}
