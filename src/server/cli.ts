/**
 * Strumenti da riga di comando, ad esempio dentro il container:
 *   docker exec -it orelavoro node src/server/cli.ts reset-pin mario 123456
 *   docker exec -it orelavoro node src/server/cli.ts list-users
 */
import { hashPin, PIN_RE } from './auth.ts';
import { db } from './db.ts';

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'reset-pin') {
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
  for (const u of db.prepare('SELECT username, display_name, role, active FROM users ORDER BY id').all() as unknown as {
    username: string;
    display_name: string;
    role: string;
    active: number;
  }[]) {
    console.log(`${u.username}\t${u.display_name}\t${u.role}\t${u.active ? 'attivo' : 'disattivato'}`);
  }
} else {
  console.error('Comandi: reset-pin <utente> <pin> | list-users');
  process.exit(1);
}
