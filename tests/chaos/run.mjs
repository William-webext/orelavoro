// Simulatore di scenari: centinaia di "telefoni" con reti instabili contro il vero server.
//   node tests/chaos/run.mjs            (300 scenari)
//   CHAOS_N=60 node tests/chaos/run.mjs (prova rapida)
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const N = Number(process.env.CHAOS_N ?? 300);
const BATCH = Number(process.env.CHAOS_BATCH ?? 75);
const SEED = Number(process.env.CHAOS_SEED ?? 20261026);
const SCALE = 10; // 1 secondo reale = 10 secondi virtuali
const PORT = 3400 + Math.floor(Math.random() * 200);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'orelavoro-chaos-'));
const fakeClock = path.join(ROOT, 'tests/chaos/fake-clock.mjs');

process.env.CHAOS_R0 = String(Date.now());
process.env.CHAOS_V0 = String(Date.UTC(2026, 9, 26, 8, 0, 0)); // 26/10/2026 08:00 (Lisbona = UTC+0)
process.env.CHAOS_SCALE = String(SCALE);

const timeMod = await import(pathToFileURL(path.join(ROOT, 'src/server/time.ts')).href);

// ---------- server ----------
let server;
let serverLog = '';
let restarts = 0;
function startServer() {
  server = spawn(process.execPath, ['--import', pathToFileURL(fakeClock).href, 'src/server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), APP_TZ: 'Europe/Lisbon', SUPERADMIN_USER: 'root', SUPERADMIN_PIN: '135790', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
}
async function waitHealth(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch {
      /* non ancora pronto */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server non partito:\n' + serverLog);
}
async function restartServer() {
  restarts++;
  server.kill('SIGKILL'); // spegnimento brutale, come un NAS che si riavvia
  await new Promise((r) => setTimeout(r, 1500));
  startServer();
  await waitHealth();
}

// ---------- scenari ----------
const NETS = {
  wifi: { lat: [10, 60], drop: 0, hang: 0, lostResponse: 0, truncated: 0 },
  lte: { lat: [50, 350], drop: 0.03, hang: 0.01, lostResponse: 0.03, truncated: 0.01 },
  slow3g: { lat: [500, 2500], drop: 0.08, hang: 0.05, lostResponse: 0.08, truncated: 0.03 },
  awful: { lat: [1500, 5000], drop: 0.18, hang: 0.12, lostResponse: 0.2, truncated: 0.08 },
  lossyAck: { lat: [50, 300], drop: 0, hang: 0, lostResponse: 0.5, truncated: 0.1 },
  captive: { lat: [50, 300], drop: 0.02, hang: 0, lostResponse: 0.02, truncated: 0, captive: 0.5 },
  tunnelDown: { lat: [30, 200], drop: 0, hang: 0, lostResponse: 0, truncated: 0, outage: 'html502' },
  paused: { lat: [30, 200], drop: 0, hang: 0, lostResponse: 0, truncated: 0, outage: 'hang' },
  blackout: { lat: [30, 200], drop: 0, hang: 0, lostResponse: 0, truncated: 0, outage: 'refused' },
  flapping: { lat: [50, 400], drop: 0.02, hang: 0.01, lostResponse: 0.04, truncated: 0.01, flap: true },
};
const DEVICES = {
  iphone: { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari', bg: 0.6, kill: 0.35, evict: 0.1, skew: 0 },
  android: { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126', bg: 0.3, kill: 0.1, evict: 0, skew: 0 },
  desktop: { ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126', bg: 0, kill: 0, evict: 0, skew: 0 },
  kiosk: { ua: 'Mozilla/5.0 (iPad) kiosk', bg: 0, kill: 0, evict: 0, skew: 0 },
  wrongClock: { ua: 'Mozilla/5.0 (Linux; Android 9; vecchio)', bg: 0.3, kill: 0.2, evict: 0, skew: 1 },
};
const NET_KEYS = Object.keys(NETS);
const DEV_KEYS = Object.keys(DEVICES);

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeScenario(k) {
  const r = mulberry32(SEED + k * 977);
  const netName = NET_KEYS[k % NET_KEYS.length];
  const devName = DEV_KEYS[Math.floor(k / NET_KEYS.length + k * 3) % DEV_KEYS.length];
  const net = NETS[netName];
  const dev = DEVICES[devName];
  const count = [2, 3, 4, 4, 6][Math.floor(r() * 5)];
  const taps = [];
  let at = 3500 + r() * 1500;
  for (let i = 0; i < count; i++) {
    const gap = 7000 + r() * 5000;
    const t = { kind: i % 2 === 0 ? 'in' : 'out', at, background: null };
    if (i > 0 && r() < dev.bg) {
      t.background = { seconds: 3 + r() * (gap / 1000 - 6), kill: r() < dev.kill, evict: r() < dev.evict };
    }
    taps.push(t);
    at += gap;
  }
  const lastTap = taps[taps.length - 1].at;
  const outages = [];
  if (net.outage) {
    outages.push({ start: 2000 + r() * 2500, end: lastTap - 1500 - r() * (count > 2 ? 6000 : 0), mode: net.outage });
  }
  if (net.flap) {
    for (let t = 3000; t < lastTap; t += 2500 + r() * 4000) {
      outages.push({ start: t, end: t + 1500 + r() * 3500, mode: ['refused', 'hang', 'html502'][Math.floor(r() * 3)] });
    }
  }
  // 12% degli scenari: un secondo dispositivo accede con lo stesso utente e scollega il primo
  const kick = r() < 0.12 ? { at: taps[0].at + (lastTap - taps[0].at) * (0.3 + r() * 0.5) } : null;
  const skewMs = dev.skew ? (r() < 0.5 ? -1 : 1) * (3600000 + r() * 3 * 3600000) : (r() - 0.5) * 6000;
  return {
    id: k,
    name: `${netName}/${devName}#${k}`,
    netName,
    devName,
    seed: SEED + k,
    net,
    device: dev,
    taps,
    outages,
    kick,
    skewMs: Math.round(skewMs),
    syncedBefore: dev.skew ? r() < 0.6 : true,
    username: `d${k}`,
    pin: '246810',
    port: PORT,
    root: ROOT,
  };
}

// ---------- esecuzione ----------
function runDevice(sc) {
  return new Promise((resolve) => {
    const w = new Worker(path.join(ROOT, 'tests/chaos/device.mjs'), {
      workerData: sc,
      execArgv: ['--import', pathToFileURL(fakeClock).href],
      env: process.env,
    });
    const timer = setTimeout(() => {
      w.terminate();
      resolve({ id: sc.id, name: sc.name, taps: [], failed: [], pending: [], exceptions: ['TIMEOUT scenario > 3 min'], stats: {}, launches: 0, userId: 0, wipes: 0 });
    }, 180000);
    w.once('message', (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      resolve({ id: sc.id, name: sc.name, taps: [], failed: [], pending: [], exceptions: ['worker error: ' + (e.stack ?? e)], stats: {}, launches: 0, userId: 0, wipes: 0 });
    });
  });
}

console.log(`Chaos: ${N} scenari, ${BATCH} dispositivi alla volta, porta ${PORT}, scala tempo ×${SCALE}`);
startServer();
await waitHealth();

// utenti: uno per scenario
const adminLogin = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.250.0.1' },
  body: JSON.stringify({ username: 'root', pin: '135790' }),
});
const adminCookie = adminLogin.headers.getSetCookie()[0].split(';')[0];
const only0 = process.env.CHAOS_ONLY ? new Set(process.env.CHAOS_ONLY.split(",").map(Number)) : null;
for (let k = 0; k < N; k++) {
  if (only0 && !only0.has(k)) continue;
  const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ username: `d${k}`, displayName: `Dispositivo ${k}`, pin: '246810' }),
  });
  if (!r.ok) throw new Error('creazione utente fallita: ' + (await r.text()));
}

const only = process.env.CHAOS_ONLY ? new Set(process.env.CHAOS_ONLY.split(",").map(Number)) : null;
const scenarios = Array.from({ length: N }, (_, k) => makeScenario(k)).filter((sc) => !only || only.has(sc.id));
const results = [];
const t0 = Date.now();
for (let b = 0; b * BATCH < N; b++) {
  const slice = scenarios.slice(b * BATCH, (b + 1) * BATCH);
  const restart = b >= 1 ? setTimeout(() => void restartServer(), 8000 + Math.random() * 20000) : null;
  const res = await Promise.all(slice.map(runDevice));
  if (restart) clearTimeout(restart);
  results.push(...res);
  console.log(`  lotto ${b + 1}: ${res.length} scenari conclusi (${((Date.now() - t0) / 1000).toFixed(0)}s, riavvii server: ${restarts})`);
}

// ---------- verifica ----------
const db = new DatabaseSync(path.join(DATA, 'orelavoro.db'), { readOnly: true });
const legit = /futuro|coincide|precede|attendi|più vecchia/;
const cascade = /già un ingresso|nessun ingresso|troppo vecchio/;
const violations = [];
const agg = {};
const bump = (key, field, n = 1) => {
  agg[key] ??= { scenari: 0, tocchi: 0, applicati: 0, accodati: 0, rifiutati: 0, daSistemare: 0, persi_evict: 0, violazioni: 0 };
  agg[key][field] += n;
};
const faultTotals = {};
const rejectionNotes = {};

for (const res of results) {
  const sc = scenarios.find((x) => x.id === res.id);
  if (process.env.CHAOS_TRACE) {
    console.log(`\n--- traccia ${sc.name} (skew ${sc.skewMs}ms, sincronizzato prima: ${sc.syncedBefore}) ---`);
    console.log((res.trace ?? []).join('\n'));
  }
  const v = [];
  const keyNet = sc.netName;
  const keyDev = sc.devName;
  for (const key of [keyNet, keyDev]) bump(key, 'scenari');
  for (const [k, n] of Object.entries(res.stats ?? {})) faultTotals[k] = (faultTotals[k] ?? 0) + n;

  for (const e of res.exceptions) v.push(['EXC', e.slice(0, 200)]);
  const rows = db.prepare('SELECT client_id, kind, at FROM clock_log WHERE user_id = ? ORDER BY at, rowid').all(res.userId || -1);
  const appliedById = new Map(rows.map((r) => [r.client_id, r]));
  const failedById = new Map(res.failed.map((f) => [f.clientId, f]));
  const pendingIds = new Set(res.pending.map((p) => p.clientId));
  const wiped = sc.taps.some((t) => t.background?.kill && t.background?.evict);
  let anyLegitRejection = false;
  // tocchi consecutivi a meno di 2 minuti (virtuali) uno dall'altro: lo stesso minuto fa rifiutare
  // giustamente l'uscita, e se la risposta si perde il messaggio cambia alla ripetizione
  const byIdx = [...res.taps].sort((a, b) => a.i - b.i);
  const tooQuick = byIdx.some((t, k) => k > 0 && t.trueAt - byIdx[k - 1].trueAt < 120000);
  let dataWiped = false; // una timbratura è andata persa perché il telefono ha cancellato i dati locali
  const appliedTaps = [];

  for (const tap of res.taps) {
    for (const key of [keyNet, keyDev]) bump(key, 'tocchi');
    if (tap.outcome === 'exception') {
      v.push(['TAP_EXC', tap.message]);
      continue;
    }
    const row = appliedById.get(tap.clientId);
    if (row) {
      for (const key of [keyNet, keyDev]) bump(key, 'applicati');
      if (tap.outcome === 'queued') for (const key of [keyNet, keyDev]) bump(key, 'accodati');
      appliedTaps.push({ tap, row });
      const d = row.at - tap.trueAt;
      if (Math.abs(d) > 120000 && Math.abs(d - sc.skewMs) > 120000) v.push(['TIME', `tocco #${tap.i} scarto ${(d / 1000).toFixed(0)}s (skew telefono ${(sc.skewMs / 1000).toFixed(0)}s)`]);
      continue;
    }
    if (tap.outcome === 'apierr' || failedById.has(tap.clientId)) {
      const msg = tap.outcome === 'apierr' ? tap.message : failedById.get(tap.clientId).error;
      for (const key of [keyNet, keyDev]) bump(key, tap.outcome === 'apierr' ? 'rifiutati' : 'daSistemare');
      (rejectionNotes[msg.replace(/^\d+: /, '')] ??= []).push(`${sc.name} tocco #${tap.i} ${tap.kind}`);
      if (legit.test(msg)) anyLegitRejection = true;
      else if ((cascade.test(msg) || /sovrappone/.test(msg)) && (anyLegitRejection || dataWiped || tooQuick)) anyLegitRejection = true;
      else v.push(['BADREJECT', `tocco #${tap.i} ${tap.kind}: ${msg}`]);
      continue;
    }
    if (pendingIds.has(tap.clientId)) {
      v.push(['STUCK', `tocco #${tap.i} ${tap.kind} ancora in coda dopo il ripristino della rete`]);
      continue;
    }
    if (wiped) {
      dataWiped = true;
      for (const key of [keyNet, keyDev]) bump(key, 'persi_evict');
      continue;
    }
    v.push(['LOST', `tocco #${tap.i} ${tap.kind} (esito app: ${tap.outcome}) non risulta da nessuna parte`]);
  }

  // coerenza: ordine dei tocchi e voci registrate
  const byAt = [...appliedTaps].sort((a, b) => a.row.at - b.row.at);
  for (let i = 1; i < byAt.length; i++) {
    if (byAt[i].tap.i < byAt[i - 1].tap.i) v.push(['ORDER', `tocchi applicati con orari in ordine diverso da quello reale (#${byAt[i].tap.i} prima di #${byAt[i - 1].tap.i})`]);
  }
  const entries = db.prepare('SELECT date, start_min, end_min FROM entries WHERE user_id = ? ORDER BY date, start_min').all(res.userId || -1);
  const expected = [];
  let open = null;
  let bad = false;
  for (const r of rows) {
    const loc = timeMod.epochToLocal(r.at, 'Europe/Lisbon');
    if (r.kind === 'in') {
      if (open) bad = true;
      open = { date: loc.date, start_min: loc.minutes, end_min: null };
      expected.push(open);
    } else {
      if (!open) bad = true;
      else {
        open.end_min = loc.minutes + 1440 * timeMod.diffDays(open.date, loc.date);
        open = null;
      }
    }
  }
  if (bad) v.push(['SEQ', 'sequenza di eventi applicati non alternata in/out']);
  const same = expected.length === entries.length && expected.every((e, i) => e.date === entries[i].date && e.start_min === entries[i].start_min && e.end_min === entries[i].end_min);
  if (!same && !bad) v.push(['ENTRIES', `voci registrate diverse da quelle attese: attese ${JSON.stringify(expected)} trovate ${JSON.stringify(entries)}`]);

  if (v.length) {
    for (const key of [keyNet, keyDev]) bump(key, 'violazioni');
    violations.push({ name: sc.name, v, trace: res.trace, skew: sc.skewMs, kick: sc.kick });
  }
}

const openAlert = serverLog.split('\n').filter((l) => l.includes('[errore]'));
server.kill();
db.close();

// ---------- rapporto ----------
console.log('\nEsito per profilo di rete / dispositivo:');
console.table(agg);
console.log('Guasti iniettati (totale richieste):', JSON.stringify(faultTotals));
console.log(`Riavvii forzati del server durante i test: ${restarts}`);
console.log('\nRifiuti del server (regole di coerenza), per motivo:');
for (const [m, l] of Object.entries(rejectionNotes)) console.log(`  ${l.length}x ${m}  (es. ${l.slice(0, 2).join("; ")})`);
console.log(`Errori interni del server (500): ${openAlert.length}`);
for (const l of openAlert.slice(0, 5)) console.log('  ', l);

// traccia completa dei primi scenari con violazioni, per capire cosa è successo
for (const x of violations.slice(0, 4)) {
  console.log(`\n--- traccia ${x.name} (skew ${x.skew}ms, scollegamento: ${x.kick ? 'sì' : 'no'}) ---`);
  console.log((x.trace ?? []).join('\n'));
}
const byKind = {};
for (const x of violations) for (const [k, m] of x.v) (byKind[k] ??= []).push(`${x.name}: ${m}`);
if (violations.length === 0 && openAlert.length === 0) {
  console.log(`\nTUTTO OK: ${results.length} scenari, nessuna violazione.`);
  process.exit(0);
}
console.log(`\nVIOLAZIONI: ${violations.length} scenari su ${results.length}`);
for (const [k, list] of Object.entries(byKind)) {
  console.log(`\n[${k}] ${list.length}`);
  for (const m of list.slice(0, 6)) console.log('   ', m);
  if (list.length > 6) console.log(`    … e altre ${list.length - 6}`);
}
process.exit(1);
