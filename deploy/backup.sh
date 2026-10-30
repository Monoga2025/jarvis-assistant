#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
set -a; source /etc/jarvis-v1.env; set +a
: "${JARVIS_BACKUP_DESTINATION:?Missing encrypted backup destination.}"
: "${BACKUP_AGE_RECIPIENT:?Missing age recipient.}"
install -d -m 0700 "$JARVIS_BACKUP_DESTINATION"
restart=0
restart_service() {
  if (( restart == 1 )); then systemctl start openclaw.service; fi
}
trap restart_service EXIT
if systemctl is-active --quiet openclaw.service; then
  systemctl stop openclaw.service
  restart=1
fi
sqlite3 /var/lib/openclaw/jarvis.sqlite 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null
out="$JARVIS_BACKUP_DESTINATION/jarvis-$(date -u +%Y%m%dT%H%M%SZ).tar.age"
tmp="${out}.tmp"
tar --exclude='imports/*.pdf' --exclude='imports/*.ics' -C /var/lib/openclaw -cf - workspace jarvis.sqlite 2>/dev/null | age -r "$BACKUP_AGE_RECIPIENT" -o "$tmp"
chmod 600 "$tmp"; mv "$tmp" "$out"
find "$JARVIS_BACKUP_DESTINATION" -type f -name 'jarvis-*.tar.age' -mtime +35 -delete
printf 'BACKUP_OK encrypted archive created.\n'
