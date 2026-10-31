#!/usr/bin/env bash
# Tells a heartbeat monitor the API is up, from the machine itself.
#
# /health and /health/ready are not served on the public address: Caddy answers
# 404 for them (deploy/vps/Caddyfile.example), so an outside uptime check cannot
# use them. Instead this runs from cron every few minutes, asks the API on
# 127.0.0.1 whether it is ready, and calls HEALTH_PING_URL when it is. The
# monitor (Better Stack, healthchecks.io, an UptimeRobot heartbeat) alerts when
# the calls stop: when the API is not ready, when the machine is down, and when
# cron itself stopped. When the API answers "not ready" it calls the same URL
# with /fail added, so a monitor that understands it (healthchecks.io, Better
# Stack) alerts at once instead of after its grace period.
#
# Schedule it as root, every five minutes:
#
#   sudo crontab -e
#   */5 * * * * /opt/integr8/deploy/vps/heartbeat.sh >> /var/log/integr8-heartbeat.log 2>&1
#
# Settings, from deploy/.env (or the environment, which wins):
#
#   HEALTH_PING_URL     the monitor's heartbeat URL. Unset: the script checks
#                       and logs, and pings nothing.
#   HEALTH_PING_FAIL    "off" for a monitor with no /fail address (UptimeRobot):
#                       nothing is called when the API is not ready, and the
#                       silence alerts. Default "on".
#   API_PORT            the API's port on 127.0.0.1, as in compose. Default 3000.
#
# Exits 0 when ready, 1 when not, so a run by hand says which.
set -uo pipefail

REPO="${INTEGR8_DIR:-/opt/integr8}"
ENV_FILE="${ENV_FILE:-$REPO/deploy/.env}"

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

PING_URL="$(setting HEALTH_PING_URL)"
PING_FAIL="$(setting HEALTH_PING_FAIL)"
PORT="$(setting API_PORT)"
PORT="${PORT:-3000}"

ping_monitor() {
  [ -n "$PING_URL" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${PING_URL%/}${1:+/$1}" ||
    log "WARNING: could not reach HEALTH_PING_URL"
}

# The readiness answer is JSON with "status":"ready" and HTTP 200, or
# "degraded" and 503 with the check that failed. Both are looked at: a proxy or
# a half-started process can answer 200 with something else.
body=$(curl -sS -m 10 -w '\n%{http_code}' "http://127.0.0.1:${PORT}/health/ready" 2>&1)
code="${body##*$'\n'}"
body="${body%$'\n'*}"

if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"status":"ready"'; then
  ping_monitor
  exit 0
fi

log "NOT READY (HTTP ${code:-none}): $(printf '%s' "$body" | tr -d '\n' | cut -c1-400)"
if [ "$PING_FAIL" != "off" ]; then
  ping_monitor fail
fi
exit 1
