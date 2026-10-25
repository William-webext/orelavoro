import crypto from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from './config.ts';
import { db, type UserRow } from './db.ts';

export class HttpError extends Error {
  status: number;
  /** codice leggibile dall'app (es. "replaced": sessione sostituita da un altro dispositivo) */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Nome leggibile del dispositivo dallo user-agent, per i messaggi ("da iPhone"). */
export function deviceLabel(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'telefono Android' : 'tablet Android';
  if (/Windows|Macintosh|Linux|X11|CrOS/.test(ua)) return 'computer';
  return 'altro dispositivo';
}

export type AppEnv = {
  Variables: {
    actor: UserRow;
    /** Utente i cui dati vengono letti/modificati (diverso da actor solo per il superadmin). */
    target: UserRow;
  };
};

// ---------- PIN ----------

export const PIN_RE = /^\d{6,8}$/;
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pin, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = crypto.scryptSync(pin, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(key, expected);
}

// Hash fittizio per tenere costante il tempo di risposta con utente inesistente.
const DUMMY_HASH = hashPin('000000');

// ---------- sessioni ----------

const COOKIE = 'ol_session';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function isHttps(c: Context): boolean {
  if (config.cookieSecure === 'true') return true;
  if (config.cookieSecure === 'false') return false;
  return c.req.header('x-forwarded-proto')?.split(',')[0].trim() === 'https';
}

export function createSession(c: Context, userId: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = now + config.sessionDays * 86400000;
  const ua = (c.req.header('user-agent') ?? '').slice(0, 200);
  const device = deviceLabel(ua);
  if (config.singleSession) {
    // un solo dispositivo attivo: i precedenti restano segnati "sostituiti" per una settimana,
    // così al primo tocco possono spiegare perché sono stati scollegati
    db.prepare(
      "UPDATE sessions SET revoked_reason = 'replaced', revoked_device = ?, expires_at = MIN(expires_at, ?) WHERE user_id = ? AND revoked_reason IS NULL",
    ).run(device, now + 7 * 86400000, userId);
  }
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, user_agent, device) VALUES (?,?,?,?,?,?,?)').run(
    sha256(token),
    userId,
    now,
    now,
    expires,
    ua,
    device,
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    path: '/',
    maxAge: config.sessionDays * 86400,
  });
}

export function destroySession(c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  deleteCookie(c, COOKIE, { path: '/' });
}

export function destroyUserSessions(userId: number) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function userFromSession(c: Context): UserRow | null {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const h = sha256(token);
  const s = db.prepare('SELECT user_id, expires_at, last_seen, revoked_reason, revoked_device FROM sessions WHERE token_hash = ?').get(h) as
    | { user_id: number; expires_at: number; last_seen: number; revoked_reason: string | null; revoked_device: string }
    | undefined;
  if (!s) return null;
  if (s.revoked_reason === 'replaced') {
    const who = s.revoked_device ? ` (${s.revoked_device})` : '';
    throw new HttpError(401, `Hai acceso su un altro dispositivo${who}. Accedi di nuovo per continuare qui.`, 'replaced');
  }
  const now = Date.now();
  if (s.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(s.user_id) as UserRow | undefined;
  if (!user) return null;
  if (now - s.last_seen > 86400000) {
    // sessione scorrevole: si rinnova usando l'app
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(now, now + config.sessionDays * 86400000, h);
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps(c),
      path: '/',
      maxAge: config.sessionDays * 86400,
    });
  }
  return user;
}

export function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// ---------- limitazione tentativi ----------

const ipHits = new Map<string, { n: number; reset: number }>();

export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';
}

function ipLimited(ip: string): boolean {
  const now = Date.now();
  const e = ipHits.get(ip);
  if (!e || e.reset < now) {
    ipHits.set(ip, { n: 1, reset: now + 15 * 60000 });
    return false;
  }
  e.n += 1;
  return e.n > 30;
}

export function login(c: Context, usernameRaw: string, pin: string): UserRow {
  const ip = clientIp(c);
  if (ipLimited(ip)) throw new HttpError(429, 'Troppi tentativi. Riprova tra qualche minuto.');
  const username = usernameRaw.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  const now = Date.now();
  if (user && user.locked_until > now) {
    verifyPin(pin, DUMMY_HASH);
    const mins = Math.ceil((user.locked_until - now) / 60000);
    throw new HttpError(429, `Accesso bloccato per troppi tentativi errati. Riprova tra ${mins} minuti.`);
  }
  const ok = verifyPin(pin, user?.pin_hash ?? DUMMY_HASH) && user && user.active === 1;
  if (!ok || !user) {
    if (user) {
      const failed = user.failed_attempts + 1;
      if (failed >= config.loginMaxFailures) {
        db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(now + config.loginLockMinutes * 60000, user.id);
      } else {
        db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(failed, user.id);
      }
    }
    throw new HttpError(401, 'Utente o PIN non corretti.');
  }
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(user.id);
  createSession(c, user.id);
  return user;
}

// ---------- middleware ----------

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = userFromSession(c);
  if (!user) throw new HttpError(401, 'Sessione scaduta. Accedi di nuovo.');
  c.set('actor', user);
  const as = c.req.query('as');
  if (as && Number(as) !== user.id) {
    if (user.role !== 'superadmin') throw new HttpError(403, 'Non autorizzato.');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(as)) as UserRow | undefined;
    if (!target) throw new HttpError(404, 'Utente non trovato.');
    c.set('target', target);
  } else {
    c.set('target', user);
  }
  await next();
};

export const requireSuper: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('actor').role !== 'superadmin') throw new HttpError(403, 'Solo il superadmin può farlo.');
  await next();
};

/** Registra nel log le modifiche fatte dal superadmin sui dati di un altro utente. */
export function auditIfOther(c: Context<AppEnv>, action: string, detail: string) {
  const actor = c.get('actor');
  const target = c.get('target');
  if (actor.id === target.id) return;
  writeAudit(actor, target, action, detail);
}

export function writeAudit(actor: UserRow, target: UserRow | null, action: string, detail: string) {
  db.prepare('INSERT INTO audit (ts, actor_id, actor_name, target_id, target_name, action, detail) VALUES (?,?,?,?,?,?,?)').run(
    Date.now(),
    actor.id,
    actor.display_name,
    target?.id ?? null,
    target?.display_name ?? '',
    action,
    detail,
  );
}

/** Crea il superadmin iniziale da variabili d'ambiente se non esiste nessun utente. */
export function bootstrapSuperadmin() {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (n > 0) return;
  const { username, pin, name, email } = config.superadmin;
  if (!username || !pin) {
    console.warn('[setup] Nessun utente presente: imposta SUPERADMIN_USER e SUPERADMIN_PIN per creare il superadmin.');
    return;
  }
  if (!USERNAME_RE.test(username) || !PIN_RE.test(pin)) {
    console.error('[setup] SUPERADMIN_USER o SUPERADMIN_PIN non validi (PIN: 6-8 cifre).');
    return;
  }
  db.prepare("INSERT INTO users (username, display_name, pin_hash, role, email, created_at) VALUES (?,?,?,'superadmin',?,?)").run(
    username,
    name,
    hashPin(pin),
    email,
    Date.now(),
  );
  console.log(`[setup] Creato superadmin "${username}".`);
}
