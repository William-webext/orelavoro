// Service worker: rende l'app installabile e la apre anche a server spento.
// I dati (/api) non vengono mai messi in cache: le ore devono sempre arrivare dal server.
// Le timbrature fatte offline sono gestite dall'app (coda sul telefono), non da qui.
const CACHE = 'orelavoro-shell-v2';

// Alla prima installazione scarica anche JS/CSS indicati da index.html,
// altrimenti la prima apertura offline non troverebbe i file dell'app.
async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch('/', { cache: 'reload' });
  const html = await res.clone().text();
  await cache.put('/', res);
  const assets = [...new Set(html.match(/\/assets\/[^"'\s)]+/g) ?? [])];
  const extra = ['/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png'];
  await Promise.all([...assets, ...extra].map((u) => cache.add(u).catch(() => {})));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Pagine: prima la rete (così gli aggiornamenti arrivano subito), se manca si usa la copia salvata.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // File con nome "a impronta" (/assets/...) e icone: prima la copia salvata.
  if (url.pathname.startsWith('/assets/') || /\.(png|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
