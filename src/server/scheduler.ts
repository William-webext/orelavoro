import fs from 'node:fs';
import path from 'node:path';
import { cleanupSessions } from './auth.ts';
import { entryView, openEntry } from './calc.ts';
import { backupTo, db, type UserRow } from './db.ts';
import { config, smtpConfigured } from './config.ts';
import { htmlWrap, sendMail } from './mail.ts';
import { monthReport, renderPdf, reportFilename } from './reports.ts';
import { addMonths, fmtDuration, localToEpochMs, monthLabel, nowLocal } from './time.ts';

const backupDir = path.join(config.dataDir, 'backups');

function alreadySent(userId: number, kind: string, ref: string): boolean {
  return !!db.prepare('SELECT 1 FROM mail_log WHERE user_id = ? AND kind = ? AND ref = ?').get(userId, kind, ref);
}

function markSent(userId: number, kind: string, ref: string) {
  db.prepare('INSERT OR IGNORE INTO mail_log (user_id, kind, ref, sent_at) VALUES (?,?,?,?)').run(userId, kind, ref, Date.now());
}

function link(): string {
  return config.appUrl ? `<p><a href="${config.appUrl}">Apri Ore Lavoro</a></p>` : '';
}

/** Promemoria: ingresso senza uscita da troppo tempo (una sola mail per ingresso). */
async function openEntryReminders() {
  const users = db.prepare("SELECT * FROM users WHERE active = 1 AND notify_open = 1 AND email != ''").all() as unknown as UserRow[];
  for (const u of users) {
    const open = openEntry(u.id);
    if (!open) continue;
    const elapsedH = (Date.now() - localToEpochMs(open.date, open.start_min, config.tz)) / 3600000;
    if (elapsedH < config.maxShiftHours) continue;
    const ref = String(open.id);
    if (alreadySent(u.id, 'open', ref)) continue;
    const v = entryView(open);
    const when = `${open.date.split('-').reverse().join('/')} alle ${v.start}`;
    await sendMail({
      to: u.email,
      subject: 'Hai dimenticato di segnare l’uscita?',
      text: `Ciao ${u.display_name}, risulta un ingresso del ${when} senza uscita (${Math.floor(elapsedH)} ore fa). Apri l'app per completarlo.${config.appUrl ? '\n' + config.appUrl : ''}`,
      html: htmlWrap('Uscita non segnata', `<p>Ciao ${u.display_name}, risulta un ingresso del <b>${when}</b> senza uscita (${Math.floor(elapsedH)} ore fa).</p><p>Apri l'app per completarlo.</p>${link()}`),
    });
    markSent(u.id, 'open', ref);
    console.log(`[mail] promemoria uscita inviato a ${u.username}`);
  }
}

/** Il primo giorno del mese manda il report del mese precedente a chi lo ha chiesto. */
async function monthlyReports() {
  const now = nowLocal(config.tz);
  if (!now.date.endsWith('-01') || now.minutes < 7 * 60) return;
  const ym = addMonths(now.date.slice(0, 7), -1);
  const users = db.prepare("SELECT * FROM users WHERE active = 1 AND monthly_report = 1 AND email != ''").all() as unknown as UserRow[];
  for (const u of users) {
    if (alreadySent(u.id, 'monthly', ym)) continue;
    const r = monthReport(u, ym);
    const pdf = await renderPdf(r, true);
    const t = r.month.totals;
    await sendMail({
      to: u.email,
      subject: `Report ore ${monthLabel(ym)}`,
      text: `Ore totali: ${fmtDuration(t.minutes)} su ${t.workedDays} giorni lavorati. Il dettaglio è in allegato.${t.todoDays ? `\nAttenzione: ${t.todoDays} giorni non compilati.` : ''}`,
      html: htmlWrap(
        `Report ore – ${monthLabel(ym)}`,
        `<p>Ore totali: <b>${fmtDuration(t.minutes)}</b> su ${t.workedDays} giorni lavorati.</p>${t.todoDays ? `<p style="color:#b42318">Attenzione: ${t.todoDays} giorni non compilati.</p>` : ''}<p>Il dettaglio è in allegato.</p>${link()}`,
      ),
      attachments: [{ filename: reportFilename(r, true, 'pdf'), content: pdf, contentType: 'application/pdf' }],
    });
    markSent(u.id, 'monthly', ym);
    console.log(`[mail] report ${ym} inviato a ${u.username}`);
  }
}

/** Una copia del database al giorno (dopo le 03:00), conserva le ultime N. */
function nightlyBackup() {
  const now = nowLocal(config.tz);
  if (now.minutes < 3 * 60) return;
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `orelavoro_${now.date}.db`);
  if (fs.existsSync(file)) return;
  backupTo(file);
  console.log(`[backup] creato ${path.basename(file)}`);
  const all = fs
    .readdirSync(backupDir)
    .filter((f) => /^orelavoro_\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - config.backupKeep))) fs.rmSync(path.join(backupDir, old), { force: true });
}

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    cleanupSessions();
    nightlyBackup();
    if (smtpConfigured) {
      await openEntryReminders();
      await monthlyReports();
    }
  } catch (e) {
    console.error('[scheduler]', e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

export function startScheduler(): () => void {
  const first = setTimeout(tick, 5000);
  const timer = setInterval(tick, 5 * 60000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
