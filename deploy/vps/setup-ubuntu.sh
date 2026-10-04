#!/usr/bin/env bash
# Prepares a fresh Ubuntu 22.04 or 24.04 machine (x86 or ARM) to run the compose
# stack in deploy/compose.yml behind Caddy. Run once, as a user with sudo:
#
#   curl -fsSL https://raw.githubusercontent.com/MinaLouisLeon/integr8-plus/main/deploy/vps/setup-ubuntu.sh | bash
#
# or from a checkout: bash deploy/vps/setup-ubuntu.sh
#
# What it does, and why each part exists:
#
# 1. Opens ports 80 and 443 in the machine's own firewall. Cloud images from
#    Oracle ship iptables rules that drop everything but SSH, *in addition to*
#    the cloud console's security list, so a port opened in the console is still
#    closed until this runs. On images without those rules it is a no-op.
# 2. Installs Docker from Docker's own repository (Ubuntu's package lags and
#    lacks the compose plugin), and lets the current user run it without sudo.
# 3. Installs Caddy, the reverse proxy that obtains and renews TLS certificates
#    by itself. deploy/vps/Caddyfile.example is the two-site configuration.
#
# Idempotent: running it again changes nothing that is already in place.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=''
else
  SUDO='sudo'
fi

echo '==> Firewall: allow 80 and 443'
if command -v iptables >/dev/null 2>&1; then
  for port in 80 443; do
    if ! $SUDO iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      # Insert at the top: Oracle's default chain ends in a REJECT rule, so an
      # appended ACCEPT would never be reached.
      $SUDO iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
    fi
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then
    $SUDO netfilter-persistent save >/dev/null
  elif [ -d /etc/iptables ]; then
    $SUDO sh -c 'iptables-save > /etc/iptables/rules.v4'
  fi
fi
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q '^Status: active'; then
  $SUDO ufw allow 80/tcp >/dev/null
  $SUDO ufw allow 443/tcp >/dev/null
fi

echo '==> Docker'
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | $SUDO sh
fi
if [ -n "$SUDO" ] && ! id -nG "$USER" | grep -qw docker; then
  $SUDO usermod -aG docker "$USER"
  echo "    added $USER to the docker group; log out and in again before running docker without sudo"
fi
docker compose version

echo '==> Caddy'
if ! command -v caddy >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq caddy
fi
$SUDO apt-get install -y -qq git >/dev/null

echo
echo 'Done. Next:'
echo '  1. git clone the repository to /opt/integr8 and fill deploy/.env'
echo '  2. copy deploy/vps/Caddyfile.example to /etc/caddy/Caddyfile with your hostnames, then: sudo systemctl reload caddy'
echo '  3. docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build'
