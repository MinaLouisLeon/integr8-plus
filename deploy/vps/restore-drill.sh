#!/usr/bin/env bash
# Restores one backup into a throwaway Postgres container, checks what came
# back, times it, removes the container, and prints a line for the rehearsal
# log in docs/database/runbook-backup-and-restore.md.
#
# It never touches the live database. The container is started from the
# Postgres image directly, not through compose: its own name, no network, no
# published port, no volume of the stack's, and it is removed (with its data)
# when the drill ends, however it ends.
#
# Run it as root, on the machine or on the test box:
#
#   sudo /opt/integr8/deploy/vps/restore-drill.sh              # newest dump in /var/backups/integr8
#   sudo /opt/integr8/deploy/vps/restore-drill.sh FILE.sql.gz  # that dump
#   sudo /opt/integr8/deploy/vps/restore-drill.sh --remote     # newest copy on BACKUP_REMOTE
#
# --remote downloads through rclone, exactly as a new machine would, so it
# proves the off-machine copy as well as the dump. The download is deleted
# afterwards.
set -euo pipefail

REPO="${INTEGR8_DIR:-/opt/integr8}"
DEST="${BACKUP_DIR:-/var/backups/integr8}"
ENV_FILE="$REPO/deploy/.env"

started=$(date +%s)
container="integr8-restore-drill-$(date -u +%Y%m%d%H%M%S)"
work=''

log() {
  echo "$(date -u +%FT%TZ) $*"
}

fail() {
  echo "$(date -u +%FT%TZ) DRILL FAILED: $*" >&2
  exit 1
}

cleanup() {
  docker rm -f -v "$container" > /dev/null 2>&1 || true
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'fail "stopped at line $LINENO; the lines above say why"' ERR

took() {
  local seconds=$(($2 - $1))
  printf '%dm %02ds' $((seconds / 60)) $((seconds % 60))
}

# The same reading of deploy/.env as backup-postgres.sh: never sourced.
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

remote_path() {
  case "$1" in
    *: | */) printf '%s%s' "$1" "$2" ;;
    *) printf '%s/%s' "$1" "$2" ;;
  esac
}

# Runs SQL in the drill container, never anywhere else.
drill_sql() {
  docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$container" \
    psql -U postgres -d integr8 -v ON_ERROR_STOP=1 -X -q "$@"
}

docker info > /dev/null 2>&1 || fail "cannot reach Docker; run this as root on a machine with Docker"

# ---------------------------------------------------------------- the dump
case "${1:-}" in
  --remote)
    remote="$(setting BACKUP_REMOTE)"
    [ -n "$remote" ] || fail "--remote needs BACKUP_REMOTE in $ENV_FILE"
    command -v rclone > /dev/null || fail "--remote needs rclone"
    newest=$(rclone lsf "$remote" --files-only | grep -E '^integr8-[0-9]{8}-[0-9]{4}\.sql\.gz$' |
      sort | tail -n 1 || true)
    [ -n "$newest" ] || fail "no integr8-*.sql.gz on $remote"
    # Beside the local dumps: root-only, and on a disk with room for one.
    mkdir -p "$DEST"
    chmod 700 "$DEST"
    work=$(mktemp -d "$DEST/restore-drill.XXXXXX")
    fetching=$(date +%s)
    rclone copyto "$(remote_path "$remote" "$newest")" "$work/$newest" ||
      fail "could not download $newest from $remote"
    file="$work/$newest"
    source="$newest from $remote (downloaded in $(took "$fetching" "$(date +%s)"))"
    ;;
  '')
    file=$(ls -1t "$DEST"/integr8-*.sql.gz 2> /dev/null | head -n 1 || true)
    [ -n "$file" ] || fail "no integr8-*.sql.gz in $DEST; run backup-postgres.sh first"
    source="$(basename "$file") on $(hostname -s)"
    ;;
  -*) fail "unknown option $1 (the header of this script lists them)" ;;
  *)
    file="$1"
    [ -r "$file" ] || fail "cannot read $file"
    source="$(basename "$file") on $(hostname -s)"
    ;;
esac

log "drill: $source, $(du -h "$file" | cut -f1)"
gunzip -t "$file" || fail "$file is not a whole gzip file"

# ---------------------------------------------------------- the container
# The same Postgres image the stack runs, so the drill restores into what a
# real restore would.
image=$(sed -nE 's/^[[:space:]]+image:[[:space:]]+(postgres:[^[:space:]]+).*/\1/p' \
  "$REPO/deploy/compose.yml" 2> /dev/null | head -n 1 || true)
image="${image:-postgres:16}"

docker run -d --rm --name "$container" --network none --memory 2g \
  --label integr8.restore-drill=true \
  -e POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | base64)" -e POSTGRES_DB=integr8 \
  "$image" > /dev/null
log "started $container from $image (no network, removed when the drill ends)"

# The image's first start runs a temporary server on its socket only, then
# restarts. Waiting on TCP waits for the real one.
for _ in $(seq 1 90); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d integr8 -q 2> /dev/null; then
    ready=yes
    break
  fi
  sleep 1
done
[ "${ready:-}" = yes ] || fail "the drill's Postgres did not start within 90 seconds"

# Roles are cluster-wide, so the dump has none; it names them as owners and in
# grants. Create each one it mentions, without a password: nothing signs in here.
roles=$( (
  printf '%s\n' integr8_app integr8_auth supabase_auth_admin
  gunzip -c "$file" | sed -nE 's/^(ALTER .* OWNER TO|GRANT .* TO) ([a-z_][a-z0-9_]*);$/\2/p'
) | sort -u | grep -vxE 'postgres|public' || true)
for role in $roles; do
  drill_sql -c "do \$\$ begin create role $role nologin; exception when duplicate_object then null; end \$\$;"
done

# --------------------------------------------------------------- restore
restoring=$(date +%s)
gunzip -c "$file" | drill_sql -o /dev/null || fail "the restore stopped with an error"
restored=$(date +%s)
log "restored in $(took "$restoring" "$restored")"

# ----------------------------------------------------------------- checks
# One row: latest migration, how many, companies, members, audit entries,
# sign-in accounts (if the dump has Auth's schema), RLS policies, and grants
# to the runtime role. The last two prove isolation came back with the data.
counts=$(drill_sql -At -F '|' -c "
  select
    (select max(version) from schema_migrations),
    (select count(*) from schema_migrations),
    (select count(*) from tenants),
    (select count(*) from tenant_users),
    (select count(*) from audit_log),
    case when to_regclass('auth.users') is null then 'none' else
      (xpath('/row/c/text()', query_to_xml('select count(*) as c from auth.users', false, true, '')))[1]::text
    end,
    (select count(*) from pg_policies where schemaname = 'public'),
    (select count(*) from information_schema.role_table_grants where grantee = 'integr8_app')
") || fail "the restored database is missing a table every backup has (schema_migrations, tenants, tenant_users or audit_log)"

IFS='|' read -r version applied tenants members audit accounts policies grants <<< "$counts"

[ -n "$version" ] || fail "schema_migrations is empty"
[ "$policies" -gt 0 ] || fail "no row-level security policies came back; this restore must not serve traffic"
[ "$grants" -gt 0 ] || fail "integr8_app has no grants; this restore must not serve traffic"

# Against the migrations in this checkout, so a dump older than the code is
# visible: the stack's migrate would bring it forward on a real restore.
newest_file=$(ls -1 "$REPO"/packages/db/migrations/*.up.sql 2> /dev/null | tail -n 1 || true)
newest_file=$(basename "${newest_file:-none}" | cut -c1-4)
if [ "$version" = "$newest_file" ]; then
  schema="migrations to $version, as this checkout"
elif [ "$newest_file" = none ]; then
  schema="migrations to $version"
elif [[ "$version" < "$newest_file" ]]; then
  schema="migrations to $version, behind this checkout's $newest_file (migrate applies the rest)"
else
  schema="migrations to $version, ahead of this checkout's $newest_file"
fi

if [ "$accounts" = none ]; then
  accounts='no sign-in accounts (the dump has no Auth tables)'
else
  accounts="$accounts sign-in accounts"
fi

finished=$(date +%s)
log "$schema ($applied applied)"
log "$tenants companies, $members members, $audit audit entries, $accounts"
log "$policies row-level security policies, $grants grants to integr8_app"
log "drill passed in $(took "$started" "$finished"); removing $container"

echo
echo 'Add this row to the rehearsal log in docs/database/runbook-backup-and-restore.md:'
echo
printf '| %s | %s | %s | %s | %s; %s companies, %s members, %s audit entries, %s; %s policies | restore-drill.sh, %s, whole drill %s |\n' \
  "$(date -u +%F)" "${SUDO_USER:-$(id -un)}" "$source" "$(took "$restoring" "$restored")" \
  "$schema" "$tenants" "$members" "$audit" "$accounts" "$policies" "$image" "$(took "$started" "$finished")"
