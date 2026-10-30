#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
script_dir=$(cd "$(dirname "$0")" && pwd)
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04* ]] || { echo 'Ubuntu 24.04 is required.' >&2; exit 1; }
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates jq rsync age podman sqlite3 uidmap slirp4netns ufw xz-utils
id openclaw >/dev/null 2>&1 || useradd --create-home --shell /bin/bash openclaw
install -d -o openclaw -g openclaw -m 0700 /var/lib/openclaw /var/lib/openclaw/imports /var/lib/openclaw/workspace
install -d -o root -g root -m 0755 /opt/jarvis-v1
if ! swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
  [[ ! -e /swapfile ]] && fallocate -l 2G /swapfile
  chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
if ! command -v node >/dev/null || ! node -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M===24&&m>=15?0:1)'; then
  : "${NODE_TARBALL_PATH:?Provide a locally downloaded official Node 24 tarball.}"
  : "${NODE_TARBALL_SHA256:?Provide its verified SHA-256.}"
  echo "$NODE_TARBALL_SHA256  $NODE_TARBALL_PATH" | sha256sum --check --status || { echo 'Node tarball checksum mismatch.' >&2; exit 1; }
  tar -xJf "$NODE_TARBALL_PATH" -C /usr/local --strip-components=1
fi
node -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M===24&&m>=15?0:1)' || { echo 'Node >=24.15 <25 required.' >&2; exit 1; }
"$script_dir/provision-sandbox.sh"
echo 'BOOTSTRAP_OK no cloud resource was created by this script.'
