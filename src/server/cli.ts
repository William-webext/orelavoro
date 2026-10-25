/**
 * Strumenti da riga di comando, ad esempio dentro il container:
 *   docker exec -it orelavoro node src/server/cli.ts reset-pin mario 123456
 *   docker exec -it orelavoro node src/server/cli.ts list-users
 *   docker exec -it orelavoro node src/server/cli.ts list-backups
 *
 * Ripristino del database (a server FERMO, vedi README):
 *   docker run --rm -v /volume1/docker/orelavoro/data:/data ghcr.io/william-webext/orelavoro:latest \
 *     node src/server/cli.ts restore pre-migrazione_v3-v4_2026-10-25T14-32-10.db
 */
import path from 'node:path';
import { config } from './config.ts';

const [cmd, ...args] = process.argv.slice(2);
const dbFile = path.join(config.dataDir, 'orelavoro.db');
const backupDir = path.join(config.dataDir, 'backups');

if (cmd === 'reset-pin') {
  // questi comandi aprono il database (e quindi lo migrano, con copia preventiva)
  const { hashPin, PIN_RE } = await import('./auth.ts');
  const { db } = await import('./db.ts');
  const [username, pin] = args;
  if (!username || !pin || !PIN_RE.test(pin)) {
    console.error('Uso: reset-pin <utente> <PIN di 6-8 cifre>');
    process.exit(1);
  }
  const r = db
    .prepare('UPDATE users SET pin_hash = ?, failed_attempts = 0, locked_until = 0 WHERE username = ?')
    .run(hashPin(pin), username.toLowerCase());
  if (r.changes === 0) {
    console.error('Utente non trovato.');
    process.exit(1);
  }
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(username.toLowerCase());
  console.log(`PIN di "${username}" aggiornato.`);
} else if (cmd === 'list-users') {
  const { db } = await import('./db.ts');
  for (const u of db.prepare('SELECT username, display_name, role, active FROM users ORDER BY id').all() as unknown as {
    username: string;
    display_name: string;
    role: string;
    active: number;
  }[]) {
    console.log(`${u.username}\t${u.display_name}\t${u.role}\t${u.active ? 'attivo' : 'disattivato'}`);
  }
} else if (cmd === 'list-backups') {
  const { listBackups } = await import('./restore.ts');
  const list = listBackups(backupDir);
  if (list.length === 0) console.log(`Nessuna copia in ${backupDir}`);
  for (const b of list) {
    console.log(`${b.modified.toISOString().slice(0, 19).replace('T', ' ')}  ${(b.bytes / 1024).toFixed(0).padStart(6)} KB  ${b.kind.padEnd(24)} ${b.name}`);
  }
} else if (cmd === 'restore') {
  // NON apre il database dell'app: niente migrazioni automatiche durante il ripristino
  const { restoreDatabase } = await import('./restore.ts');
  const [which] = args;
  if (!which) {
    console.error('Uso: restore <nome della copia in /data/backups, oppure percorso completo>');
    process.exit(1);
  }
  const file = path.isAbsolute(which) || which.includes('/') || which.includes('\\') ? which : path.join(backupDir, which);
  try {
    const r = restoreDatabase(dbFile, file, backupDir);
    console.log(`Database ripristinato dalla copia (schema v${r.version}).`);
    if (r.savedCurrent) console.log(`Il database di prima è stato salvato in: ${r.savedCurrent}`);
    console.log("Riavvia l'app: se la copia è di una versione dello schema più vecchia, verrà migrata di nuovo (con una nuova copia preventiva).");
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
} else {
  console.error('Comandi: reset-pin <utente> <pin> | list-users | list-backups | restore <copia>');
  process.exit(1);
}
