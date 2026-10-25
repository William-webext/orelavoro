#!/bin/bash
# Backup di Ore Lavoro per le Attività pianificate di DSM (utente root).
# Archivia la cartella dati (database SQLite + backup notturni interni).
# ===================== CONFIGURAZIONE =====================
BACKUP_DIR="${BACKUP_DIR:-/volume1/docker/backup/orelavoro}"
DATA_DIR="${DATA_DIR:-/volume1/docker/orelavoro/data}"
CONTAINER_NAME="${CONTAINER_NAME:-orelavoro}"
KEEP_DAYS="${KEEP_DAYS:-7}"
# ============================================================

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [ ! -d "$DATA_DIR" ]; then
    log "ERRORE: cartella dati non trovata: $DATA_DIR"
    exit 1
fi
mkdir -p "$BACKUP_DIR" || exit 1

DATE=$(date +%Y-%m-%d_%H%M)
FILE="$BACKUP_DIR/orelavoro_$DATE.tar.gz"

# Pausa il container SOLO per il tempo del tar, per non catturare il db a metà scrittura.
# La trap garantisce che il container venga riattivato anche se il tar fallisce a metà.
PAUSED=0
resume() {
    if [ "$PAUSED" = 1 ]; then
        docker unpause "$CONTAINER_NAME" >/dev/null 2>&1 && PAUSED=0
    fi
}
trap resume EXIT

if docker pause "$CONTAINER_NAME" >/dev/null 2>&1; then
    PAUSED=1
else
    # Container spento o nome errato: si copia comunque (SQLite in modalità WAL
    # resta recuperabile, e dentro c'è anche la copia notturna consistente).
    log "ATTENZIONE: impossibile mettere in pausa '$CONTAINER_NAME', copio i dati a caldo"
fi

tar -czf "$FILE" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
TAR_RC=$?
resume
trap - EXIT

# tar esce con 1 se un file è cambiato durante la lettura (solo senza pausa): accettabile.
# Oltre a "non vuoto" si verifica che l'archivio sia leggibile fino in fondo.
if [ "$TAR_RC" -gt 1 ] || [ ! -s "$FILE" ] || ! tar -tzf "$FILE" >/dev/null 2>&1; then
    log "ERRORE: backup orelavoro fallito o archivio non valido, salto la rotazione"
    rm -f "$FILE"
    exit 1   # esito != 0 così DSM segnala l'attività come fallita
fi
[ "$TAR_RC" -eq 1 ] && log "ATTENZIONE: alcuni file sono cambiati durante la copia"
log "Backup creato: $FILE ($(du -h "$FILE" | cut -f1))"

# Cancella i backup più vecchi di KEEP_DAYS giorni (in base alla data di modifica
# del file, non al conteggio): indipendente da quante volte al giorno viene lanciato.
find "$BACKUP_DIR" -maxdepth 1 -name "orelavoro_*.tar.gz" -mtime "+$KEEP_DAYS" -delete
log "Rotazione completata (tenuti $KEEP_DAYS giorni)"
