export type DayType = 'ferie' | 'malattia' | 'permesso' | 'festivo' | 'riposo';
export const DAY_TYPES: DayType[] = ['ferie', 'malattia', 'permesso', 'festivo', 'riposo'];
export const DAY_TYPE_LABEL: Record<DayType, string> = {
  ferie: 'Ferie',
  malattia: 'Malattia',
  permesso: 'Permesso',
  festivo: 'Festivo',
  riposo: 'Riposo',
};

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: 'user' | 'superadmin';
  email: string;
  autorest: boolean;
  restWeekdays: number[];
  notifyOpen: boolean;
  monthlyReport: boolean;
}

export interface Entry {
  id: number;
  date: string;
  start: string;
  end: string | null;
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

export interface Day {
  date: string;
  weekday: number;
  entries: Entry[];
  minutes: number;
  type: DayType | null;
  typeNote: string;
  autoRest: boolean;
  todo: boolean;
  future: boolean;
  today: boolean;
  warnings: Warning[];
}

export interface Totals {
  minutes: number;
  workedDays: number;
  avgMinutesPerWorkedDay: number;
  byType: Record<DayType, number>;
  todoDays: number;
  openEntries: number;
}

export interface Month {
  ym: string;
  days: Day[];
  totals: Totals;
}

export interface Rates {
  net: number | null;
  gross: number | null;
}

export interface Salary {
  ym: string;
  netCents: number | null;
  grossCents: number | null;
  note: string;
  minutes: number;
  rates: Rates;
}

export interface Status {
  actor: User;
  target: User;
  now: { date: string; time: string; epochMs: number };
  open: (Entry & { elapsedMinutes: number; startEpochMs: number }) | null;
  today: Day;
  monthMinutes: number;
  warnings: Warning[];
  mailConfigured: boolean;
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

export interface Year {
  year: number;
  months: YearMonth[];
  totals: { minutes: number; workedDays: number; netCents: number | null; grossCents: number | null; paidMonths: number; rates: Rates };
}

export interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: 'user' | 'superadmin';
  active: boolean;
  locked: boolean;
  createdAt: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  target: string;
  action: string;
  detail: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- "visualizza come" (solo superadmin) ----------

let viewAs: number | null = null;
try {
  const s = sessionStorage.getItem('ol_view_as');
  viewAs = s ? Number(s) : null;
} catch {
  /* storage non disponibile */
}

export function getViewAs() {
  return viewAs;
}

export function setViewAs(id: number | null) {
  viewAs = id;
  try {
    if (id == null) sessionStorage.removeItem('ol_view_as');
    else sessionStorage.setItem('ol_view_as', String(id));
  } catch {
    /* ignora */
  }
}

// ---------- raggiungibilità del server ----------

let reachable = true;
const reachSubs = new Set<() => void>();

function setReachable(v: boolean) {
  if (v === reachable) return;
  reachable = v;
  reachSubs.forEach((f) => f());
}

export function isReachable() {
  return reachable;
}

export function onReachableChange(fn: () => void) {
  reachSubs.add(fn);
  return () => {
    reachSubs.delete(fn);
  };
}

// ---------- chiamate ----------

/** Chi vuole conoscere l'ora del server (per correggere un orologio del telefono sballato). */
let timeListener: ((serverMs: number, clientAt: number) => void) | null = null;
export function onServerTime(fn: (serverMs: number, clientAt: number) => void) {
  timeListener = fn;
}

const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(fn: () => void) {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

function url(path: string, noAs = false): string {
  if (viewAs == null || noAs) return '/api' + path;
  return '/api' + path + (path.includes('?') ? '&' : '?') + 'as=' + viewAs;
}

interface Opts {
  /** ignora "visualizza come": operazione sempre sul proprio utente */
  noAs?: boolean;
  timeoutMs?: number;
}

/**
 * status 0 = server non raggiungibile (rete assente, timeout, tunnel o NAS spenti):
 * le pagine HTML di errore di Cloudflare (502/52x) valgono come "non raggiungibile".
 */
async function request<T>(method: string, path: string, body?: unknown, opts: Opts = {}): Promise<T> {
  let res: Response;
  const sentAt = Date.now();
  try {
    res = await fetch(url(path, opts.noAs), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
    });
  } catch {
    setReachable(false);
    throw new ApiError(0, 'Server non raggiungibile. Controlla la connessione.');
  }
  // Le risposte del nostro server sono sempre JSON. Qualsiasi altra cosa (pagina di errore di
  // Cloudflare, portale "accedi al Wi-Fi", blocco di un proxy) vuol dire che il server vero
  // non è stato raggiunto: va trattata come "non raggiungibile", non come un errore dell'app.
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  if (!isJson) {
    setReachable(false);
    throw new ApiError(0, 'Server non raggiungibile (risposta non valida dalla rete).');
  }
  // L'intestazione Date delle risposte del nostro server dà l'ora vera (precisione ~1 s).
  const dateHeader = res.headers.get('date');
  if (dateHeader && !(Number(res.headers.get('age') ?? 0) > 5)) {
    const ms = Date.parse(dateHeader);
    if (Number.isFinite(ms)) timeListener?.(ms + 500, (sentAt + Date.now()) / 2);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    // connessione caduta a metà risposta, o tempo scaduto durante la lettura
    setReachable(false);
    throw new ApiError(0, 'Risposta interrotta: server non raggiungibile.');
  }
  setReachable(true);
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? 'Errore imprevisto.';
    if (res.status === 401 && path !== '/login') unauthorizedListeners.forEach((f) => f());
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: Opts) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body: unknown = {}, opts?: Opts) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** URL per i download (rispetta "visualizza come"). */
  fileUrl: (path: string) => url(path),
};
