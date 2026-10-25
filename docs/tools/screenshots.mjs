// Scatta le schermate del manuale pilotando Chrome/Edge senza finestra (protocollo CDP).
//   1) node docs/tools/seed-demo.mjs <cartella>            (dati dimostrativi, utenti admin/mario/laura, PIN 246810)
//   2) DATA_DIR=<cartella> PORT=3200 SMTP_HOST=smtp.example.com SMTP_USER=a@example.com SMTP_PASS=x \
//        SMTP_FROM=a@example.com node src/server/index.ts   (l'SMTP finto serve a mostrare i comandi di invio mail)
//   3) node docs/tools/screenshots.mjs http://localhost:3200 docs/img
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] ?? 'http://localhost:3200').replace(/\/$/, '');
const OUT = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, '../img'));
fs.mkdirSync(OUT, { recursive: true });

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) throw new Error('Serve Chrome o Edge installato.');

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- browser + CDP ----------
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orelavoro-shots-'));
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 100; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch {
    /* in avvio */
  }
  await sleep(150);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(`${m.error.message}`)) : res(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');
// Chrome offre sempre "Installa app": su iPhone e Safari quel pulsante non esiste, quindi si nasconde
// l'evento all'app (in cattura, prima dei suoi ascoltatori).
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "window.addEventListener('beforeinstallprompt', (e) => { e.stopImmediatePropagation(); }, true);",
});

async function view({ w, h, dpr = 2, mobile = true, dark = false, ua = 'iphone' }) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await send('Emulation.setUserAgentOverride', { userAgent: UA[ua] });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
}
const PHONE = { w: 390, h: 844, dpr: 2, mobile: true, ua: 'iphone' };
const DESKTOP = { w: 1280, h: 800, dpr: 1.5, mobile: false, ua: 'desktop' };

async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'errore JS');
  return r.result.value;
}
async function waitFor(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await js(`!!(${cond})`).catch(() => false)) return;
    await sleep(120);
  }
  throw new Error('timeout: ' + cond);
}
let nav = 0;
async function open(hash = '') {
  await send('Page.navigate', { url: `${BASE}/?v=${++nav}${hash ? '#' + hash : ''}` });
  await sleep(500);
}
async function shot(name) {
  await sleep(450);
  const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
  fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(data, 'base64'));
  console.log('  ', name);
}

async function login(user, ua = 'iphone') {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA[ua], 'cf-connecting-ip': '10.1.1.' + Math.floor(Math.random() * 200) }, body: JSON.stringify({ username: user, pin: '246810' }) });
  const c = r.headers.getSetCookie()[0].split(';')[0];
  if (!r.ok) throw new Error('login fallito ' + user);
  await send('Network.setCookie', { name: 'ol_session', value: c.split('=')[1], url: BASE, httpOnly: true });
}
async function clean() {
  await send('Network.clearBrowserCookies');
  await open();
  await js('localStorage.clear(); sessionStorage.clear()');
}
const scrollTo = (selectorExpr, offset = 20) => js(`(() => { const e = ${selectorExpr}; window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - ${offset}); })()`);
const clickText = (text, sel = 'button') => js(`[...document.querySelectorAll('${sel}')].find(b => b.textContent.trim().includes(${JSON.stringify(text)}))?.click()`);
const h2 = (t) => `[...document.querySelectorAll('h2')].find(e => e.textContent.includes(${JSON.stringify(t)}))`;

// =====================  TELEFONO, tema chiaro  =====================
console.log('Telefono');
await view(PHONE);
await clean();
await waitFor(`document.querySelector('#l-user')`);
await shot('01-accesso');

await login('mario');
await open('/oggi');
await waitFor(`document.querySelector('.clock-card')`);
await shot('02-oggi');

await open('/mese/2026-10');
await waitFor(`document.querySelectorAll('.day-row').length > 20`);
await shot('03-mese');
await js(`window.scrollTo(0, document.querySelectorAll('.day-row')[10].getBoundingClientRect().top + window.scrollY - 70)`);
await shot('04-mese-tipi-giornata');

await js(`document.querySelectorAll('.day-row')[19].click()`);
await waitFor(`document.querySelector('.sheet')`);
await shot('05-giorno');
await js(`document.querySelector('.sheet .list-item').click()`);
await waitFor(`document.querySelector('#e-end')`);
await shot('06-modifica-turno');
await js(`(() => { const i = document.querySelector('#e-end'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '13:30'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(200);
await clickText('Salva', '.sheet-foot .btn');
await waitFor(`[...document.querySelectorAll('.sheet h2')].some(e => e.textContent.includes('Confermi'))`);
await shot('07-conferma-modifica');
await clickText('Annulla');
await sleep(200);
await js(`document.querySelectorAll('.sheet-head .icon-btn').forEach(b => b.click())`);

await open('/report/2026-09');
await waitFor(`document.querySelector('#s-net')?.value`);
await shot('08-stipendio');
await scrollTo(h2('Scarica o invia'));
await shot('09-report-invio');
await scrollTo(h2('Sintesi'));
await shot('10-report-sintesi');

await open('/anno/2026');
await waitFor(`document.querySelector('.chart')`);
await shot('11-anno');

await open('/altro');
await waitFor(`document.querySelector('#n')`);
await shot('12-altro');
await scrollTo(h2('Giorni di riposo'));
await shot('13-altro-riposo-tema');

// ---- senza rete: la timbratura resta sul telefono ----
await open('/oggi');
await waitFor(`document.querySelector('.btn.big.in')`);
await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await js(`document.querySelector('.btn.big.in').click()`);
await waitFor(`document.querySelector('.offline-bar')`, 15000);
await sleep(800);
await shot('15-offline');
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await waitFor(`!document.querySelector('.offline-bar') && !document.querySelector('.card h2')?.textContent.includes('In attesa')`, 60000);
await sleep(1500);
await shot('16-oggi-in-servizio');
await js(`window.scrollTo(0, 0)`);

// ---- tema scuro ----
await view({ ...PHONE, dark: true });
await open('/oggi');
await waitFor(`document.querySelector('.clock-card')`);
await shot('17-oggi-scuro');
await view(PHONE);

// ---- scollegato da un altro dispositivo ----
await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA.android, 'cf-connecting-ip': '10.1.2.3' }, body: JSON.stringify({ username: 'mario', pin: '246810' }) });
await open('/mese');
await waitFor(`document.querySelector('.banner')`, 15000);
await shot('18-scollegato');

// =====================  COMPUTER  =====================
console.log('Computer');
await view(DESKTOP);
await login('mario', 'desktop');
await open('/oggi');
await waitFor(`document.querySelector('.clock-card')`);
await shot('20-desktop-oggi');
await open('/mese/2026-10');
await waitFor(`document.querySelectorAll('.day-row').length > 20`);
await shot('21-desktop-mese');
await open('/anno/2026');
await waitFor(`document.querySelector('.chart')`);
await shot('22-desktop-anno');
await open('/report/2026-09');
await waitFor(`document.querySelector('#s-net')?.value`);
await shot('23-desktop-report');

await login('admin', 'desktop');
await open('/admin');
await waitFor(`document.querySelectorAll('.list-item').length >= 3`);
await shot('24-admin');
await clickText('Utente', '.page-head button');
await waitFor(`document.querySelector('.sheet')`);
await shot('25-admin-nuovo-utente');
await js(`document.querySelector('.sheet-head .icon-btn').click()`);
await sleep(200);
await clickText('Vedi dati');
await waitFor(`document.querySelector('.viewing')`);
await sleep(800);
await shot('26-admin-vedi-dati');

ws.close();
proc.kill();
await sleep(500);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* il profilo temporaneo si cancella da solo */
}
console.log(`Fatto: schermate in ${OUT}`);
process.exit(0);
