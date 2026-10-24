/**
 * Utilità di data/ora. Le date di lavoro sono stringhe locali "YYYY-MM-DD",
 * gli orari sono minuti dalla mezzanotte locale di quella data (anche > 1440
 * per i turni a cavallo della mezzanotte). La durata è calcolata sugli istanti
 * reali, quindi è corretta anche nelle notti del cambio ora legale.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function parts(epochMs: number, tz: string) {
  const o: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') o[p.type] = Number(p.value);
  }
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Scarto UTC (in minuti) del fuso all'istante dato. */
export function tzOffsetMinutes(epochMs: number, tz: string): number {
  const p = parts(epochMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60000);
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function parseDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

/** Istante (ms epoch) corrispondente a data locale + minuti dalla mezzanotte. */
export function localToEpochMs(date: string, minutes: number, tz: string): number {
  const { y, m, d } = parseDate(date);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off1 = tzOffsetMinutes(guess, tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(t, tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return t;
}

export function epochToLocal(epochMs: number, tz: string): { date: string; minutes: number } {
  const p = parts(epochMs, tz);
  return { date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`, minutes: p.hour * 60 + p.minute };
}

export function nowLocal(tz: string, nowMs = Date.now()) {
  return epochToLocal(nowMs, tz);
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function diffDays(a: string, b: string): number {
  const pa = parseDate(a);
  const pb = parseDate(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

/** 0 = domenica … 6 = sabato */
export function weekday(date: string): number {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const { y, m, d } = parseDate(date);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidMonth(ym: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(ym);
}

export function monthDays(ym: string): string[] {
  const [y, m] = ym.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${pad2(i + 1)}`);
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}`;
}

/** Durata in minuti reali tra inizio e fine di un turno. */
export function durationMinutes(date: string, startMin: number, endMin: number, tz: string): number {
  return Math.round((localToEpochMs(date, endMin, tz) - localToEpochMs(date, startMin, tz)) / 60000);
}

export function parseHM(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minuti → "HH:MM" (mod 24h, per gli orari dentro la giornata). */
export function fmtClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** Durata in minuti → "h:mm". */
export function fmtDuration(min: number): string {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(min);
  return `${sign}${Math.floor(a / 60)}:${pad2(a % 60)}`;
}

const MONTHS = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const WEEKDAYS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function weekdayLabel(date: string, short = false): string {
  const w = WEEKDAYS[weekday(date)];
  return short ? w.slice(0, 3) : w;
}

export function euro(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
}
