#!/bin/sh
# Imposta i permessi della cartella dati per l'utente scelto (PUID/PGID) e poi
# abbassa i privilegi. Su Synology usa l'id del tuo utente (comando: id).
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R "$PUID:$PGID" "${DATA_DIR:-/data}"
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
