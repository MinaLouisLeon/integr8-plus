#!/usr/bin/env bash
# Prepares a fresh Linux machine (x86 or ARM) to run the compose stack in
# deploy/compose.yml behind Caddy. Supports the two families the cloud consoles
# offer: Debian-based (Ubuntu 22.04/24.04, Debian 12) and Red Hat-based (Oracle
# Linux 8/9, RHEL, Rocky, AlmaLinux). Run once, as a user with sudo:
#
#   curl -fsSL https://raw.githubusercontent.com/MinaLouisLeon/integr8-plus/main/deploy/vps/setup.sh | bash
#
# or from a checkout: bash deploy/vps/setup.sh
#
# What it does, and why each part exists:
#
# 1. Opens ports 80 and 443 in the machine's own firewall. Cloud images block
#    everything but SSH on the machine itself, *in addition to* the console's
#    security list, so a port opened in the console is still closed until this
#    runs. Ubuntu images from Oracle do it with iptables rules; Oracle Linux does
#    it with firewalld. Both are handled; on a machine with neither it is a no-op.
# 2. Installs Docker from Docker's own repository (distribution packages lag and
#    lack the compose plugin), and lets the current user run it without sudo.
# 3. Installs Caddy, the reverse proxy that obtains and renews TLS certificates
#    by itself. deploy/vps/Caddyfile.example is the two-site configuration.
# 4. Turns on automatic security updates for the operating system. Docker and
#    the containers are not touched by it; those update when you deploy.
#
# Idempotent: running it again changes nothing that is already in place.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=''
else
  SUDO='sudo'
fi

# Which family this is. ID_LIKE catches derivatives (Oracle Linux says
# "fedora", Pop!_OS says "ubuntu debian").
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *' ubuntu '*|*' debian '*) FAMILY=debian ;;
  *' rhel '*|*' fedora '*|*' centos '*|*' ol '*) FAMILY=rhel ;;
  *)
    echo "Unsupported distribution: ${PRETTY_NAME:-unknown}. Use Ubuntu 24.04 or Oracle Linux 9." >&2
    exit 1
    ;;
esac
echo "==> ${PRETTY_NAME:-$ID} ($FAMILY family, $(uname -m))"

echo '==> Firewall: allow 80 and 443'
if command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  # Oracle Linux, RHEL and friends: firewalld owns the rules.
  $SUDO firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  $SUDO firewall-cmd --reload >/dev/null
elif command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q '^Status: active'; then
  $SUDO ufw allow 80/tcp >/dev/null
  $SUDO ufw allow 443/tcp >/dev/null
elif command -v iptables >/dev/null 2>&1; then
  # Oracle's Ubuntu images: a plain iptables chain that ends in REJECT, so the
  # ACCEPT rules go at the top, and are saved so they survive a reboot.
  for port in 80 443; do
    if ! $SUDO iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      $SUDO iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
    fi
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then
    $SUDO netfilter-persistent save >/dev/null
  elif [ -d /etc/iptables ]; then
    $SUDO sh -c 'iptables-save > /etc/iptables/rules.v4'
  fi
fi

echo '==> Docker'
if ! command -v docker >/dev/null 2>&1; then
  if [ "$FAMILY" = debian ]; then
    curl -fsSL https://get.docker.com | $SUDO sh
  else
    # Docker's RHEL/CentOS repository serves Oracle Linux 8 and 9 on x86_64 and
    # aarch64. The podman stack that ships on these images conflicts with
    # containerd, so it goes first; nothing here uses it.
    $SUDO dnf -y -q remove podman buildah runc docker docker-engine 2>/dev/null || true
    $SUDO dnf -y -q install dnf-plugins-core
    $SUDO dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    $SUDO dnf -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    $SUDO systemctl enable --now docker
  fi
fi
if [ -n "$SUDO" ] && ! id -nG "$USER" | grep -qw docker; then
  $SUDO usermod -aG docker "$USER"
  echo "    added $USER to the docker group; log out and in again before running docker without sudo"
fi
$SUDO docker compose version

echo '==> Caddy'
if ! command -v caddy >/dev/null 2>&1; then
  if [ "$FAMILY" = debian ]; then
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq caddy
  else
    # Caddy's official RPMs live in a Fedora COPR that also builds for EPEL 9.
    # If the COPR is unreachable for this release or architecture, fall back to
    # the official static binary with the same service definition the RPM uses.
    if ! { $SUDO dnf -y -q install 'dnf-command(copr)' \
        && $SUDO dnf -y -q copr enable @caddy/caddy \
        && $SUDO dnf -y -q install caddy; }; then
      echo '    COPR install failed; installing the official binary instead'
      case "$(uname -m)" in
        aarch64) CADDY_ARCH=arm64 ;;
        *) CADDY_ARCH=amd64 ;;
      esac
      curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${CADDY_ARCH}" -o /tmp/caddy
      $SUDO install -m 0755 /tmp/caddy /usr/bin/caddy && rm -f /tmp/caddy
      id caddy >/dev/null 2>&1 || $SUDO useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
      $SUDO mkdir -p /etc/caddy /var/lib/caddy
      $SUDO chown caddy:caddy /var/lib/caddy
      [ -f /etc/caddy/Caddyfile ] || echo ':80 { respond "Caddy is running" }' | $SUDO tee /etc/caddy/Caddyfile >/dev/null
      $SUDO tee /etc/systemd/system/caddy.service >/dev/null <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
      $SUDO systemctl daemon-reload
    fi
  fi
fi
$SUDO systemctl enable --now caddy >/dev/null 2>&1 || true

echo '==> Automatic security updates'
if [ "$FAMILY" = debian ]; then
  $SUDO apt-get install -y -qq unattended-upgrades >/dev/null
  $SUDO dpkg-reconfigure -f noninteractive unattended-upgrades
else
  $SUDO dnf -y -q install dnf-automatic
  $SUDO sed -i 's/^apply_updates = no/apply_updates = yes/; s/^upgrade_type = default/upgrade_type = security/' /etc/dnf/automatic.conf
  $SUDO systemctl enable --now dnf-automatic.timer
fi

echo '==> git'
if ! command -v git >/dev/null 2>&1; then
  if [ "$FAMILY" = debian ]; then
    $SUDO apt-get install -y -qq git >/dev/null
  else
    $SUDO dnf -y -q install git
  fi
fi

echo
echo 'Done. Next:'
echo '  1. git clone the repository to /opt/integr8 and fill deploy/.env'
echo '  2. copy deploy/vps/Caddyfile.example to /etc/caddy/Caddyfile with your hostnames, then: sudo systemctl reload caddy'
echo '  3. docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build'
echo '  4. schedule deploy/vps/backup-postgres.sh from cron (see its header) before any real data goes in'
