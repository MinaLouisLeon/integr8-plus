#!/usr/bin/env bash
# Dumps the compose stack's Postgres to a dated, compressed file and keeps the
# most recent ones. The whole integr8 database: company data in `public` and
# the self-hosted Auth's sign-in accounts in `auth`. See
# docs/database/runbook-backup-and-restore.md.
#
# Schedule it daily as root, so it can talk to Docker:
#
#   sudo crontab -e
#   0 3 * * * /opt/integr8/deploy/vps/backup-postgres.sh >> /var/log/integr8-backup.log 2>&1
#
# Restore one file into a running stack (this replaces the database's contents;
# stop web, api, worker and auth first — the runbook has every step):
#
#   gunzip -c /var/backups/integr8/integr8-20261004-0300.sql.gz \
#     | docker compose -f /opt/integr8/deploy/compose.yml --env-file /opt/integr8/deploy/.env \
#         exec -T postgres psql -U postgres -d integr8 -v ON_ERROR_STOP=1
#
# Prove a file restores without touching the live database:
# deploy/vps/restore-drill.sh.
#
# The files live on the same disk as the database, which protects against a bad
# migration or a deleted company, not against losing the machine. With
# BACKUP_REMOTE set in deploy/.env, each dump is also copied off the machine
# with rclone, and the newest BACKUP_REMOTE_KEEP copies are kept there. A copy
# that fails makes the whole run fail, loudly: a backup that silently stays on
# the machine is the failure this exists to prevent. Without BACKUP_REMOTE the
# script does what it always did and says the dump is on this machine only.
set -euo pipefail

REPO="${INTEGR8_DIR:-/opt/integr8}"
DEST="${BACKUP_DIR:-/var/backups/integr8}"
KEEP="${KEEP:-14}"
ENV_FILE="$REPO/deploy/.env"

compose() {
  docker compose -f "$REPO/deploy/compose.yml" --env-file "$ENV_FILE" "$@"
}

log() {
  echo "$(date -u +%FT%TZ) $*"
}

# One setting: from the environment if set there, else the last line for it in
# deploy/.env, else empty. The env file is read line by line rather than
# sourced: it holds JSON and addresses with spaces that a shell would mangle,
# and this runs as root.
setting() {
  local name="$1" value
  if [ -n "${!name:-}" ]; then
    printf '%s' "${!name}"
    return
  fi
  [ -r "$ENV_FILE" ] || return 0
  value=$(sed -n "s/^${name}=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r')
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf '%s' "$value"
}

REMOTE="$(setting BACKUP_REMOTE)"
REMOTE_KEEP="$(setting BACKUP_REMOTE_KEEP)"
REMOTE_KEEP="${REMOTE_KEEP:-30}"
PING_URL="$(setting BACKUP_PING_URL)"

# Tells a heartbeat monitor how the night went, when one is configured. Its
# silence is what alerts when cron did not run at all; `/fail` alerts at once.
ping_monitor() {
  [ -n "$PING_URL" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${PING_URL%/}${1:+/$1}" ||
    echo "$(date -u +%FT%TZ) WARNING: could not reach BACKUP_PING_URL" >&2
}

fail() {
  echo "$(date -u +%FT%TZ) ERROR: $*" >&2
  ping_monitor fail
  exit 1
}

stamp=$(date -u +%Y%m%d-%H%M)
file="$DEST/integr8-$stamp.sql.gz"
name="$(basename "$file")"

# Anything else that stops the script (the dump itself, a full disk) says so in
# the log and to the monitor, and leaves no half-written file behind.
trap 'rm -f "$file.tmp"; fail "backup stopped at line $LINENO; the lines above say why"' ERR

for count in "$KEEP" "$REMOTE_KEEP"; do
  case "$count" in
    '' | *[!0-9]* | 0) fail "KEEP and BACKUP_REMOTE_KEEP must be whole numbers above 0, not \"$count\"" ;;
  esac
done

mkdir -p "$DEST"
chmod 700 "$DEST"

# Plain SQL, so a restore needs nothing but psql. --clean lets the file be
# applied over an existing schema when restoring.
compose exec -T postgres pg_dump -U postgres -d integr8 --clean --if-exists | gzip -9 > "$file.tmp"
mv "$file.tmp" "$file"

# Keep the newest KEEP files; the rest go.
ls -1t "$DEST"/integr8-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

log "wrote $file ($(du -h "$file" | cut -f1)), keeping $KEEP"

if [ -z "$REMOTE" ]; then
  log "BACKUP_REMOTE is not set: backups are on this machine only and are lost with it (docs/database/runbook-backup-and-restore.md, part 2)"
  ping_monitor
  exit 0
fi

# `remote:` and `remote:dir/` take the name as it is; `remote:dir` needs a slash.
remote_path() {
  case "$REMOTE" in
    *: | */) printf '%s%s' "$REMOTE" "$1" ;;
    *) printf '%s/%s' "$REMOTE" "$1" ;;
  esac
}

command -v rclone > /dev/null ||
  fail "BACKUP_REMOTE is set but rclone is not installed; $name is on this machine only"

# rclone checks the size, and the hash where the remote has one, after the
# upload; a non-zero exit means the copy is not there or not whole.
rclone copyto "$file" "$(remote_path "$name")" --retries 3 ||
  fail "could not copy $name to $REMOTE; it is on this machine only"
log "copied $name to $REMOTE"

# Only files this script writes are ever deleted from the remote; anything else
# in the bucket is left alone. The names sort by date.
listing=$(rclone lsf "$REMOTE" --files-only) ||
  fail "copied $name, but could not list $REMOTE to remove old copies"
old=$(printf '%s\n' "$listing" | grep -E '^integr8-[0-9]{8}-[0-9]{4}\.sql\.gz$' | sort -r |
  tail -n +"$((REMOTE_KEEP + 1))" || true)
removed=0
for stale in $old; do
  rclone deletefile "$(remote_path "$stale")" ||
    fail "copied $name, but could not delete the old copy $stale from $REMOTE"
  removed=$((removed + 1))
done
log "keeping $REMOTE_KEEP on $REMOTE (removed $removed)"

ping_monitor
