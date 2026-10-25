// Timbrature "a prova di NAS spento": se il server non risponde, ingresso e uscita
// vengono salvati sul telefono con l'ora del momento e inviati appena possibile.
// L'invio è idempotente (clientId), quindi non si duplica nulla se una risposta si perde.
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, isReachable, onReachableChange, onServerTime, type Status, type User } from './api.ts';

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

let exactAt = 0;

/**
 * Registra lo scarto tra l'orologio del telefono e quello del server.
 * `exact`: l'ora arriva dal corpo di una risposta (precisa); altrimenti dall'intestazione Date
 * (±1 s), che non sovrascrive una misura precisa recente.
 */
export function noteServerTime(serverEpochMs: number, clientAt = Date.now(), exact = true) {
  if (!exact && Date.now() - exactAt < 60000) return;
  if (exact) exactAt = Date.now();
  skew = serverEpochMs - clientAt;
  save(K_SKEW, skew);
}

// ogni risposta del server corregge l'orologio: un telefono sballato è a posto già dopo il login
onServerTime((serverMs, clientAt) => noteServerTime(serverMs, clientAt, false));

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
 * Timbra ingresso/uscita.
 *  - Se ci sono già timbrature in attesa, la nuova si accoda DIETRO di loro e la coda parte in
 *    ordine: se passasse davanti, il server la rifiuterebbe ("nessun ingresso aperto").
 *  - Se il server non è raggiungibile (e `canQueue`) la timbratura resta sul telefono.
 * Restituisce 'queued' se è ancora sul telefono, 'done' se il server l'ha registrata. Se il server
 * la rifiuta per una regola (es. ora nel futuro) lancia un ApiError come per una timbratura normale.
 */
export async function punch(kind: 'in' | 'out', userId: number, canQueue: boolean): Promise<'done' | 'queued'> {
  const at = correctedNow(); // l'istante del tocco, non quello della risposta
  const clientId = newId();

  if (canQueue && pendingFor(userId).length > 0) {
    queue.push({ clientId, kind, at, userId });
    persist();
    await flush(userId);
    return settle(clientId);
  }

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

/** Esito di una timbratura messa in coda dopo il tentativo di invio. */
function settle(clientId: string): 'done' | 'queued' {
  const q = queue.find((x) => x.clientId === clientId);
  if (!q) return 'done';
  if (q.error) {
    // rifiutata dal server: come per una timbratura normale, si mostra l'errore e non resta in lista
    queue = queue.filter((x) => x !== q);
    persist();
    throw new ApiError(409, q.error);
  }
  return 'queued';
}

let flushing: Promise<void> | null = null;

/** Invia al server le timbrature in coda. Può essere chiamata liberamente: non fa nulla se non serve. */
export function flush(userId: number): Promise<void> {
  if (flushing) {
    // un invio è già in corso: al suo termine si riparte se nel frattempo si è accodato altro
    return flushing.then(() => (pendingFor(userId).length > 0 ? flush(userId) : undefined));
  }
  if (pendingFor(userId).length === 0) return Promise.resolve();
  flushing = (async () => {
    try {
      // più giri se, mentre si inviava, altre timbrature si sono accodate
      for (let round = 0; round < 4; round++) {
        const items = pendingFor(userId);
        if (items.length === 0) break;
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
      }
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
