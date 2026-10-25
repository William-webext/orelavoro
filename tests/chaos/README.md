# Prove di robustezza

Non girano nella pipeline normale (durano alcuni minuti): si lanciano a mano prima di pubblicare.

| Comando | Cosa fa |
|---|---|
| `npm run test:chaos` | 300 "telefoni" (iPhone, Android, desktop, tablet, orologio sballato) con reti difettose: latenze, perdite di connessione, risposte perse dopo che il server ha già registrato, server appeso o spento, tunnel con errore 502, portale captive, risposte troncate, riavvii forzati del server, app sospesa o chiusa in background, dati locali cancellati. Esegue il vero codice client (`src/web/api.ts`, `offline.ts`) contro il vero server e verifica che nessuna timbratura vada persa, duplicata o registrata fuori ordine. |
| `npm run test:fuzz` | Controlli di sicurezza (accessi tra utenti, permessi, origine delle richieste, blocco PIN, cookie) e migliaia di richieste casuali o malformate: nessuna deve dare errore 500. |

Variabili utili: `CHAOS_N` (numero scenari), `CHAOS_BATCH` (dispositivi in parallelo), `CHAOS_SEED`, `FUZZ_ITER`.

Il tempo è accelerato ×10 (`fake-clock.mjs`) così un turno di ore dura pochi secondi.
