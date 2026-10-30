#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
export OPENCLAW_CONFIG_PATH=/var/lib/openclaw/openclaw.json5
export OPENCLAW_STATE_DIR=/var/lib/openclaw
run_openclaw() {
  sudo -u openclaw --preserve-env=OPENCLAW_CONFIG_PATH,OPENCLAW_STATE_DIR openclaw "$@"
}
systemctl is-active --quiet openclaw.service || { echo 'SMOKE_FAIL service_inactive' >&2; exit 1; }
ss -ltnH | awk '$4 ~ /:18789$/ {print $4}' | grep -Eq '^(127\.0\.0\.1|\[::1\]):18789$' || { echo 'SMOKE_FAIL gateway_not_loopback' >&2; exit 1; }
if ss -ltnH | awk '$4 ~ /:18789$/ {print $4}' | grep -Evq '^(127\.0\.0\.1|\[::1\]):18789$'; then echo 'SMOKE_FAIL gateway_public' >&2; exit 1; fi
tailscale status >/dev/null || { echo 'SMOKE_FAIL tailscale_unavailable' >&2; exit 1; }
! tailscale funnel status 2>/dev/null | grep -Eqi 'https://|on' || { echo 'SMOKE_FAIL tailscale_funnel_enabled' >&2; exit 1; }
run_openclaw security audit --json >/dev/null
run_openclaw plugins inspect jarvis-tools --runtime --json >/dev/null
printf 'SMOKE_OK service, loopback, Tailscale and plugin checks passed.\n'
