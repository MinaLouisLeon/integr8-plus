#!/usr/bin/env bash
# Tells a heartbeat monitor the API is up, from the machine itself.
#
# /health and /health/ready are not served on the public address: the stack's
# edge container answers 404 for them (deploy/edge/Caddyfile), so an outside
# uptime check cannot use them. Instead this runs from cron every few minutes,
# asks the API whether it is ready (deploy/vps/ready.sh, from inside the API's
# own container: it publishes no port), and calls HEALTH_PING_URL when it is. The
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

ping_monitor() {
  [ -n "$PING_URL" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${PING_URL%/}${1:+/$1}" ||
    log "WARNING: could not reach HEALTH_PING_URL"
}

# ready.sh does the asking and the judging (HTTP 200 and "status":"ready"), and
# says what is wrong in one NOT READY line when it is not. It runs with the same
# settings this script resolved above.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if answer=$(INTEGR8_DIR="$REPO" ENV_FILE="$ENV_FILE" bash "$here/ready.sh" 2>&1); then
  ping_monitor
  exit 0
fi

log "$answer"
if [ "$PING_FAIL" != "off" ]; then
  ping_monitor fail
fi
exit 1
