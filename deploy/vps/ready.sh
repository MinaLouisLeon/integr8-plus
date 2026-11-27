#!/usr/bin/env bash
# Asks the API whether it is ready, from inside its own container.
#
# The API publishes no port on the machine (the front proxy reaches it through the edge
# container, which answers 404 for /health and /health/ready on the public address), so this
# is how the machine itself asks: the setup guide's checks, deploy/vps/heartbeat.sh, and you.
#
#   bash deploy/vps/ready.sh        (bash, not sh: it is not POSIX)
#
# Prints the API's answer and exits 0 when it is ready (HTTP 200 and "status":"ready"). When it
# is not ready, or cannot be asked at all (the container is down), it prints one line starting
# NOT READY, with the HTTP status (or none) and what came back, and exits 1. The answer names
# what is failing, so read it.
#
# Settings, from the environment (which wins) or the defaults:
#   INTEGR8_DIR   the repository on the machine. Default /opt/integr8.
#   ENV_FILE      the settings file. Default $INTEGR8_DIR/deploy/.env.
set -uo pipefail

REPO="${INTEGR8_DIR:-/opt/integr8}"
ENV_FILE="${ENV_FILE:-$REPO/deploy/.env}"

# The script runs inside the container, which holds node and the API's own port. It prints the
# answer, a newline, and the HTTP status, and always exits 0: a refused connection is an
# answer too (000), not a crash.
probe="fetch('http://127.0.0.1:3000/health/ready')
  .then(async (r) => { process.stdout.write((await r.text()) + '\n' + r.status); })
  .catch((e) => { process.stdout.write(String(e && e.message) + '\n000'); });"

out=$(cd "$REPO" && docker compose -f deploy/compose.yml --env-file "$ENV_FILE" exec -T api node -e "$probe" 2>&1)
code="${out##*$'\n'}"
body="${out%$'\n'*}"
# Docker's own error ("service api is not running") is not an answer from the API: no status.
case "$code" in
  [0-9][0-9][0-9]) ;;
  *)
    body="$out"
    code=none
    ;;
esac

# The readiness answer is JSON with "status":"ready" and HTTP 200, or "degraded" and 503 with the
# check that failed. Both are looked at: a proxy or a half-started process can answer 200 with
# something else.
if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"status":"ready"'; then
  printf '%s\n' "$body"
  exit 0
fi

printf 'NOT READY (HTTP %s): %s\n' "${code:-none}" "$(printf '%s' "$body" | tr -d '\n' | cut -c1-400)"
exit 1
