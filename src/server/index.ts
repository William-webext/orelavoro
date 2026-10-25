import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { admin } from './admin.ts';
import { bootstrapSuperadmin, HttpError } from './auth.ts';
import { config, smtpConfigured } from './config.ts';
import { db } from './db.ts';
import { api } from './routes.ts';
import { startScheduler } from './scheduler.ts';

bootstrapSuperadmin();

const app = new Hono();

app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    referrerPolicy: 'same-origin',
    xFrameOptions: 'DENY',
  }),
);

// Difesa CSRF aggiuntiva: le richieste che modificano dati devono arrivare dallo stesso host.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin) {
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
      let ok = false;
      try {
        ok = new URL(origin).host === host;
      } catch {
        ok = false;
      }
      if (!ok) return c.json({ error: 'Origine non consentita.' }, 403);
    }
  }
  c.header('Cache-Control', 'no-store');
  await next();
});

app.route('/api/admin', admin);
app.route('/api', api);

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as 400);
  console.error('[errore]', err);
  return c.json({ error: 'Errore interno del server.' }, 500);
});

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Non trovato.' }, 404);
  return c.text('Non trovato', 404);
});

// ---------- frontend statico (PWA) ----------

const webDir = path.resolve(import.meta.dirname, '../../dist/web');
const indexFile = path.join(webDir, 'index.html');

if (fs.existsSync(indexFile)) {
  const rel = path.relative(process.cwd(), webDir).replace(/\\/g, '/');
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use(
    '*',
    serveStatic({
      root: rel,
      onFound: (p, c) => {
        if (!p.includes('/assets/')) c.header('Cache-Control', 'no-cache');
      },
    }),
  );
  // qualsiasi altra GET (rotta della SPA) → index.html
  app.get('*', (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.html(fs.readFileSync(indexFile, 'utf8'));
  });
} else {
  app.get('/', (c) => c.text('Frontend non compilato: esegui "npm run build" (oppure usa "npm run dev:web" in sviluppo).'));
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Ore Lavoro in ascolto su http://localhost:${info.port}  (fuso ${config.tz}, mail ${smtpConfigured ? 'attiva' : 'non configurata'})`);
});

const stopScheduler = startScheduler();

function shutdown() {
  console.log('Arresto…');
  stopScheduler();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
