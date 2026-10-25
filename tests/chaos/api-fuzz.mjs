// Sicurezza e robustezza dell'API: controlli mirati + migliaia di richieste casuali/malformate.
//   node tests/chaos/api-fuzz.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PORT = 3800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'orelavoro-fuzz-'));
const ITER = Number(process.env.FUZZ_ITER ?? 4000);

let log = '';
const server = spawn(process.execPath, ['src/server/index.ts'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), SUPERADMIN_USER: 'root', SUPERADMIN_PIN: '135790', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(BASE + '/api/health')).ok) break;
  } catch {
    /* in avvio */
  }
  await new Promise((r) => setTimeout(r, 100));
}

let ipN = 0;
async function call(method, p, { body, raw, cookie, headers = {}, ip } = {}) {
  const h = { 'cf-connecting-ip': ip ?? `10.9.${(ipN >> 8) & 255}.${ipN++ & 255}`, ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    h['content-type'] ??= 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(BASE + p, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non JSON */
  }
  return { status: res.status, json, text, headers: res.headers, ctype: res.headers.get('content-type') ?? '' };
}
async function login(username, pin, extra = {}) {
  const r = await call('POST', '/api/login', { body: { username, pin }, ...extra });
  const c = r.headers.getSetCookie?.()[0]?.split(';')[0];
  return { ...r, cookie: c };
}

const failures = [];
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (!cond) failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- preparazione ----------
const root = await login('root', '135790');
check('login superadmin', root.status === 200 && root.cookie);
const mk = async (u, pin) => (await call('POST', '/api/admin/users', { cookie: root.cookie, body: { username: u, displayName: u, pin } })).json?.user;
const alice = await mk('alice', '111111');
const bob = await mk('bob', '222222');
const A = (await login('alice', '111111')).cookie;
const B = (await login('bob', '222222')).cookie;
const bobEntry = (await call('POST', '/api/entries', { cookie: B, body: { date: '2026-01-05', start: '08:00', end: '12:00' } })).json?.entry;
check('setup: voce di bob creata', !!bobEntry?.id);

// ---------- controlli mirati: sicurezza ----------
for (const [m, p] of [
  ['GET', '/api/me'],
  ['GET', '/api/status'],
  ['GET', '/api/month'],
  ['POST', '/api/clock/in'],
  ['POST', '/api/clock/sync'],
  ['GET', '/api/export.json'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/backup'],
]) {
  const r = await call(m, p, { body: m === 'POST' ? {} : undefined });
  check(`senza login ${m} ${p} → 401`, r.status === 401, `ottenuto ${r.status}`);
}
for (const p of ['/api/month', '/api/status', '/api/year', '/api/export.json', '/api/report']) {
  const r = await call('GET', `${p}${p.includes('?') ? '&' : '?'}as=${bob.id}`, { cookie: A });
  check(`alice con as=bob su ${p} → 403`, r.status === 403, `ottenuto ${r.status}`);
}
for (const [m, p, body] of [
  ['POST', '/api/admin/users', { username: 'x1', displayName: 'x', pin: '123456' }],
  ['GET', '/api/admin/audit'],
  ['GET', '/api/admin/backup'],
  ['PATCH', `/api/admin/users/${bob.id}`, { active: false }],
  ['POST', `/api/admin/users/${bob.id}/pin`, { pin: '999999' }],
  ['POST', '/api/admin/test-mail', {}],
]) {
  const r = await call(m, p, { cookie: A, body });
  check(`alice su ${m} ${p} → 403`, r.status === 403, `ottenuto ${r.status}`);
}
check('alice non può modificare una voce di bob', (await call('PUT', `/api/entries/${bobEntry.id}`, { cookie: A, body: { date: '2026-01-05', start: '09:00', end: '10:00' } })).status === 404);
check('alice non può eliminare una voce di bob', (await call('DELETE', `/api/entries/${bobEntry.id}`, { cookie: A })).status === 404);
check('alice non può vedere l’anteprima su voce di bob', (await call('POST', '/api/entries/preview', { cookie: A, body: { id: bobEntry.id, delete: true } })).status === 404);
check('la voce di bob è rimasta intatta', (await call('GET', '/api/month?ym=2026-01', { cookie: B })).json?.month?.totals?.minutes === 240);
check('origine diversa su POST → 403', (await call('POST', '/api/clock/in', { cookie: A, body: {}, headers: { origin: 'https://evil.example' } })).status === 403);
check('origine uguale su POST ammessa', [200, 409].includes((await call('POST', '/api/clock/in', { cookie: A, body: {}, headers: { origin: BASE } })).status));
const out = await call('POST', '/api/clock/out', { cookie: A, body: {} });
check('uscita fatta subito dopo l’ingresso → rifiuto gestito', out.status === 409, `ottenuto ${out.status}`);

// cookie di sessione
const lg = await call('POST', '/api/login', { body: { username: 'alice', pin: '111111' }, headers: { 'x-forwarded-proto': 'https' } });
const sc = lg.headers.getSetCookie()[0] ?? '';
check('cookie HttpOnly', /HttpOnly/i.test(sc));
check('cookie SameSite=Lax', /SameSite=Lax/i.test(sc));
check('cookie Secure dietro HTTPS', /Secure/i.test(sc));
check('cookie non Secure in HTTP semplice', !/Secure/i.test(A ? (await call('POST', '/api/login', { body: { username: 'alice', pin: '111111' } })).headers.getSetCookie()[0] : ''));

// blocco dopo tentativi errati
for (let i = 0; i < 5; i++) await call('POST', '/api/login', { body: { username: 'bob', pin: '000000' }, ip: '10.77.0.' + i });
const locked = await login('bob', '222222', { ip: '10.77.0.50' });
check('utente bloccato anche con il PIN giusto → 429', locked.status === 429, `ottenuto ${locked.status}`);
check('messaggio di login non rivela se l’utente esiste', (await call('POST', '/api/login', { body: { username: 'nessuno', pin: '000000' } })).json?.error === (await call('POST', '/api/login', { body: { username: 'alice', pin: '000000' } })).json?.error);
// sblocco da admin
await call('POST', `/api/admin/users/${bob.id}/unlock`, { cookie: root.cookie, body: {} });
check('dopo lo sblocco bob entra', (await login('bob', '222222', { ip: '10.77.0.60' })).status === 200);

// reimpostare il PIN chiude le sessioni; disattivare un utente pure
const bob2 = (await login('bob', '222222', { ip: '10.77.0.61' })).cookie;
await call('POST', `/api/admin/users/${bob.id}/pin`, { cookie: root.cookie, body: { pin: '333333' } });
check('sessione di bob invalidata dopo il cambio PIN', (await call('GET', '/api/me', { cookie: bob2 })).status === 401);
const al2 = (await login('alice', '111111', { ip: '10.77.0.62' })).cookie;
await call('PATCH', `/api/admin/users/${alice.id}`, { cookie: root.cookie, body: { active: false } });
check('utente disattivato: sessione non più valida', (await call('GET', '/api/me', { cookie: al2 })).status === 401);
check('utente disattivato: non può rientrare', (await login('alice', '111111', { ip: '10.77.0.63' })).status === 401);
check('il superadmin non può disattivare se stesso', (await call('PATCH', `/api/admin/users/${(await call('GET', '/api/me', { cookie: root.cookie })).json.user.id}`, { cookie: root.cookie, body: { active: false } })).status === 400);
await call('PATCH', `/api/admin/users/${alice.id}`, { cookie: root.cookie, body: { active: true } });

// file statici / percorsi strani
for (const p of ['/../../etc/passwd', '/..%2f..%2fpackage.json', '/assets/../../package.json', '/%2e%2e/%2e%2e/package.json', '/.env', '/src/server/config.ts', '/data/orelavoro.db']) {
  const r = await call('GET', p);
  check(`nessuna fuga di file su ${p}`, !/"name":\s*"orelavoro"|SUPERADMIN_PIN|SQLite format/.test(r.text), `status ${r.status}`);
}
const bobNow = (await login('bob', '333333', { ip: '10.77.0.70' })).cookie;
const big = await call('POST', '/api/entries', { cookie: bobNow, raw: JSON.stringify({ date: '2026-01-06', start: '08:00', note: 'x'.repeat(3_000_000) }) });
check('corpo da 3 MB → rifiutato senza crash', big.status === 400, `ottenuto ${big.status}`);

// ---------- fuzz ----------
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const junk = () =>
  pick([
    null, undefined, true, false, 0, -1, 1e21, -1e21, 0.5, NaN, Infinity, '', ' ', 'x', '😀'.repeat(50), "'; DROP TABLE users;--", '\u0000', '../../x', '<script>alert(1)</script>',
    '2026-13-45', '2026-02-30', '2026-10', '99999-01-01', '25:61', '24:00', '00:00', '08:00', '2026-10-24', 'in', 'out', 'ferie', 'riposo', 'xyz', [], {}, [[]], { a: { b: { c: [1, 2, 3] } } },
    Number.MAX_SAFE_INTEGER, 2 ** 40, '1'.repeat(10000),
  ]);
const maybe = (good) => (rnd() < 0.55 ? good : junk());
const date = () => pick(['2026-10-24', '2026-10-25', '2026-03-29', '2026-02-29', '2025-12-31', '2026-01-01']);
const hm = () => pick(['00:00', '07:30', '12:45', '23:59', '08:00']);
const ym = () => pick(['2026-10', '2026-03', '2026-13', '2026-1', '0000-00', 'abcd']);
const cid = () => pick(['abcdefgh', 'x'.repeat(64), 'x'.repeat(65), 'short', crypto.randomUUID()]);
const idv = () => pick([bobEntry.id, 1, 2, 3, 0, -1, 999999, 'x', 1.5]);

let uAlice = (await login('alice', '111111', { ip: '10.78.0.1' })).cookie;
const endpoints = [
  () => ['GET', `/api/month?ym=${maybe(ym())}`, undefined],
  () => ['GET', `/api/year?y=${maybe(2026)}`, undefined],
  () => ['GET', `/api/report?ym=${maybe(ym())}`, undefined],
  () => ['GET', `/api/salary?ym=${maybe(ym())}`, undefined],
  () => ['GET', `/api/report/file?ym=${maybe(ym())}&format=${pick(['pdf', 'xlsx', 'x'])}&detail=${pick(['0', '1', 'z'])}`, undefined],
  () => ['GET', '/api/export.csv', undefined],
  () => ['GET', '/api/status', undefined],
  () => ['POST', '/api/entries', { date: maybe(date()), start: maybe(hm()), end: maybe(hm()), note: maybe('nota') }],
  () => ['PUT', `/api/entries/${idv()}`, { date: maybe(date()), start: maybe(hm()), end: maybe(hm()), note: maybe('n') }],
  () => ['DELETE', `/api/entries/${idv()}`, undefined],
  () => ['POST', '/api/entries/preview', { id: maybe(1), delete: maybe(false), date: maybe(date()), start: maybe(hm()), end: maybe(hm()) }],
  () => ['PUT', '/api/daytype', { date: maybe(date()), type: maybe('ferie'), note: maybe('') }],
  () => ['POST', '/api/daytype/fill', { ym: maybe(ym()), type: maybe('riposo') }],
  () => ['PUT', '/api/salary', { ym: maybe(ym()), netCents: maybe(120000), grossCents: maybe(150000), note: maybe('') }],
  () => ['PATCH', '/api/me', { displayName: maybe('Alice'), email: maybe('a@b.it'), autorest: maybe(true), restWeekdays: maybe([0, 6]), notifyOpen: maybe(true), monthlyReport: maybe(false) }],
  () => ['POST', '/api/me/pin', { currentPin: maybe('111111'), newPin: maybe('111111') }],
  () => ['GET', `/api/admin/audit?limit=${pick(['abc', '-5', '1e9', '0', '2026-02-30', ''])}`, undefined],
  () => ['POST', '/api/clock/in', { clientId: maybe(cid()), at: maybe(Date.now() - 60000) }],
  () => ['POST', '/api/clock/out', { clientId: maybe(cid()), at: maybe(Date.now() - 30000) }],
  () => ['POST', '/api/clock/sync', { events: maybe([{ clientId: cid(), kind: pick(['in', 'out', 'x']), at: maybe(Date.now() - 100000) }]) }],
  () => ['POST', '/api/report/email', { ym: maybe('2026-10'), detail: maybe(true), format: maybe('pdf') }],
];
const adminEndpoints = [
  () => ['POST', '/api/admin/users', { username: maybe('u' + Math.floor(rnd() * 99999)), displayName: maybe('Nome'), pin: maybe('123456'), email: maybe(''), role: maybe('user') }],
  () => ['PATCH', `/api/admin/users/${pick([3, 999, 'x', '1e9', '-1'])}`, { displayName: maybe('N'), email: maybe(''), role: maybe('user'), active: maybe(true) }],
  () => ['POST', `/api/admin/users/${pick([3, 999])}/pin`, { pin: maybe('654321') }],
  () => ['GET', `/api/admin/audit?limit=${pick(['abc', '-5', '1e9', '0', '2026-02-30', '', '10', String(junk())])}`, undefined],
  () => ['GET', '/api/admin/users', undefined],
  () => ['POST', '/api/admin/test-mail', { to: maybe('x@y.it') }],
];
const rawBodies = ['{', '[', 'null', '"x"', '123', '{"a":', '\u0000', 'é'.repeat(5000), '[]'];

const bad = [];
const statusCount = {};
for (let i = 0; i < ITER; i++) {
  const admin = rnd() < 0.12;
  const [m, p, body] = pick(admin ? adminEndpoints : endpoints)();
  const useRaw = body !== undefined && rnd() < 0.08;
  const cookie = admin ? root.cookie : rnd() < 0.05 ? undefined : uAlice;
  let r;
  try {
    r = await call(m, p, { cookie, body: useRaw ? undefined : body, raw: useRaw ? pick(rawBodies) : undefined, headers: rnd() < 0.05 ? { 'content-type': pick(['text/plain', 'application/xml', '']) } : {} });
  } catch (e) {
    bad.push(`${m} ${p}: richiesta fallita ${e.message}`);
    continue;
  }
  statusCount[r.status] = (statusCount[r.status] ?? 0) + 1;
  if (r.status >= 500 && r.status !== 503) bad.push(`${m} ${p} → ${r.status} ${r.text.slice(0, 80)}`);
  if (r.ctype.includes('json') && r.json === null && r.text) bad.push(`${m} ${p}: JSON non valido`);
  // la sessione di alice può essere invalidata dal fuzz sul PIN: la rinnovo
  if (r.status === 401 && cookie === uAlice) {
    const re = await login('alice', '111111', { ip: '10.78.1.' + (i % 200) });
    if (re.cookie) uAlice = re.cookie;
  }
}

const health = await call('GET', '/api/health');
check('server vivo dopo il fuzz', health.status === 200);
check('nessuna risposta 5xx né JSON rotto nel fuzz', bad.length === 0, bad.slice(0, 5).join(' | '));
const serverErrors = log.split('\n').filter((l) => l.includes('[errore]'));
check('nessun errore interno nel log del server', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '));
server.kill();

console.log(`Controlli mirati + ${ITER} richieste casuali. Codici di stato nel fuzz:`, JSON.stringify(statusCount));
console.log(`${checks} controlli eseguiti, ${failures.length} falliti`);
if (failures.length) {
  for (const f of failures) console.log('  ✖', f);
  process.exit(1);
}
console.log('TUTTO OK');
process.exit(0);
