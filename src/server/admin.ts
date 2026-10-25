import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { destroyUserSessions, hashPin, HttpError, PIN_RE, requireAuth, requireSuper, USERNAME_RE, writeAudit, type AppEnv } from './auth.ts';
import { backupTo, db, type UserRow } from './db.ts';
import { smtpConfigured } from './config.ts';
import { htmlWrap, sendMail } from './mail.ts';

export const admin = new Hono<AppEnv>();
admin.use('*', requireAuth, requireSuper);

function adminUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    role: u.role,
    active: !!u.active,
    locked: u.locked_until > Date.now(),
    createdAt: u.created_at,
  };
}

function getUser(id: number): UserRow {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!u) throw new HttpError(404, 'Utente non trovato.');
  return u;
}

async function json<T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'Richiesta non valida.');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'Dati non validi: ' + r.error.issues.map((i) => i.path.join('.') || i.message).join(', '));
  return r.data;
}

admin.get('/users', (c) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY role DESC, display_name').all() as unknown as UserRow[];
  return c.json({ users: rows.map(adminUser) });
});

admin.post('/users', async (c) => {
  const b = await json(
    c,
    z.object({
      username: z.string().trim().toLowerCase(),
      displayName: z.string().trim().min(1).max(60),
      pin: z.string(),
      email: z.union([z.literal(''), z.email().max(120)]).optional().default(''),
      role: z.enum(['user', 'superadmin']).optional().default('user'),
    }),
  );
  if (!USERNAME_RE.test(b.username)) throw new HttpError(400, 'Nome utente: 2-32 caratteri tra lettere minuscole, numeri, punto, trattino e underscore.');
  if (!PIN_RE.test(b.pin)) throw new HttpError(400, 'Il PIN deve essere di 6-8 cifre.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(b.username)) throw new HttpError(409, 'Nome utente già in uso.');
  const r = db
    .prepare('INSERT INTO users (username, display_name, pin_hash, role, email, created_at) VALUES (?,?,?,?,?,?)')
    .run(b.username, b.displayName, hashPin(b.pin), b.role, b.email, Date.now());
  const u = getUser(Number(r.lastInsertRowid));
  writeAudit(c.get('actor'), u, 'crea utente', `${u.username} (${u.role})`);
  return c.json({ user: adminUser(u) });
});

admin.patch('/users/:id', async (c) => {
  const actor = c.get('actor');
  const u = getUser(Number(c.req.param('id')));
  const b = await json(
    c,
    z.object({
      displayName: z.string().trim().min(1).max(60).optional(),
      email: z.union([z.literal(''), z.email().max(120)]).optional(),
      role: z.enum(['user', 'superadmin']).optional(),
      active: z.boolean().optional(),
    }),
  );
  if (u.id === actor.id && ((b.active === false) || (b.role && b.role !== 'superadmin'))) {
    throw new HttpError(400, 'Non puoi disattivare o declassare te stesso.');
  }
  db.prepare('UPDATE users SET display_name = ?, email = ?, role = ?, active = ? WHERE id = ?').run(
    b.displayName ?? u.display_name,
    b.email ?? u.email,
    b.role ?? u.role,
    b.active == null ? u.active : b.active ? 1 : 0,
    u.id,
  );
  if (b.active === false) destroyUserSessions(u.id);
  const fresh = getUser(u.id);
  writeAudit(actor, fresh, 'modifica utente', Object.keys(b).join(', '));
  return c.json({ user: adminUser(fresh) });
});

admin.post('/users/:id/pin', async (c) => {
  const u = getUser(Number(c.req.param('id')));
  const b = await json(c, z.object({ pin: z.string() }));
  if (!PIN_RE.test(b.pin)) throw new HttpError(400, 'Il PIN deve essere di 6-8 cifre.');
  db.prepare('UPDATE users SET pin_hash = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?').run(hashPin(b.pin), u.id);
  if (u.id !== c.get('actor').id) destroyUserSessions(u.id);
  writeAudit(c.get('actor'), u, 'reimposta PIN', '');
  return c.json({ ok: true });
});

admin.post('/users/:id/unlock', (c) => {
  const u = getUser(Number(c.req.param('id')));
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(u.id);
  return c.json({ ok: true });
});

admin.get('/audit', (c) => {
  const asked = Number(c.req.query('limit') ?? 100);
  const limit = Number.isFinite(asked) ? Math.min(500, Math.max(1, Math.floor(asked))) : 100;
  const rows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as unknown as {
    id: number;
    ts: number;
    actor_name: string;
    target_name: string;
    action: string;
    detail: string;
  }[];
  return c.json({
    audit: rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor_name, target: r.target_name, action: r.action, detail: r.detail })),
  });
});

admin.post('/test-mail', async (c) => {
  if (!smtpConfigured) throw new HttpError(503, 'SMTP non configurato: imposta SMTP_HOST, SMTP_USER, SMTP_PASS e SMTP_FROM.');
  const b = await json(c, z.object({ to: z.union([z.literal(''), z.email()]).optional() }));
  const to = b.to || c.get('actor').email;
  if (!to) throw new HttpError(400, 'Indica un destinatario o imposta la tua email.');
  try {
    await sendMail({
      to,
      subject: 'Ore Lavoro – mail di prova',
      text: 'La configurazione SMTP funziona.',
      html: htmlWrap('Mail di prova', '<p>La configurazione SMTP funziona.</p>'),
    });
  } catch (e) {
    console.error('[mail] test fallito:', e);
    throw new HttpError(502, 'Invio non riuscito: ' + (e instanceof Error ? e.message : String(e)));
  }
  return c.json({ ok: true, to });
});

admin.get('/backup', (c) => {
  const tmp = path.join(os.tmpdir(), `orelavoro-${Date.now()}.db`);
  backupTo(tmp);
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  const stamp = new Date().toISOString().slice(0, 10);
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="orelavoro_${stamp}.db"`,
    'Cache-Control': 'no-store',
  });
});
