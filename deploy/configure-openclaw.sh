#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
repo_root=${1:-$(cd "$(dirname "$0")/.." && pwd)}
[[ -f /etc/jarvis-v1.env ]] || { echo 'BLOCKED_EXTERNAL code=ENV_FILE action=Create /etc/jarvis-v1.env mode 0600.' >&2; exit 1; }
set -a; source /etc/jarvis-v1.env; set +a
"$repo_root/deploy/preflight.sh"
npm install --global openclaw@2026.9.1
[[ "$(openclaw --version | grep -o '2026\.9\.1' | head -1)" == '2026.9.1' ]] || { echo 'Pinned OpenClaw version check failed.' >&2; exit 1; }
rsync -a --delete "$repo_root/workspace/" /var/lib/openclaw/workspace/
rsync -a --delete "$repo_root/plugins/jarvis-tools/" /opt/jarvis-v1/plugins/jarvis-tools/ --exclude src --exclude tsconfig.json
install -o openclaw -g openclaw -m 0600 "$repo_root/config/openclaw.production.json5" /var/lib/openclaw/openclaw.json5
chown -R openclaw:openclaw /var/lib/openclaw /opt/jarvis-v1/plugins
plugin_dir=/opt/jarvis-v1/plugins/jarvis-tools
[[ -f "$plugin_dir/dist/index.js" && -f "$plugin_dir/openclaw.plugin.json" && -f "$plugin_dir/package-lock.json" ]] ||
  { echo 'Plugin production artifact is incomplete; service remains disabled.' >&2; exit 1; }
sudo -u openclaw npm ci --prefix "$plugin_dir" --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund
install -o root -g root -m 0644 "$repo_root/deploy/openclaw.service" /etc/systemd/system/openclaw.service
systemctl daemon-reload
systemctl enable --now openclaw.service
printf 'CONFIGURE_OK OpenClaw 2026.9.1 installed and service started.\n'
