# Ore Lavoro

Web app (PWA) per registrare le ore di lavoro e controllare che lo stipendio sia commisurato alle ore effettivamente fatte. Pensata per uso personale e familiare, in container su un NAS Synology e pubblicata via Cloudflare Tunnel. Si installa su iPhone dalla schermata Home, senza App Store.

## Funzioni

- **Accesso con utente e PIN** (6-8 cifre, salvato con hash, blocco temporaneo dopo 5 tentativi errati).
- **Timbra entrata / uscita** con un tocco (ora del server nel fuso `APP_TZ`) oppure inserimento manuale di data, inizio e fine.
- **Più turni al giorno**: le ore si sommano, l'intervallo tra due turni (la pausa) non viene contato. Turni a cavallo della mezzanotte e cambio ora legale gestiti.
- **Promemoria uscita**: se resta un ingresso senza uscita, l'app lo segnala all'apertura; in più arriva una mail (una per ingresso).
- **Avvisi di incongruenze**: turni molto lunghi, giornate eccessive, giorni passati senza registrazione.
- **Tipo di giornata** per ogni giorno: lavoro, ferie, malattia, permesso, festivo, riposo. Ferie e malattia contano come ore non lavorate. Riposo automatico facoltativo per i giorni della settimana scelti.
- **Modifiche con conferma**: prima di salvare o eliminare compare "il totale ore del 20/10 passa da 8:00 a 7:00".
- **Stipendio mensile** (netto, lordo facoltativo) con calcolo della **paga oraria** netta e lorda.
- **Report mensile** sintetico e dettagliato, scaricabile in PDF/Excel o inviabile per mail. Vista annuale con grafici.
- **Amministrazione** (superadmin): crea utenti, reimposta PIN, vede e può correggere i dati di tutti; le modifiche ai dati altrui finiscono in un registro. Backup notturno automatico e download del database.
- Layout adattivo: barra in basso su telefono, barra laterale su computer; tema chiaro/scuro.

## Installazione su Synology con Portainer

1. **Immagine**: ad ogni push su `main` GitHub Actions pubblica `ghcr.io/william-webext/orelavoro:latest`. Dopo la prima build vai su GitHub → profilo → *Packages* → `orelavoro` → *Package settings* → *Change visibility* → **Public**, così il NAS la scarica senza login.
2. **Utente del container**: via SSH sul NAS esegui `id` e annota uid e gid del tuo utente (di solito `1026` e `100`).
3. **Portainer** → *Stacks* → *Add stack* → nome `orelavoro` → *Web editor* e incolla `docker-compose.yml`.
4. In *Environment variables* → *Advanced mode* incolla e adatta:

   ```
   PUID=1026
   PGID=100
   APP_URL=https://ore.beerfactory.pt
   SUPERADMIN_USER=nome
   SUPERADMIN_PIN=PIN-DI-6-8-CIFRE
   SUPERADMIN_NAME=Nome Cognome
   SUPERADMIN_EMAIL=tua@email
   SMTP_HOST=smtp.example.com
   SMTP_USER=utente-smtp
   SMTP_PASS=password-smtp
   SMTP_FROM=mittente@example.com
   ```

   (opzionali: `DATA_PATH`, `APP_TZ`, `SMTP_PORT`.)
5. *Deploy the stack*: l'app risponde su `http://IP-DEL-NAS:3000`.
6. **Cloudflare Tunnel**: nel tunnel esistente aggiungi un *Public hostname* `ore.beerfactory.pt` → servizio `HTTP` → `IP-DEL-NAS:3000`. Cloudflare crea il record DNS da solo.
7. Dal telefono apri `https://ore.beerfactory.pt`, accedi, poi installa l'app: su iPhone, in Safari, **Condividi → Aggiungi alla schermata Home**; su Android, in Chrome, menu **⋮ → Installa app** (oppure il pulsante *Installa ora* in *Altro*).

Il superadmin viene creato **solo al primo avvio** con database vuoto. Gli altri utenti si creano da *Altro → Apri amministrazione*. Dopo il primo accesso puoi togliere `SUPERADMIN_*` dalle variabili.

### Aggiornamento

Portainer → *Stacks* → `orelavoro` → *Update the stack* con *Re-pull image* attivo. I dati restano nella cartella `/data`.

### PIN dimenticato

```bash
docker exec -it orelavoro node src/server/cli.ts reset-pin NOMEUTENTE 123456
```

## Variabili d'ambiente

| Variabile | Predefinito | Descrizione |
|---|---|---|
| `APP_TZ` | `Europe/Lisbon` | Fuso orario di "Timbra ora", report e promemoria |
| `APP_URL` | – | URL pubblico, usato nei link delle mail |
| `PUID` / `PGID` | `1000` | Utente con cui il container scrive in `/data` |
| `SUPERADMIN_USER`, `SUPERADMIN_PIN`, `SUPERADMIN_NAME`, `SUPERADMIN_EMAIL` | – | Superadmin iniziale |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | porta `587` | Server SMTP autenticato (STARTTLS). Senza, le mail sono disattivate |
| `SMTP_SECURE` | `false` | `true` per TLS implicito (porta 465) |
| `MAX_SHIFT_HOURS` | `12` | Oltre queste ore un turno è "insolito" e un ingresso aperto è "dimenticato" |
| `MAX_DAY_HOURS` | `14` | Soglia di avviso per il totale giornaliero |
| `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES` | `5`, `15` | Blocco dopo tentativi errati |
| `SESSION_DAYS` | `60` | Durata della sessione (si rinnova usando l'app) |
| `BACKUP_KEEP` | `14` | Backup notturni conservati in `/data/backups` |
| `COOKIE_SECURE` | `auto` | `auto` = cookie Secure se la richiesta arriva in HTTPS |

Le credenziali SMTP stanno solo nelle variabili dello stack in Portainer: **non vanno mai nel repository**.

## Sicurezza

- Tutto il traffico passa da HTTPS di Cloudflare; il cookie di sessione è `HttpOnly`, `SameSite=Lax` e `Secure`.
- PIN con scrypt, tempi di risposta costanti, blocco per utente e limite per IP.
- Controllo dell'origine sulle richieste che modificano dati, intestazioni di sicurezza e CSP restrittiva.
- Facoltativo: aggiungere **Cloudflare Access** davanti a `ore.beerfactory.pt` come secondo lucchetto.
- Backup: la cartella `/data` (database SQLite + `backups/`) è tutto ciò che serve salvare, ad esempio con Hyper Backup.

## Sviluppo locale

Richiede Node.js 24 o superiore.

```bash
npm install
cp .env.example .env     # modifica i valori: "npm start" e "npm run dev:server" lo leggono da soli
npm run build            # compila il frontend in dist/web
npm start                # http://localhost:3000
```

In sviluppo: `npm run dev:server` e, in un altro terminale, `npm run dev:web` (Vite su :5173 con proxy verso l'API).
Controlli: `npm run typecheck` e `npm test`. Icone: `npm run icons`.

Stack: Node 24 (TypeScript con type stripping, `node:sqlite`), Hono, Preact + Vite, nodemailer, pdfkit, exceljs.
