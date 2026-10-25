import { config } from './config.ts';
import { db, DAY_TYPES, type DayType, type EntryRow, type SalaryRow, type UserRow } from './db.ts';
import { HttpError } from './auth.ts';
import {
  addDays,
  addMonths,
  durationMinutes,
  fmtClock,
  fmtDuration,
  localToEpochMs,
  monthDays,
  nowLocal,
  weekday,
} from './time.ts';

export interface EntryView {
  id: number;
  date: string;
  start: string;
  end: string | null;
  /** true se la fine cade il giorno dopo */
  nextDay: boolean;
  minutes: number;
  open: boolean;
  note: string;
  /** registrata offline e sincronizzata in un secondo momento */
  offline: boolean;
}

export interface Warning {
  kind: 'open_stale' | 'open_old' | 'long_shift' | 'long_day' | 'missing_days';
  message: string;
  date?: string;
  entryId?: number;
}

export interface DayView {
  date: string;
  weekday: number;
  entries: EntryView[];
  minutes: number;
  /** tipo registrato esplicitamente */
  type: DayType | null;
  typeNote: string;
  /** riposo proposto automaticamente dalle impostazioni (non salvato) */
  autoRest: boolean;
  /** giorno passato senza alcuna registrazione né tipo */
  todo: boolean;
  future: boolean;
  today: boolean;
  warnings: Warning[];
}

export interface MonthTotals {
  minutes: number;
  workedDays: number;
  avgMinutesPerWorkedDay: number;
  byType: Record<DayType, number>;
  todoDays: number;
  openEntries: number;
}

export interface MonthView {
  ym: string;
  days: DayView[];
  totals: MonthTotals;
}

export function entryView(e: EntryRow): EntryView {
  const open = e.end_min == null;
  return {
    id: e.id,
    date: e.date,
    start: fmtClock(e.start_min),
    end: open ? null : fmtClock(e.end_min!),
    nextDay: !open && e.end_min! >= 1440,
    minutes: open ? 0 : durationMinutes(e.date, e.start_min, e.end_min!, config.tz),
    open,
    note: e.note,
    offline: !!e.offline,
  };
}

export function entriesBetween(userId: number, from: string, to: string): EntryRow[] {
  return db
    .prepare('SELECT * FROM entries WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date, start_min')
    .all(userId, from, to) as unknown as EntryRow[];
}

export function openEntry(userId: number): EntryRow | undefined {
  return db.prepare('SELECT * FROM entries WHERE user_id = ? AND end_min IS NULL ORDER BY date, start_min LIMIT 1').get(userId) as
    | EntryRow
    | undefined;
}

export function dayMinutes(userId: number, date: string): number {
  return entriesBetween(userId, date, date).reduce((s, e) => s + (e.end_min == null ? 0 : durationMinutes(e.date, e.start_min, e.end_min, config.tz)), 0);
}

/** Verifica che il turno [start, end) non si sovrapponga ad altri turni dell'utente. */
export function assertNoOverlap(userId: number, date: string, startMin: number, endMin: number | null, excludeId?: number) {
  const tz = config.tz;
  const aStart = localToEpochMs(date, startMin, tz);
  const aEnd = endMin == null ? Infinity : localToEpochMs(date, endMin, tz);
  const others = entriesBetween(userId, addDays(date, -2), addDays(date, 2));
  for (const o of others) {
    if (o.id === excludeId) continue;
    const bStart = localToEpochMs(o.date, o.start_min, tz);
    const bEnd = o.end_min == null ? Infinity : localToEpochMs(o.date, o.end_min, tz);
    if (aStart < bEnd && bStart < aEnd) {
      const when = `${o.date.split('-').reverse().join('/')} ${fmtClock(o.start_min)}–${o.end_min == null ? 'in corso' : fmtClock(o.end_min)}`;
      throw new HttpError(409, `Il turno si sovrappone a un altro già registrato (${when}).`);
    }
  }
}

export function restWeekdays(user: UserRow): number[] {
  return user.rest_weekdays
    .split(',')
    .filter((s) => s !== '')
    .map(Number)
    .filter((n) => n >= 0 && n <= 6);
}

export function buildMonth(user: UserRow, ym: string): MonthView {
  const dates = monthDays(ym);
  const first = dates[0];
  const last = dates[dates.length - 1];
  const entries = entriesBetween(user.id, first, last);
  const types = db.prepare('SELECT date, type, note FROM day_types WHERE user_id = ? AND date >= ? AND date <= ?').all(user.id, first, last) as unknown as {
    date: string;
    type: DayType;
    note: string;
  }[];
  const typeByDate = new Map(types.map((t) => [t.date, t]));
  const byDate = new Map<string, EntryView[]>();
  for (const e of entries) {
    const arr = byDate.get(e.date) ?? [];
    arr.push(entryView(e));
    byDate.set(e.date, arr);
  }
  const now = nowLocal(config.tz);
  const rest = user.autorest ? new Set(restWeekdays(user)) : new Set<number>();

  const totals: MonthTotals = {
    minutes: 0,
    workedDays: 0,
    avgMinutesPerWorkedDay: 0,
    byType: { ferie: 0, malattia: 0, permesso: 0, festivo: 0, riposo: 0 },
    todoDays: 0,
    openEntries: 0,
  };

  const days: DayView[] = dates.map((date) => {
    const list = byDate.get(date) ?? [];
    const minutes = list.reduce((s, e) => s + e.minutes, 0);
    const t = typeByDate.get(date);
    const wd = weekday(date);
    const future = date > now.date;
    const today = date === now.date;
    const autoRest = !t && list.length === 0 && rest.has(wd);
    const todo = !t && list.length === 0 && !autoRest && date < now.date;
    const warnings: Warning[] = [];
    for (const e of list) {
      if (e.open) {
        totals.openEntries += 1;
        if (date < now.date) warnings.push({ kind: 'open_old', message: `Ingresso delle ${e.start} senza uscita.`, date, entryId: e.id });
      } else if (e.minutes > config.maxShiftHours * 60) {
        warnings.push({ kind: 'long_shift', message: `Turno insolitamente lungo (${fmtDuration(e.minutes)}).`, date, entryId: e.id });
      }
    }
    if (minutes > config.maxDayHours * 60) {
      warnings.push({ kind: 'long_day', message: `Totale giornaliero molto alto (${fmtDuration(minutes)}).`, date });
    }
    totals.minutes += minutes;
    if (minutes > 0) totals.workedDays += 1;
    if (t) totals.byType[t.type] += 1;
    if (todo) totals.todoDays += 1;
    return {
      date,
      weekday: wd,
      entries: list,
      minutes,
      type: t?.type ?? null,
      typeNote: t?.note ?? '',
      autoRest,
      todo,
      future,
      today,
      warnings,
    };
  });
  totals.avgMinutesPerWorkedDay = totals.workedDays ? Math.round(totals.minutes / totals.workedDays) : 0;
  return { ym, days, totals };
}

export function getSalary(userId: number, ym: string): SalaryRow | undefined {
  return db.prepare('SELECT * FROM salaries WHERE user_id = ? AND month = ?').get(userId, ym) as SalaryRow | undefined;
}

export interface Rates {
  /** euro/ora, arrotondati a 2 decimali */
  net: number | null;
  gross: number | null;
}

export function hourlyRates(netCents: number | null | undefined, grossCents: number | null | undefined, minutes: number): Rates {
  if (!minutes) return { net: null, gross: null };
  const per = (c: number | null | undefined) => (c == null ? null : Math.round((c / 100 / (minutes / 60)) * 100) / 100);
  return { net: per(netCents), gross: per(grossCents) };
}

export interface SalaryView {
  ym: string;
  netCents: number | null;
  grossCents: number | null;
  note: string;
  minutes: number;
  rates: Rates;
}

export function salaryView(userId: number, ym: string, minutes: number): SalaryView {
  const s = getSalary(userId, ym);
  return {
    ym,
    netCents: s?.net_cents ?? null,
    grossCents: s?.gross_cents ?? null,
    note: s?.note ?? '',
    minutes,
    rates: hourlyRates(s?.net_cents, s?.gross_cents, minutes),
  };
}

export interface YearMonth {
  ym: string;
  minutes: number;
  workedDays: number;
  todoDays: number;
  netCents: number | null;
  grossCents: number | null;
  rates: Rates;
}

export function buildYear(user: UserRow, year: number) {
  const months: YearMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    const mv = buildMonth(user, ym);
    const sal = getSalary(user.id, ym);
    months.push({
      ym,
      minutes: mv.totals.minutes,
      workedDays: mv.totals.workedDays,
      todoDays: mv.totals.todoDays,
      netCents: sal?.net_cents ?? null,
      grossCents: sal?.gross_cents ?? null,
      rates: hourlyRates(sal?.net_cents, sal?.gross_cents, mv.totals.minutes),
    });
  }
  // La paga oraria annuale usa solo i mesi per cui è stato inserito lo stipendio.
  const paid = months.filter((x) => x.netCents != null && x.minutes > 0);
  const paidMinutes = paid.reduce((s, x) => s + x.minutes, 0);
  const netSum = paid.reduce((s, x) => s + (x.netCents ?? 0), 0);
  const grossAll = paid.every((x) => x.grossCents != null) && paid.length > 0;
  const grossSum = grossAll ? paid.reduce((s, x) => s + (x.grossCents ?? 0), 0) : null;
  return {
    year,
    months,
    totals: {
      minutes: months.reduce((s, x) => s + x.minutes, 0),
      workedDays: months.reduce((s, x) => s + x.workedDays, 0),
      netCents: paid.length ? netSum : null,
      grossCents: grossSum,
      paidMonths: paid.length,
      rates: hourlyRates(paid.length ? netSum : null, grossSum, paidMinutes),
    },
  };
}

/** Avvisi per la schermata iniziale. */
export function buildWarnings(user: UserRow): Warning[] {
  const now = nowLocal(config.tz);
  const nowMs = Date.now();
  const out: Warning[] = [];
  const open = openEntry(user.id);
  if (open) {
    const elapsedMin = Math.round((nowMs - localToEpochMs(open.date, open.start_min, config.tz)) / 60000);
    if (open.date < now.date || elapsedMin >= config.maxShiftHours * 60) {
      const [y, m, d] = open.date.split('-');
      out.push({
        kind: 'open_stale',
        message: `Hai segnato l'ingresso del ${d}/${m}/${y} alle ${fmtClock(open.start_min)} ma non l'uscita.`,
        date: open.date,
        entryId: open.id,
      });
    }
  }
  const from = addDays(now.date, -30);
  const recent = entriesBetween(user.id, from, now.date);
  for (const e of recent) {
    if (e.end_min == null) continue;
    const min = durationMinutes(e.date, e.start_min, e.end_min, config.tz);
    if (min > config.maxShiftHours * 60) {
      out.push({ kind: 'long_shift', message: `Turno del ${e.date.split('-').reverse().join('/')} molto lungo (${fmtDuration(min)}): controlla.`, date: e.date, entryId: e.id });
    }
  }
  // giorni passati senza registrazione negli ultimi 7
  const ym = now.date.slice(0, 7);
  const months = new Set([ym, addMonths(ym, -1)]);
  let missing = 0;
  const lastWeek = addDays(now.date, -7);
  for (const m of months) {
    for (const d of buildMonth(user, m).days) {
      if (d.todo && d.date >= lastWeek) missing += 1;
    }
  }
  if (missing > 0) {
    out.push({ kind: 'missing_days', message: `${missing === 1 ? '1 giorno' : `${missing} giorni`} senza registrazione negli ultimi 7 giorni.` });
  }
  return out;
}

export function isDayType(s: unknown): s is DayType {
  return typeof s === 'string' && (DAY_TYPES as string[]).includes(s);
}
