import { Hono } from 'hono';
import { z } from 'zod';
import {
  auditIfOther,
  createSession,
  destroySession,
  destroyUserSessions,
  hashPin,
  HttpError,
  login,
  PIN_RE,
  requireAuth,
  verifyPin,
  type AppEnv,
} from './auth.ts';
import {
  assertNoOverlap,
  buildMonth,
  buildWarnings,
  buildYear,
  dayMinutes,
  entriesBetween,
  entryView,
  openEntry,
  restWeekdays,
  salaryView,
} from './calc.ts';
import { config, smtpConfigured } from './config.ts';
import { db, DAY_TYPES, tx, type EntryRow, type UserRow } from './db.ts';
import { htmlWrap, sendMail } from './mail.ts';
import { monthReport, renderPdf, renderXlsx, reportFilename } from './reports.ts';
import {
  diffDays,
  durationMinutes,
  euro,
  fmtClock,
  fmtDuration,
  isValidDate,
  isValidMonth,
  localToEpochMs,
  monthLabel,
  nowLocal,
  parseHM,
} from './time.ts';

export const api = new Hono<AppEnv>();

// ---------- utilità ----------

async function body<T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
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

function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    email: u.email,
    autorest: !!u.autorest,
    restWeekdays: restWeekdays(u),
    notifyOpen: !!u.notify_open,
    monthlyReport: !!u.monthly_report,
  };
}

function ymParam(v: string | undefined): string {
  const ym = v ?? nowLocal(config.tz).date.slice(0, 7);
  if (!isValidMonth(ym)) throw new HttpError(400, 'Mese non valido.');
  return ym;
}

const dateStr = z.string().refine(isValidDate, 'data');
const hmStr = z.string().regex(/^\d{2}:\d{2}$/);

const entryIn = z.object({
  date: dateStr,
  start: hmStr,
  end: hmStr.nullable().optional(),
  note: z.string().max(200).optional().default(''),
});

interface NormalizedEntry {
  date: string;
  startMin: number;
  endMin: number | null;
  note: string;
}

function normalizeEntry(input: z.infer<typeof entryIn>): NormalizedEntry {
  const s = parseHM(input.start);
  if (s == null) throw new HttpError(400, 'Ora di inizio non valida.');
  let e: number | null = null;
  if (input.end) {
    const p = parseHM(input.end);
    if (p == null) throw new HttpError(400, 'Ora di fine non valida.');
    if (p === s) throw new HttpError(400, "L'ora di fine coincide con l'inizio.");
    e = p < s ? p + 1440 : p; // fine "prima" dell'inizio = giorno dopo
  }
  const now = Date.now();
  if (localToEpochMs(input.date, s, config.tz) > now + 60000) throw new HttpError(400, 'Non puoi registrare ore che non sono ancora iniziate.');
  if (e != null && localToEpochMs(input.date, e, config.tz) > now + 60000) throw new HttpError(400, "L'ora di fine è nel futuro.");
  return { date: input.date, startMin: s, endMin: e, note: input.note };
}

function getOwnEntry(userId: number, id: number): EntryRow {
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(id, userId) as EntryRow | undefined;
  if (!row) throw new HttpError(404, 'Registrazione non trovata.');
  return row;
}

const itDate = (d: string) => d.split('-').reverse().join('/');

// ---------- pubbliche ----------

api.post('/login', async (c) => {
  const { username, pin } = await body(c, z.object({ username: z.string().min(1).max(64), pin: z.string().min(1).max(32) }));
  const user = login(c, username, pin);
  return c.json({ user: publicUser(user) });
});

api.post('/logout', (c) => {
  destroySession(c);
  return c.json({ ok: true });
});

api.get('/health', (c) => c.json({ ok: true }));

// ---------- da qui in poi serve il login ----------

api.use('*', requireAuth);

api.get('/me', (c) => c.json({ user: publicUser(c.get('actor')), mailConfigured: smtpConfigured, tz: config.tz }));

api.patch('/me', async (c) => {
  const actor = c.get('actor');
  const b = await body(
    c,
    z.object({
      displayName: z.string().trim().min(1).max(60).optional(),
      email: z.union([z.literal(''), z.email().max(120)]).optional(),
      autorest: z.boolean().optional(),
      restWeekdays: z.array(z.number().int().min(0).max(6)).optional(),
      notifyOpen: z.boolean().optional(),
      monthlyReport: z.boolean().optional(),
    }),
  );
  db.prepare(
    `UPDATE users SET display_name = ?, email = ?, autorest = ?, rest_weekdays = ?, notify_open = ?, monthly_report = ? WHERE id = ?`,
  ).run(
    b.displayName ?? actor.display_name,
    b.email ?? actor.email,
    b.autorest == null ? actor.autorest : b.autorest ? 1 : 0,
    b.restWeekdays ? [...new Set(b.restWeekdays)].sort().join(',') : actor.rest_weekdays,
    b.notifyOpen == null ? actor.notify_open : b.notifyOpen ? 1 : 0,
    b.monthlyReport == null ? actor.monthly_report : b.monthlyReport ? 1 : 0,
    actor.id,
  );
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(actor.id) as unknown as UserRow;
  return c.json({ user: publicUser(fresh) });
});

api.post('/me/pin', async (c) => {
  const actor = c.get('actor');
  const b = await body(c, z.object({ currentPin: z.string().max(32), newPin: z.string() }));
  if (!PIN_RE.test(b.newPin)) throw new HttpError(400, 'Il nuovo PIN deve essere di 6-8 cifre.');
  if (!verifyPin(b.currentPin, actor.pin_hash)) throw new HttpError(403, 'PIN attuale non corretto.');
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(b.newPin), actor.id);
  destroyUserSessions(actor.id);
  createSession(c, actor.id);
  return c.json({ ok: true });
});

// ---------- stato / timbratura ----------

api.get('/status', (c) => {
  const target = c.get('target');
  const now = nowLocal(config.tz);
  const month = buildMonth(target, now.date.slice(0, 7));
  const today = month.days.find((d) => d.date === now.date)!;
  const open = openEntry(target.id);
  let openView = null;
  if (open) {
    const elapsed = Math.max(0, Math.round((Date.now() - localToEpochMs(open.date, open.start_min, config.tz)) / 60000));
    openView = { ...entryView(open), elapsedMinutes: elapsed };
  }
  return c.json({
    actor: publicUser(c.get('actor')),
    target: publicUser(target),
    now: { date: now.date, time: fmtClock(now.minutes), epochMs: Date.now() },
    open: openView,
    today,
    monthMinutes: month.totals.minutes,
    warnings: buildWarnings(target),
    mailConfigured: smtpConfigured,
  });
});

api.post('/clock/in', (c) => {
  const target = c.get('target');
  const now = nowLocal(config.tz);
  const entry = tx(() => {
    if (openEntry(target.id)) throw new HttpError(409, 'Hai già un ingresso senza uscita. Segna prima l’uscita.');
    assertNoOverlap(target.id, now.date, now.minutes, null);
    const ts = Date.now();
    const r = db
      .prepare('INSERT INTO entries (user_id, date, start_min, end_min, note, created_at, updated_at) VALUES (?,?,?,NULL,?,?,?)')
      .run(target.id, now.date, now.minutes, '', ts, ts);
    return db.prepare('SELECT * FROM entries WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as EntryRow;
  });
  auditIfOther(c, 'timbra entrata', `${itDate(now.date)} ${fmtClock(now.minutes)}`);
  return c.json({ entry: entryView(entry) });
});

api.post('/clock/out', (c) => {
  const target = c.get('target');
  const now = nowLocal(config.tz);
  const entry = tx(() => {
    const open = openEntry(target.id);
    if (!open) throw new HttpError(409, 'Non c’è nessun ingresso aperto.');
    const end = now.minutes + 1440 * diffDays(open.date, now.date);
    if (end > open.start_min + 1440) {
      throw new HttpError(422, `L'ingresso del ${itDate(open.date)} alle ${fmtClock(open.start_min)} è troppo vecchio per chiuderlo con un tocco: inserisci tu l'ora di uscita.`);
    }
    if (end <= open.start_min) throw new HttpError(409, 'Hai appena timbrato l’ingresso: attendi almeno un minuto.');
    assertNoOverlap(target.id, open.date, open.start_min, end, open.id);
    db.prepare('UPDATE entries SET end_min = ?, updated_at = ? WHERE id = ?').run(end, Date.now(), open.id);
    return db.prepare('SELECT * FROM entries WHERE id = ?').get(open.id) as unknown as EntryRow;
  });
  auditIfOther(c, 'timbra uscita', `${itDate(entry.date)} ${fmtClock(entry.start_min)}–${fmtClock(entry.end_min!)}`);
  return c.json({ entry: entryView(entry) });
});

// ---------- registrazioni ----------

api.get('/month', (c) => {
  const target = c.get('target');
  const ym = ymParam(c.req.query('ym'));
  const month = buildMonth(target, ym);
  return c.json({ month, salary: salaryView(target.id, ym, month.totals.minutes) });
});

api.post('/entries', async (c) => {
  const target = c.get('target');
  const n = normalizeEntry(await body(c, entryIn));
  const row = tx(() => {
    if (n.endMin == null && openEntry(target.id)) throw new HttpError(409, 'Hai già un ingresso senza uscita.');
    assertNoOverlap(target.id, n.date, n.startMin, n.endMin);
    const ts = Date.now();
    const r = db
      .prepare('INSERT INTO entries (user_id, date, start_min, end_min, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(target.id, n.date, n.startMin, n.endMin, n.note, ts, ts);
    return db.prepare('SELECT * FROM entries WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as EntryRow;
  });
  auditIfOther(c, 'nuova registrazione', `${itDate(n.date)} ${fmtClock(n.startMin)}–${n.endMin == null ? '…' : fmtClock(n.endMin)}`);
  return c.json({ entry: entryView(row), dayMinutes: dayMinutes(target.id, n.date) });
});

api.put('/entries/:id', async (c) => {
  const target = c.get('target');
  const old = getOwnEntry(target.id, Number(c.req.param('id')));
  const n = normalizeEntry(await body(c, entryIn));
  const row = tx(() => {
    if (n.endMin == null) {
      const open = openEntry(target.id);
      if (open && open.id !== old.id) throw new HttpError(409, 'Hai già un altro ingresso senza uscita.');
    }
    assertNoOverlap(target.id, n.date, n.startMin, n.endMin, old.id);
    db.prepare('UPDATE entries SET date = ?, start_min = ?, end_min = ?, note = ?, updated_at = ? WHERE id = ?').run(
      n.date,
      n.startMin,
      n.endMin,
      n.note,
      Date.now(),
      old.id,
    );
    return db.prepare('SELECT * FROM entries WHERE id = ?').get(old.id) as unknown as EntryRow;
  });
  auditIfOther(
    c,
    'modifica registrazione',
    `${itDate(old.date)} ${fmtClock(old.start_min)}–${old.end_min == null ? '…' : fmtClock(old.end_min)} → ${itDate(n.date)} ${fmtClock(n.startMin)}–${n.endMin == null ? '…' : fmtClock(n.endMin)}`,
  );
  return c.json({ entry: entryView(row) });
});

api.delete('/entries/:id', (c) => {
  const target = c.get('target');
  const old = getOwnEntry(target.id, Number(c.req.param('id')));
  db.prepare('DELETE FROM entries WHERE id = ?').run(old.id);
  auditIfOther(c, 'elimina registrazione', `${itDate(old.date)} ${fmtClock(old.start_min)}–${old.end_min == null ? '…' : fmtClock(old.end_min)}`);
  return c.json({ ok: true });
});

/**
 * Anteprima di una modifica/eliminazione: restituisce, per ogni giorno toccato,
 * il totale prima e dopo, per mostrare la conferma ("passa da 3:00 a 6:00").
 */
api.post('/entries/preview', async (c) => {
  const target = c.get('target');
  const b = await body(
    c,
    z.object({
      id: z.number().int().optional(),
      delete: z.boolean().optional(),
      date: dateStr.optional(),
      start: hmStr.optional(),
      end: hmStr.nullable().optional(),
    }),
  );
  const old = b.id != null ? getOwnEntry(target.id, b.id) : null;
  let next: NormalizedEntry | null = null;
  if (!b.delete) {
    if (!b.date || !b.start) throw new HttpError(400, 'Dati mancanti.');
    next = normalizeEntry({ date: b.date, start: b.start, end: b.end ?? null, note: '' });
    assertNoOverlap(target.id, next.date, next.startMin, next.endMin, old?.id);
  }
  const dates = [...new Set([old?.date, next?.date].filter((x): x is string => !!x))];
  const changes = dates.map((date) => {
    const before = dayMinutes(target.id, date);
    let after = entriesBetween(target.id, date, date)
      .filter((e) => e.id !== old?.id)
      .reduce((s, e) => s + (e.end_min == null ? 0 : durationMinutes(e.date, e.start_min, e.end_min, config.tz)), 0);
    if (next && next.date === date && next.endMin != null) after += durationMinutes(date, next.startMin, next.endMin, config.tz);
    return { date, before, after };
  });
  return c.json({ changes });
});

// ---------- tipo di giornata ----------

api.put('/daytype', async (c) => {
  const target = c.get('target');
  const b = await body(c, z.object({ date: dateStr, type: z.enum(DAY_TYPES).nullable(), note: z.string().max(200).optional().default('') }));
  if (b.type == null) {
    db.prepare('DELETE FROM day_types WHERE user_id = ? AND date = ?').run(target.id, b.date);
  } else {
    db.prepare(
      'INSERT INTO day_types (user_id, date, type, note) VALUES (?,?,?,?) ON CONFLICT(user_id, date) DO UPDATE SET type = excluded.type, note = excluded.note',
    ).run(target.id, b.date, b.type, b.note);
  }
  auditIfOther(c, 'tipo giornata', `${itDate(b.date)}: ${b.type ?? 'rimosso'}`);
  return c.json({ ok: true });
});

/** Segna in blocco i giorni passati ancora vuoti del mese (di default come riposo). */
api.post('/daytype/fill', async (c) => {
  const target = c.get('target');
  const b = await body(c, z.object({ ym: z.string().refine(isValidMonth), type: z.enum(DAY_TYPES).optional().default('riposo') }));
  const month = buildMonth(target, b.ym);
  const todo = month.days.filter((d) => d.todo);
  const ins = db.prepare("INSERT OR IGNORE INTO day_types (user_id, date, type, note) VALUES (?,?,?, '')");
  tx(() => {
    for (const d of todo) ins.run(target.id, d.date, b.type);
  });
  auditIfOther(c, 'compila giorni vuoti', `${monthLabel(b.ym)}: ${todo.length} giorni come ${b.type}`);
  return c.json({ filled: todo.length });
});

// ---------- stipendio ----------

api.get('/salary', (c) => {
  const target = c.get('target');
  const ym = ymParam(c.req.query('ym'));
  const minutes = buildMonth(target, ym).totals.minutes;
  return c.json({ salary: salaryView(target.id, ym, minutes) });
});

api.put('/salary', async (c) => {
  const target = c.get('target');
  const b = await body(
    c,
    z.object({
      ym: z.string().refine(isValidMonth),
      netCents: z.number().int().min(0).max(100_000_000).nullable(),
      grossCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
      note: z.string().max(200).optional().default(''),
    }),
  );
  if (b.netCents == null) {
    db.prepare('DELETE FROM salaries WHERE user_id = ? AND month = ?').run(target.id, b.ym);
  } else {
    db.prepare(
      `INSERT INTO salaries (user_id, month, net_cents, gross_cents, note) VALUES (?,?,?,?,?)
       ON CONFLICT(user_id, month) DO UPDATE SET net_cents = excluded.net_cents, gross_cents = excluded.gross_cents, note = excluded.note`,
    ).run(target.id, b.ym, b.netCents, b.grossCents ?? null, b.note);
  }
  auditIfOther(c, 'stipendio', `${monthLabel(b.ym)}: netto ${b.netCents == null ? 'rimosso' : euro(b.netCents)}`);
  const minutes = buildMonth(target, b.ym).totals.minutes;
  return c.json({ salary: salaryView(target.id, b.ym, minutes) });
});

// ---------- anno ----------

api.get('/year', (c) => {
  const target = c.get('target');
  const y = Number(c.req.query('y') ?? nowLocal(config.tz).date.slice(0, 4));
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, 'Anno non valido.');
  return c.json(buildYear(target, y));
});

// ---------- report ----------

api.get('/report', (c) => {
  const target = c.get('target');
  return c.json({ report: monthReport(target, ymParam(c.req.query('ym'))) });
});

const FORMATS = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as const;

async function renderFile(target: UserRow, ym: string, detail: boolean, format: 'pdf' | 'xlsx') {
  const r = monthReport(target, ym);
  const content = format === 'pdf' ? await renderPdf(r, detail) : await renderXlsx(r, detail);
  return { r, content, filename: reportFilename(r, detail, format) };
}

api.get('/report/file', async (c) => {
  const target = c.get('target');
  const ym = ymParam(c.req.query('ym'));
  const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'pdf';
  const detail = c.req.query('detail') !== '0';
  const f = await renderFile(target, ym, detail, format);
  return c.body(new Uint8Array(f.content), 200, {
    'Content-Type': FORMATS[format],
    'Content-Disposition': `attachment; filename="${f.filename}"`,
    'Cache-Control': 'no-store',
  });
});

api.post('/report/email', async (c) => {
  const actor = c.get('actor');
  const target = c.get('target');
  if (!smtpConfigured) throw new HttpError(503, 'L’invio mail non è configurato sul server.');
  if (!actor.email) throw new HttpError(400, 'Imposta prima il tuo indirizzo email nelle Impostazioni.');
  const b = await body(c, z.object({ ym: z.string().refine(isValidMonth), detail: z.boolean(), format: z.enum(['pdf', 'xlsx']) }));
  const f = await renderFile(target, b.ym, b.detail, b.format);
  const t = f.r.month.totals;
  const lines = [
    `Ore totali: ${fmtDuration(t.minutes)}`,
    `Giorni lavorati: ${t.workedDays}`,
    `Stipendio netto: ${euro(f.r.salary.netCents)}`,
    `Paga oraria netta: ${f.r.salary.rates.net == null ? '—' : f.r.salary.rates.net.toFixed(2) + ' €/h'}`,
  ];
  try {
    await sendMail({
      to: actor.email,
      subject: `Ore lavorate ${f.r.label} – ${f.r.user.name}`,
      text: `Report ${b.detail ? 'dettagliato' : 'sintetico'} di ${f.r.user.name} per ${f.r.label}.\n\n${lines.join('\n')}\n`,
      html: htmlWrap(`Ore lavorate – ${f.r.label}`, `<p>${f.r.user.name}</p><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul><p>Il report è in allegato.</p>`),
      attachments: [{ filename: f.filename, content: f.content, contentType: FORMATS[b.format] }],
    });
  } catch (e) {
    console.error('[mail] invio report fallito:', e);
    throw new HttpError(502, 'Invio mail non riuscito. Controlla la configurazione SMTP.');
  }
  return c.json({ ok: true, to: actor.email });
});

// ---------- esportazione dati ----------

api.get('/export.json', (c) => {
  const target = c.get('target');
  const data = {
    exportedAt: new Date().toISOString(),
    user: { username: target.username, displayName: target.display_name },
    entries: db.prepare('SELECT date, start_min, end_min, note FROM entries WHERE user_id = ? ORDER BY date, start_min').all(target.id),
    dayTypes: db.prepare('SELECT date, type, note FROM day_types WHERE user_id = ? ORDER BY date').all(target.id),
    salaries: db.prepare('SELECT month, net_cents, gross_cents, note FROM salaries WHERE user_id = ? ORDER BY month').all(target.id),
  };
  return c.body(JSON.stringify(data, null, 2), 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="orelavoro_${target.username}.json"`,
  });
});

api.get('/export.csv', (c) => {
  const target = c.get('target');
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date, start_min').all(target.id) as unknown as EntryRow[];
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = ['Data;Inizio;Fine;Minuti;Note'];
  for (const e of rows) {
    const v = entryView(e);
    lines.push([v.date, v.start, v.end ?? '', v.minutes, esc(v.note)].join(';'));
  }
  return c.body('﻿' + lines.join('\r\n'), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="orelavoro_${target.username}.csv"`,
  });
});
