// Timbrature "a prova di NAS spento": se il server non risponde, ingresso e uscita
// vengono salvati sul telefono con l'ora del momento e inviati appena possibile.
// L'invio è idempotente (clientId), quindi non si duplica nulla se una risposta si perde.
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, isReachable, onReachableChange, type Status, type User } from './api.ts';

export interface QueuedPunch {
  clientId: string;
  kind: 'in' | 'out';
  /** istante reale della timbratura (ms epoch, corretto con lo scarto dall'orologio del server) */
  at: number;
  userId: number;
  /** motivo per cui il server l'ha rifiutata (resta in lista finché non la sistemi) */
  error?: string;
}

const K_QUEUE = 'ol_queue';
const K_SKEW = 'ol_skew';
const K_STATUS = 'ol_status';
const K_ME = 'ol_me';

function load<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage pieno o non disponibile: si lavora comunque in memoria */
  }
}

let queue: QueuedPunch[] = load<QueuedPunch[]>(K_QUEUE, []);
let skew = load<number>(K_SKEW, 0);
const subs = new Set<() => void>();

function persist() {
  save(K_QUEUE, queue);
  subs.forEach((f) => f());
}

// ---------- orologio ----------

/** Ora attuale corretta con lo scarto dall'ultimo orologio del server visto (se il telefono è sfasato). */
export function correctedNow(): number {
  return Date.now() + skew;
}

export function noteServerTime(serverEpochMs: number) {
  skew = serverEpochMs - Date.now();
  save(K_SKEW, skew);
}

// ---------- cache per l'uso offline ----------

export function cacheStatus(userId: number, st: Status) {
  save(K_STATUS, { userId, st });
}

export function cachedStatus(userId: number): Status | null {
  const c = load<{ userId: number; st: Status } | null>(K_STATUS, null);
  return c && c.userId === userId ? c.st : null;
}

export interface MeCache {
  user: User;
  mailConfigured: boolean;
  tz: string;
}

export function cacheMe(me: MeCache) {
  save(K_ME, me);
}

export function cachedMe(): MeCache | null {
  return load<MeCache | null>(K_ME, null);
}

/** Al logout si cancellano le cache ma NON la coda: le timbrature in attesa non vanno perse. */
export function clearCaches() {
  try {
    localStorage.removeItem(K_STATUS);
    localStorage.removeItem(K_ME);
  } catch {
    /* ignora */
  }
}

/**
 * Chiede al browser di non cancellare i dati del sito (coda delle timbrature, cache).
 * Chrome/Android la concede di norma alle app installate; su iPhone dipende dalla versione.
 * Non mostra nulla all'utente e non fa danni se rifiutata.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ---------- coda ----------

const byTime = (a: QueuedPunch, b: QueuedPunch) => a.at - b.at;
export const pendingFor = (userId: number) => queue.filter((q) => q.userId === userId && !q.error).sort(byTime);
export const failedFor = (userId: number) => queue.filter((q) => q.userId === userId && q.error).sort(byTime);

export function discardPunch(clientId: string) {
  queue = queue.filter((q) => q.clientId !== clientId);
  persist();
}

export function retryPunch(clientId: string) {
  const q = queue.find((x) => x.clientId === clientId);
  if (q) delete q.error;
  persist();
}

export function usePunchQueue(userId: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  return { pending: pendingFor(userId), failed: failedFor(userId) };
}

export function useReachable(): boolean {
  const [r, setR] = useState(isReachable());
  useEffect(() => onReachableChange(() => setR(isReachable())), []);
  return r;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Timbra ingresso/uscita. Se il server non è raggiungibile (e `canQueue`) la
 * timbratura resta sul telefono. Restituisce 'queued' in quel caso.
 */
export async function punch(kind: 'in' | 'out', userId: number, canQueue: boolean): Promise<'done' | 'queued'> {
  const at = correctedNow(); // l'istante del tocco, non quello della risposta
  const clientId = newId();
  try {
    // Se già si sa che il server non risponde (o il telefono è offline) non si aspetta a lungo.
    const knownDown = !isReachable() || navigator.onLine === false;
    await api.post(`/clock/${kind}`, { clientId }, { timeoutMs: knownDown ? 3000 : 12000 });
    return 'done';
  } catch (e) {
    if (e instanceof ApiError && e.status === 0 && canQueue) {
      // Se il server avesse già registrato la richiesta, l'invio successivo con lo
      // stesso clientId viene riconosciuto come duplicato e ignorato.
      queue.push({ clientId, kind, at, userId });
      persist();
      return 'queued';
    }
    throw e;
  }
}

let flushing: Promise<void> | null = null;

/** Invia al server le timbrature in coda. Può essere chiamata liberamente: non fa nulla se non serve. */
export function flush(userId: number): Promise<void> {
  if (flushing) return flushing;
  const items = pendingFor(userId);
  if (items.length === 0) return Promise.resolve();
  flushing = (async () => {
    try {
      const r = await api.post<{ results: { clientId: string; status: 'ok' | 'duplicate' | 'error'; message: string }[] }>(
        '/clock/sync',
        { events: items.map(({ clientId, kind, at }) => ({ clientId, kind, at })) },
        { noAs: true, timeoutMs: 20000 },
      );
      for (const res of r.results) {
        if (res.status === 'error') {
          const q = queue.find((x) => x.clientId === res.clientId);
          if (q) q.error = res.message;
        } else {
          queue = queue.filter((x) => x.clientId !== res.clientId);
        }
      }
      persist();
    } catch {
      /* ancora irraggiungibile o sessione scaduta: restano in coda e si riprova */
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Controlla ogni 15 s se il server è tornato e invia la coda; riprova anche quando l'app torna in primo piano. */
export function startBackgroundSync(userId: number): () => void {
  const tick = async () => {
    const hasPending = pendingFor(userId).length > 0;
    if (!hasPending && isReachable()) return;
    if (!isReachable()) {
      try {
        await api.get('/health', { timeoutMs: 6000 });
      } catch {
        return;
      }
    }
    await flush(userId);
  };
  const timer = setInterval(tick, 15000);
  const onVisible = () => document.visibilityState === 'visible' && tick();
  window.addEventListener('online', tick);
  document.addEventListener('visibilitychange', onVisible);
  tick();
  return () => {
    clearInterval(timer);
    window.removeEventListener('online', tick);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
