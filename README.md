# Ore Lavoro

Web app (PWA) per registrare le ore di lavoro e controllare che lo stipendio sia commisurato alle ore effettivamente fatte. Pensata per uso personale e familiare, in container su un NAS Synology e pubblicata via Cloudflare Tunnel. Si installa su iPhone dalla schermata Home, senza App Store.

## Documentazione

📘 **[Manuale d'uso e di amministrazione](docs/MANUALE.md)** — uso quotidiano, installazione sul NAS, manutenzione, backup e **ripristino** (con i comandi), sicurezza, risoluzione dei problemi. Disponibile anche in Word: [`docs/Manuale-Ore-Lavoro.docx`](docs/Manuale-Ore-Lavoro.docx).

Le schermate del manuale usano dati inventati e si rigenerano con `docs/tools/screenshots.mjs` (vedi il capitolo 12 del manuale).

## Funzioni

- **Accesso con utente e PIN** (6-8 cifre, salvato con hash, blocco temporaneo dopo 5 tentativi errati).
- **Timbra entrata / uscita** con un tocco (ora del server nel fuso `APP_TZ`) oppure inserimento manuale di data, inizio e fine.
- **Più turni al giorno**: le ore si sommano, l'intervallo tra due turni (la pausa) non viene contato. Turni a cavallo della mezzanotte e cambio ora legale gestiti.
- **Un solo dispositivo per utente**: se accedi da un secondo dispositivo, il primo viene scollegato e al primo tocco spiega "Hai acceso su un altro dispositivo (iPhone, Safari) alle 14:32". Le timbrature ancora in coda sul vecchio dispositivo non si perdono: partono dopo il nuovo accesso. In caso di conflitto i messaggi dicono ora e dispositivo ("Ingresso già registrato alle 08:31 da iPhone"), e *Oggi* si aggiorna da sola ogni 30 secondi.
- **Funziona anche a server spento**: se il NAS, il tunnel o la rete non rispondono, l'app si apre lo stesso e "Timbra ora" salva ingresso/uscita sul telefono con l'ora del tocco; appena il server torna le timbrature vengono inviate in automatico (senza duplicati) e marcate "offline". Quelle che il server rifiuta (ad esempio uscita senza ingresso) restano in una lista da sistemare.
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

### Aggiornamenti del database e ripristino

Quando un aggiornamento dell'app cambia la struttura del database, all'avvio succede questo, in automatico:

1. **Copia preventiva** completa e verificata: `/data/backups/pre-migrazione_v3-v4_AAAA-MM-GGTHH-MM-SS-mmm.db` (si tengono le ultime 10). Se la copia non riesce, la migrazione **non parte**.
2. **Tutto o niente**: le modifiche si applicano in un'unica transazione con controlli di integrità finali. Se qualcosa va storto, il database resta **esattamente com'era** e l'app si ferma con un messaggio chiaro nei log (*Containers → orelavoro → Logs*, righe `[db] …`).
3. Un database **più nuovo** dell'app (ad esempio dopo aver rimesso un'immagine vecchia) non viene toccato: l'app si ferma e lo spiega.

Se invece la migrazione riesce ma vuoi tornare indietro (ad esempio i dati non ti tornano), ripristina la copia preventiva **a container fermo**:

```bash
# 1) ferma lo stack in Portainer (Stacks → orelavoro → Stop)
# 2) vedi le copie disponibili e ripristina quella voluta (stessi PUID/PGID dello stack)
docker run --rm -e PUID=1026 -e PGID=100 -v /volume1/docker/orelavoro/data:/data ghcr.io/william-webext/orelavoro:latest node src/server/cli.ts list-backups
docker run --rm -e PUID=1026 -e PGID=100 -v /volume1/docker/orelavoro/data:/data ghcr.io/william-webext/orelavoro:latest node src/server/cli.ts restore pre-migrazione_v3-v4_2026-10-25T14-32-10-123.db
# 3) riavvia lo stack
```

Il comando rifiuta di lavorare se il database è in uso, e prima di sostituirlo salva quello attuale in `prima-del-ripristino_….db`: anche il ripristino si può annullare. Se per tornare a una versione precedente dell'app serve anche l'immagine vecchia, ripristina la copia e poi usa il tag di quell'immagine (ad esempio `ghcr.io/william-webext/orelavoro:sha-xxxxxxx`) nello stack.

**Senza riga di comando**: con lo stack fermo, da File Station copia la copia scelta sopra `orelavoro.db` e **cancella** `orelavoro.db-wal` e `orelavoro.db-shm` (se esistono), poi riavvia.

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
| `OFFLINE_MAX_DAYS` | `7` | Una timbratura salvata offline è accettata se non più vecchia di questi giorni |
| `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES` | `5`, `15` | Blocco dopo tentativi errati |
| `SESSION_DAYS` | `60` | Durata della sessione (si rinnova usando l'app) |
| `SINGLE_SESSION` | `true` | Un solo dispositivo attivo per utente: un nuovo accesso scollega il precedente. `false` per ammettere più dispositivi insieme |
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
Controlli: `npm run typecheck` e `npm test`. Prove di robustezza prima di pubblicare (alcuni minuti): `npm run test:chaos` (300 telefoni con reti difettose) e `npm run test:fuzz` (sicurezza e richieste malformate), vedi `tests/chaos/README.md`. Icone: `npm run icons`.

Stack: Node 24 (TypeScript con type stripping, `node:sqlite`), Hono, Preact + Vite, nodemailer, pdfkit, exceljs.
