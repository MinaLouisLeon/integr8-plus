#!/usr/bin/env bash
# Dumps the compose stack's Postgres to a dated, compressed file and keeps the
# most recent ones. For the machine-hosted database only; a Supabase database
# has its own backups (docs/database/runbook-backup-and-restore.md).
#
# Schedule it daily as root, so it can talk to Docker:
#
#   sudo crontab -e
#   0 3 * * * /opt/integr8/deploy/vps/backup-postgres.sh >> /var/log/integr8-backup.log 2>&1
#
# Restore one file into a running stack (this replaces the database's contents):
#
#   gunzip -c /var/backups/integr8/integr8-20261004-0300.sql.gz \
#     | docker compose -f /opt/integr8/deploy/compose.yml --env-file /opt/integr8/deploy/.env \
#         exec -T postgres psql -U postgres -d integr8 -v ON_ERROR_STOP=1
#
# The files live on the same disk as the database, which protects against a bad
# migration or a deleted company, not against losing the machine. Copy them
# somewhere else as well: a cloud bucket with rclone, or a boot-volume backup
# policy in the cloud console. Both are in docs/deployment/README.md.
set -euo pipefail

REPO="${INTEGR8_DIR:-/opt/integr8}"
DEST="${BACKUP_DIR:-/var/backups/integr8}"
KEEP="${KEEP:-14}"

compose() {
  docker compose -f "$REPO/deploy/compose.yml" --env-file "$REPO/deploy/.env" "$@"
}

mkdir -p "$DEST"
chmod 700 "$DEST"
stamp=$(date -u +%Y%m%d-%H%M)
file="$DEST/integr8-$stamp.sql.gz"

# Plain SQL, so a restore needs nothing but psql. --clean lets the file be
# applied over an existing schema when restoring.
compose exec -T postgres pg_dump -U postgres -d integr8 --clean --if-exists | gzip -9 > "$file.tmp"
mv "$file.tmp" "$file"

# Keep the newest KEEP files; the rest go.
ls -1t "$DEST"/integr8-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "$(date -u +%FT%TZ) wrote $file ($(du -h "$file" | cut -f1)), keeping $KEEP"
