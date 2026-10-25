// Un "telefono" simulato: esegue il VERO codice client della coda offline (src/web/api.ts e
// offline.ts) contro il vero server, con una rete difettosa iniettata a livello di fetch.
import { workerData, parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const D = workerData;
const ROOT = D.root;
const BASE = `http://127.0.0.1:${D.port}`;
const t0 = performance.now();
const elapsed = () => performance.now() - t0;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(D.seed);
const between = (a, b) => a + rnd() * (b - a);

// ---------- errori non gestiti ----------
const exceptions = [];
process.on('unhandledRejection', (e) => exceptions.push('unhandledRejection: ' + (e?.stack ?? e)));
process.on('uncaughtException', (e) => exceptions.push('uncaughtException: ' + (e?.stack ?? e)));

// ---------- orologio del telefono (può essere sballato) ----------
const trueNow = Date.now.bind(Date);
if (D.skewMs) {
  const base = Date.now.bind(Date);
  Date.now = () => base() + D.skewMs;
}

// ---------- ambiente "browser" ----------
function makeStorage(map) {
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}
const lsMap = new Map();
const ssMap = new Map();
const listeners = { window: new Map(), document: new Map() };
const addL = (which) => (type, fn) => {
  if (!listeners[which].has(type)) listeners[which].set(type, new Set());
  listeners[which].get(type).add(fn);
};
const remL = (which) => (type, fn) => listeners[which].get(type)?.delete(fn);
function dispatch(which, type) {
  for (const fn of [...(listeners[which].get(type) ?? [])]) {
    try {
      fn(new Event(type));
    } catch (e) {
      exceptions.push(`listener ${type}: ${e?.stack ?? e}`);
    }
  }
}
const doc = { visibilityState: 'visible', addEventListener: addL('document'), removeEventListener: remL('document') };
const nav = { onLine: true, userAgent: D.device.ua, storage: { persisted: async () => false, persist: async () => true } };
const defineGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
defineGlobal('localStorage', makeStorage(lsMap));
defineGlobal('sessionStorage', makeStorage(ssMap));
defineGlobal('window', { addEventListener: addL('window'), removeEventListener: remL('window') });
defineGlobal('document', doc);
defineGlobal('navigator', nav);

// UUID tracciati: ogni tocco genera esattamente un clientId
const realCrypto = globalThis.crypto;
const generatedIds = [];
defineGlobal('crypto', {
  randomUUID: () => {
    const id = realCrypto.randomUUID();
    generatedIds.push(id);
    return id;
  },
});

// timer sospesi quando l'app è in background (iPhone)
let suspended = false;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => realSetInterval(() => !suspended && fn(...args), ms);

// ---------- rete difettosa ----------
const realFetch = globalThis.fetch;
let healed = true; // vero = rete perfetta (login iniziale e fase finale)
let cookie = '';
const trace = [];
const T = (m) => trace.push(`${(elapsed() / 1000).toFixed(1)}s ${m}`);
const stats = { requests: 0, refused: 0, hang: 0, html502: 0, captive: 0, lostResponse: 0, truncated: 0, ok: 0 };

const abortErr = () => new DOMException('The operation was aborted', 'AbortError');
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortErr());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(abortErr());
      },
      { once: true },
    );
  });
}
function hang(signal) {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(abortErr());
    signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
  });
}

function decide() {
  if (healed) return 'ok';
  const t = elapsed();
  const o = D.outages.find((w) => t >= w.start && t < w.end);
  if (o) return o.mode;
  const n = D.net;
  const r = rnd();
  let acc = 0;
  for (const [mode, p] of [
    ['refused', n.drop],
    ['hang', n.hang],
    ['lostResponse', n.lostResponse],
    ['truncated', n.truncated],
    ['html502', n.html502 ?? 0],
    ['captive', n.captive ?? 0],
  ]) {
    acc += p || 0;
    if (r < acc) return mode;
  }
  return 'ok';
}

async function chaosFetch(input, init = {}) {
  const u = new URL(String(input), BASE);
  const signal = init.signal;
  stats.requests++;
  const mode = decide();
  let bodyNote = "";
  try { const b = init.body ? JSON.parse(init.body) : null; if (b?.events) bodyNote = b.events.map((e) => e.kind + "@" + new Date(e.at).toISOString().slice(14, 19)).join(","); else if (b?.clientId) bodyNote = b.clientId.slice(0, 4); } catch {}
  T(`${init.method ?? "GET"} ${u.pathname} [${mode}] ${bodyNote}`);
  const [la, lb] = healed ? [5, 20] : D.net.lat;
  const latIn = between(la, lb) / 2;
  const latOut = between(la, lb) / 2;
  await sleep(latIn, signal);

  if (mode === 'refused') {
    stats.refused++;
    throw new TypeError('fetch failed');
  }
  if (mode === 'hang') {
    stats.hang++;
    return hang(signal);
  }
  if (mode === 'html502') {
    stats.html502++;
    await sleep(latOut, signal);
    return new Response('<html><body>502 Bad Gateway (cloudflare)</body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
  }
  if (mode === 'captive') {
    stats.captive++;
    await sleep(latOut, signal);
    return new Response('<html><body>Accedi alla rete Wi-Fi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }

  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('cookie', cookie);
  headers.set('cf-connecting-ip', `10.${(D.id >> 8) & 255}.${D.id & 255}.7`);
  const res = await realFetch(BASE + u.pathname + u.search, { method: init.method ?? 'GET', headers, body: init.body, signal });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) if (c.startsWith('ol_session=')) cookie = c.split(';')[0];

  if (mode === 'lostResponse') {
    // il server ha già elaborato la richiesta, ma la risposta non arriva
    await res.arrayBuffer().catch(() => {});
    stats.lostResponse++;
    if (rnd() < 0.5) throw new TypeError('network connection was lost');
    return hang(signal);
  }
  await sleep(latOut, signal);
  if (mode === 'truncated') {
    stats.truncated++;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"entr'));
        c.error(new TypeError('terminated'));
      },
    });
    return new Response(body, { status: res.status, headers: { 'content-type': 'application/json' } });
  }
  stats.ok++;
  // la risposta porta l'ora (virtuale) del server nell'intestazione Date, come farebbe il vero server
  const h2 = new Headers(res.headers);
  h2.set('date', new Date(trueNow()).toUTCString());
  return new Response(res.body, { status: res.status, headers: h2 });
}
defineGlobal('fetch', chaosFetch);

// ---------- app ----------
const apiMod = await import(pathToFileURL(path.join(ROOT, 'src/web/api.ts')).href);
const { api, ApiError } = apiMod;
const offlineUrl = pathToFileURL(path.join(ROOT, 'src/web/offline.ts')).href;
let off = await import(offlineUrl);
let appLaunches = 0;
let stopSync = () => {};
let userId = 0;

async function launchApp({ wipe = false } = {}) {
  stopSync();
  if (wipe) lsMap.clear();
  off = await import(`${offlineUrl}?launch=${++appLaunches}`);
  stopSync = off.startBackgroundSync(userId);
  await off.flush(userId).catch(() => {});
}

function setBackground(on) {
  suspended = on;
  doc.visibilityState = on ? 'hidden' : 'visible';
  if (!on) {
    dispatch('document', 'visibilitychange');
    if (rnd() < 0.3) dispatch('window', 'online');
  }
}

const taps = [];
try {
  // login e primo collegamento con rete perfetta (come la prima apertura dell'app)
  const login = await api.post('/login', { username: D.username, pin: D.pin });
  userId = login.user.id;
  const st = await api.get('/status');
  if (D.syncedBefore) {
    off.noteServerTime(st.now.epochMs);
    off.cacheStatus(userId, st);
  }
  await launchApp();

  healed = false;
  for (let i = 0; i < D.taps.length; i++) {
    const tap = D.taps[i];
    // l'app può andare in background tra un tocco e l'altro
    if (tap.background) {
      const goAt = Math.max(elapsed() + 300, tap.at - tap.background.seconds * 1000 - 800);
      await sleep(goAt - elapsed());
      setBackground(true);
      await sleep(Math.max(0, tap.at - 600 - elapsed()));
      setBackground(false);
      if (tap.background.kill) await launchApp({ wipe: !!tap.background.evict });
    }
    await sleep(Math.max(0, tap.at - elapsed()));

    const trueAt = trueNow();
    const rec = { i, kind: tap.kind, trueAt, outcome: '', clientId: '', message: '' };
    const before = generatedIds.length;
    try {
      const r = await off.punch(tap.kind, userId, true);
      rec.outcome = r; // 'done' | 'queued'
    } catch (e) {
      if (e instanceof ApiError || e?.name === 'ApiError') {
        rec.outcome = 'apierr';
        rec.message = `${e.status}: ${e.message}`;
      } else {
        rec.outcome = 'exception';
        rec.message = String(e?.stack ?? e).slice(0, 300);
      }
    }
    rec.clientId = generatedIds[before] ?? '';
    T(`TOCCO #${i} ${tap.kind} -> ${rec.outcome} ${rec.message}`);
    taps.push(rec);
  }

  // fase finale: la rete torna a posto e l'utente riapre l'app
  healed = true;
  if (suspended) setBackground(false);
  doc.visibilityState = 'visible';
  dispatch('window', 'online');
  dispatch('document', 'visibilitychange');
  const deadline = elapsed() + 40000;
  while (elapsed() < deadline && off.pendingFor(userId).length > 0) await sleep(250);
} catch (e) {
  exceptions.push('scenario: ' + (e?.stack ?? e));
}

stopSync();
parentPort.postMessage({
  id: D.id,
  userId,
  name: D.name,
  taps,
  failed: off.failedFor(userId).map((q) => ({ clientId: q.clientId, kind: q.kind, error: q.error })),
  pending: off.pendingFor(userId).map((q) => ({ clientId: q.clientId, kind: q.kind })),
  exceptions,
  stats,
  launches: appLaunches,
  trace: process.env.CHAOS_TRACE ? trace : undefined,
});
process.exit(0);
