// Crea un database DIMOSTRATIVO (utenti e ore inventati) per fare le schermate del manuale.
//   node docs/tools/seed-demo.mjs <cartella-dati>
//   DATA_DIR=<cartella-dati> PORT=3200 node src/server/index.ts
// Utenti: admin / mario / laura, tutti con PIN 246810.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dataDir = path.resolve(process.argv[2] ?? './data-demo');
process.env.DATA_DIR = dataDir;
const root = path.resolve(import.meta.dirname, '../..');
const { db } = await import(pathToFileURL(path.join(root, 'src/server/db.ts')).href);
const { hashPin } = await import(pathToFileURL(path.join(root, 'src/server/auth.ts')).href);

if ((db.prepare('SELECT COUNT(*) AS n FROM users').get()).n > 0) {
  console.log('Il database contiene già degli utenti: nessuna modifica.');
  process.exit(0);
}

let seed = 4242;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
const between = (a, b) => Math.round(a + rnd() * (b - a));
const now = Date.now();
const pin = hashPin('246810');

const addUser = db.prepare('INSERT INTO users (username, display_name, pin_hash, role, email, autorest, rest_weekdays, created_at) VALUES (?,?,?,?,?,?,?,?)');
addUser.run('admin', 'Amministratore', pin, 'superadmin', 'admin@example.com', 0, '', now - 400 * 86400000);
addUser.run('mario', 'Mario Rossi', pin, 'user', 'mario.rossi@example.com', 1, '0,6', now - 400 * 86400000);
addUser.run('laura', 'Laura Bianchi', pin, 'user', 'laura.bianchi@example.com', 1, '0,6', now - 300 * 86400000);

const addEntry = db.prepare('INSERT INTO entries (user_id, date, start_min, end_min, note, offline, device, end_device, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
const addType = db.prepare("INSERT OR REPLACE INTO day_types (user_id, date, type, note) VALUES (?,?,?, '')");
const addSalary = db.prepare('INSERT OR REPLACE INTO salaries (user_id, month, net_cents, gross_cents, note) VALUES (?,?,?,?,?)');

const iso = (d) => d.toISOString().slice(0, 10);
const FESTIVI = new Set(['2026-01-01', '2026-01-06', '2026-04-06', '2026-05-01', '2026-06-02']);
const FERIE = new Set(['2026-04-27', '2026-10-12']);
for (let day = 3; day <= 14; day++) FERIE.add(`2026-08-${String(day).padStart(2, '0')}`);
const MALATTIA = new Set(['2026-03-10', '2026-03-11']);

function populate(userId, from, to, { skipDays = new Set(), device = 'iPhone' } = {}) {
  for (let t = Date.UTC(...from); t <= Date.UTC(...to); t += 86400000) {
    const d = new Date(t);
    const date = iso(d);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (skipDays.has(date)) continue;
    if (FESTIVI.has(date)) { addType.run(userId, date, 'festivo'); continue; }
    if (FERIE.has(date)) { addType.run(userId, date, 'ferie'); continue; }
    if (MALATTIA.has(date)) { addType.run(userId, date, 'malattia'); continue; }
    const ts = Date.parse(date + 'T20:00:00Z');
    if (wd === 5) {
      addEntry.run(userId, date, 8 * 60 + between(-5, 8), 13 * 60 + between(-5, 12), '', 0, device, device, ts, ts);
    } else {
      addEntry.run(userId, date, 8 * 60 + between(-5, 8), 12 * 60 + between(25, 40), '', 0, device, device, ts, ts);
      addEntry.run(userId, date, 13 * 60 + between(25, 38), 17 * 60 + between(-5, 15), '', 0, device, device, ts, ts);
    }
  }
}

// Mario: da gennaio a venerdì 23 ottobre
populate(2, [2026, 0, 1], [2026, 9, 23]);
// permesso il 20/10: lavora solo la mattina
addType.run(2, '2026-10-20', 'permesso');
db.prepare("DELETE FROM entries WHERE user_id = 2 AND date = '2026-10-20' AND start_min > 780").run();
// due timbrature fatte con il server spento e sincronizzate dopo
db.prepare("UPDATE entries SET offline = 1 WHERE user_id = 2 AND date = '2026-10-22'").run();
// stipendi di gennaio-settembre (netto) con il lordo
for (let m = 1; m <= 9; m++) {
  const net = 136000 + between(0, 4800);
  addSalary.run(2, `2026-${String(m).padStart(2, '0')}`, net, Math.round(net * 1.27), m === 3 ? 'Mese con 2 giorni di malattia' : '');
}

// Laura: solo da settembre, con qualche giorno da compilare
populate(3, [2026, 8, 1], [2026, 9, 23], { skipDays: new Set(['2026-10-07', '2026-10-08', '2026-10-14']), device: 'telefono Android' });
addSalary.run(3, '2026-09', 98000, 124500, '');

// registro modifiche del superadmin sui dati di Laura
const aud = db.prepare('INSERT INTO audit (ts, actor_id, actor_name, target_id, target_name, action, detail) VALUES (?,?,?,?,?,?,?)');
// dal più vecchio al più recente, così l'ordine nel registro è quello del tempo
aud.run(now - 20 * 86400000, 1, 'Amministratore', 3, 'Laura Bianchi', 'crea utente', 'laura (user)');
aud.run(now - 9 * 86400000, 1, 'Amministratore', 3, 'Laura Bianchi', 'stipendio', 'Settembre 2026: netto 980,00 €');
aud.run(now - 3 * 86400000, 1, 'Amministratore', 3, 'Laura Bianchi', 'nuova registrazione', '15/10/2026 13:30–17:00');
aud.run(now - 3 * 86400000 + 60000, 1, 'Amministratore', 3, 'Laura Bianchi', 'modifica registrazione', '16/10/2026 08:00–12:30 → 16/10/2026 08:00–12:45');

console.log(`Database dimostrativo creato in ${dataDir}`);
console.log('Entries:', db.prepare('SELECT COUNT(*) AS n FROM entries').get().n);
db.close();
