#!/usr/bin/env bash
set -Eeuo pipefail

failures=0
blocked() { printf 'BLOCKED_EXTERNAL code=%s action=%s\n' "$1" "$2" >&2; failures=$((failures + 1)); }
required() { [[ -n "${!1:-}" ]] || blocked "$1" "$2"; }

required DIGITALOCEAN_PURCHASE_APPROVED "Approve the paid Droplet purchase explicitly."
[[ "${DIGITALOCEAN_PURCHASE_APPROVED:-}" == "YES" ]] || blocked DIGITALOCEAN_PURCHASE_APPROVED "Set exactly YES only after explicit purchase approval."
required TELEGRAM_BOT_TOKEN "Create a bot with BotFather and store its token in the protected environment file."
[[ "${TELEGRAM_OWNER_ID:-}" =~ ^[1-9][0-9]{5,19}$ ]] || blocked TELEGRAM_OWNER_ID "Set the operator's numeric Telegram user ID."
required OPENCLAW_GATEWAY_TOKEN "Generate a random gateway token of at least 32 characters."
gateway_token=${OPENCLAW_GATEWAY_TOKEN:-}
(( ${#gateway_token} >= 32 )) || blocked OPENCLAW_GATEWAY_TOKEN "Use a token containing at least 32 characters."
required OPENAI_API_KEY "Create a dedicated OpenAI project key with a USD 12 monthly hard limit."
required GOOGLE_MANAGED_CALENDAR_ID "Create the dedicated Jarvis Plan calendar and complete Google OAuth consent."
for variable in GOOGLE_CLIENT_ID_FILE GOOGLE_CLIENT_SECRET_FILE GOOGLE_REFRESH_TOKEN_FILE; do
  required "$variable" "Configure the protected Google OAuth credential file path."
  credential_file=${!variable:-}
  [[ -n "$credential_file" && -f "$credential_file" && -r "$credential_file" ]] ||
    blocked "$variable" "Create a regular credential file readable by the openclaw service user."
done
[[ "${GOOGLE_PRIMARY_CALENDAR_ID:-primary}" != "${GOOGLE_MANAGED_CALENDAR_ID:-}" ]] || blocked GOOGLE_CALENDAR_SEPARATION "Primary and managed calendar IDs must differ."
required TAILSCALE_AUTH_READY "Authenticate the VPS into the private tailnet."
[[ "${TAILSCALE_AUTH_READY:-}" == "YES" ]] || blocked TAILSCALE_AUTH_READY "Set exactly YES only after tailscale status succeeds."
required JARVIS_BACKUP_DESTINATION "Configure a private backup destination."
required BACKUP_AGE_RECIPIENT "Configure an age recipient for encrypted backups."
[[ -d "${JARVIS_IMPORT_DIR:-/var/lib/openclaw/imports}" ]] || blocked IMPORT_DIRECTORY "Create the private statement import directory."
sandbox_image=${JARVIS_SANDBOX_IMAGE:-openclaw-sandbox:bookworm-slim}
sudo -u openclaw podman image exists "$sandbox_image" ||
  blocked SANDBOX_IMAGE "Run deploy/provision-sandbox.sh before enabling OpenClaw."

if (( failures > 0 )); then
  printf 'PREFLIGHT_FAILED blockers=%d\n' "$failures" >&2
  exit 1
fi
printf 'PREFLIGHT_OK external prerequisites are present; secret values were not printed.\n'
