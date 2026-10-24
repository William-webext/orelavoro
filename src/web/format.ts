const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
export const WEEKDAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
export const MONTH_SHORT = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

const pad = (n: number) => String(n).padStart(2, '0');

/** 485 → "8:05" */
export function dur(min: number): string {
  const s = min < 0 ? '-' : '';
  const a = Math.abs(min);
  return `${s}${Math.floor(a / 60)}:${pad(a % 60)}`;
}

/** 485 → "8h 05m" */
export function durLong(min: number): string {
  const a = Math.abs(min);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `${min < 0 ? '-' : ''}${h}h ${pad(m)}m`;
}

export function euro(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
}

export function rate(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €/h';
}

/** "1.234,56" / "1234.56" / "1234" → centesimi */
export function parseMoney(s: string): number | null {
  let t = s.trim().replace(/[€\s]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}

export function moneyInput(cents: number | null | undefined): string {
  if (cents == null) return '';
  return (cents / 100).toFixed(2).replace('.', ',');
}

export function itDate(date: string): string {
  return date.split('-').reverse().join('/');
}

export function parts(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

export function weekdayOf(date: string): number {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "sabato 24 ottobre" */
export function dayLong(date: string): string {
  const { m, d } = parts(date);
  return `${WEEKDAYS[weekdayOf(date)]} ${d} ${MONTHS[m - 1]}`;
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`;
}

export function clockMinutes(hm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h > 23 || mi > 59 ? null : h * 60 + mi;
}

/** Durata indicativa (senza correzione ora legale) per l'anteprima nel modulo. */
export function previewMinutes(start: string, end: string): { minutes: number; nextDay: boolean } | null {
  const s = clockMinutes(start);
  const e = clockMinutes(end);
  if (s == null || e == null || s === e) return null;
  return e < s ? { minutes: e + 1440 - s, nextDay: true } : { minutes: e - s, nextDay: false };
}

/** Ora corrente nel fuso dell'app, partendo dall'orologio del server. */
export function clockIn(tz: string, epochMs: number): { time: string; date: string } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return { time: f.format(new Date(epochMs)), date: d.format(new Date(epochMs)) };
}
