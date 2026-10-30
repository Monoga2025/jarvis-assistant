#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

blocked() {
  printf 'RAILWAY_STARTUP_BLOCKED code=%s\n' "$1" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || blocked ROOT_BOOTSTRAP_REQUIRED
[[ "${RAILWAY_VOLUME_MOUNT_PATH:-/data}" == "/data" ]] || blocked VOLUME_MUST_BE_DATA
[[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] || blocked TELEGRAM_BOT_TOKEN_MISSING
[[ "${TELEGRAM_ALLOWED_USER_ID:-}" =~ ^[1-9][0-9]{5,19}$ ]] || blocked TELEGRAM_ALLOWED_USER_ID_INVALID
[[ -n "${OPENAI_API_KEY:-}" ]] || blocked OPENAI_API_KEY_MISSING

export TELEGRAM_OWNER_ID="$TELEGRAM_ALLOWED_USER_ID"
export JARVIS_ROOT=/data/jarvis-v1
export OPENCLAW_STATE_DIR="$JARVIS_ROOT/state"
export OPENCLAW_WORKSPACE_DIR="$JARVIS_ROOT/workspace"
export OPENCLAW_CONFIG_PATH="$JARVIS_ROOT/config/openclaw.json5"
export JARVIS_PLUGIN_PATH=/app/plugins/jarvis-tools
export JARVIS_TIMEZONE="${JARVIS_TIMEZONE:-America/Bogota}"
export TZ="$JARVIS_TIMEZONE"

if [[ -n "${REMINDER_POLL_SECONDS:-}" ]]; then
  [[ "$REMINDER_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || blocked REMINDER_POLL_SECONDS_INVALID
  (( 10#$REMINDER_POLL_SECONDS >= 5 && 10#$REMINDER_POLL_SECONDS <= 3600 )) || blocked REMINDER_POLL_SECONDS_INVALID
fi
export REMINDER_POLL_SECONDS="${REMINDER_POLL_SECONDS:-60}"

# Literal-only Tasks canary validation happens before SQLite, credential reads, or network clients.
export JARVIS_GOOGLE_TASKS_ENABLED="${JARVIS_GOOGLE_TASKS_ENABLED:-false}"
case "$JARVIS_GOOGLE_TASKS_ENABLED" in
  false) ;;
  true)
    [[ "${JARVIS_CALENDAR_ENABLED:-false}" == true ]] || blocked GOOGLE_TASKS_REQUIRES_CALENDAR
    [[ "${JARVIS_GOOGLE_TASKS_CANARY_MODE:-}" == single_insert ]] || blocked GOOGLE_TASKS_CANARY_MODE_INVALID
    [[ "${GOOGLE_TASKS_LIST_ID:-}" =~ ^[A-Za-z0-9_-]{1,512}$ ]] || blocked GOOGLE_TASKS_LIST_ID_INVALID
    [[ "${JARVIS_GOOGLE_TASKS_POLL_SECONDS:-}" =~ ^[1-9][0-9]*$ ]] || blocked GOOGLE_TASKS_POLL_SECONDS_INVALID
    (( 10#$JARVIS_GOOGLE_TASKS_POLL_SECONDS >= 5 && 10#$JARVIS_GOOGLE_TASKS_POLL_SECONDS <= 3600 )) || blocked GOOGLE_TASKS_POLL_SECONDS_INVALID
    ;;
  *) blocked JARVIS_GOOGLE_TASKS_ENABLED_INVALID ;;
esac
export JARVIS_GOOGLE_TASKS_POLL_SECONDS="${JARVIS_GOOGLE_TASKS_POLL_SECONDS:-60}"

# Preserve compatibility with the existing variable without trusting its old
# directory: only its final filename is reused inside the isolated namespace.
database_hint="${JARVIS_DB_PATH:-jarvis.sqlite}"
database_name="${database_hint##*/}"
[[ "$database_name" =~ ^[A-Za-z0-9._-]+$ && "$database_name" != "." && "$database_name" != ".." ]] || blocked JARVIS_DB_PATH_INVALID
export JARVIS_DATABASE_PATH="$JARVIS_ROOT/$database_name"

install -d -o node -g node -m 0700 \
  "$JARVIS_ROOT" "$JARVIS_ROOT/state" "$JARVIS_ROOT/config" "$JARVIS_ROOT/credentials" \
  "$JARVIS_ROOT/imports" "$JARVIS_ROOT/workspace" "$JARVIS_ROOT/backups"

write_secret() {
  local variable_name=$1 destination=$2 temporary
  temporary="${destination}.tmp.$$"
  printf '%s' "${!variable_name}" > "$temporary"
  chown node:node "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$destination"
}

write_secret TELEGRAM_BOT_TOKEN "$JARVIS_ROOT/credentials/telegram-bot-token"
export TELEGRAM_BOT_TOKEN_FILE="$JARVIS_ROOT/credentials/telegram-bot-token"
unset TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USER_ID
rm -f -- "$JARVIS_ROOT/credentials/openai-api-key"

if [[ ! -s "$JARVIS_ROOT/credentials/gateway-token" ]]; then
  node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"));' \
    > "$JARVIS_ROOT/credentials/gateway-token.tmp"
  chown node:node "$JARVIS_ROOT/credentials/gateway-token.tmp"
  chmod 0600 "$JARVIS_ROOT/credentials/gateway-token.tmp"
  mv "$JARVIS_ROOT/credentials/gateway-token.tmp" "$JARVIS_ROOT/credentials/gateway-token"
fi
export OPENCLAW_GATEWAY_TOKEN="$(< "$JARVIS_ROOT/credentials/gateway-token")"

export GOOGLE_CLIENT_ID_FILE="$JARVIS_ROOT/credentials/google-client-id"
export GOOGLE_CLIENT_SECRET_FILE="$JARVIS_ROOT/credentials/google-client-secret"
export GOOGLE_REFRESH_TOKEN_FILE="$JARVIS_ROOT/credentials/google-refresh-token"
export JARVIS_CALENDAR_ENABLED="${JARVIS_CALENDAR_ENABLED:-false}"
case "$JARVIS_CALENDAR_ENABLED" in
  true)
    [[ -n "${GOOGLE_CLIENT_ID:-}" && -n "${GOOGLE_CLIENT_SECRET:-}" && -n "${GOOGLE_REFRESH_TOKEN:-}" ]] \
      || blocked GOOGLE_CALENDAR_CREDENTIALS_INCOMPLETE
    export GOOGLE_PRIMARY_CALENDAR_ID="${GOOGLE_PRIMARY_CALENDAR_ID:-primary}"
    export GOOGLE_MANAGED_CALENDAR_ID="${GOOGLE_MANAGED_CALENDAR_ID:-}"
    [[ -n "$GOOGLE_MANAGED_CALENDAR_ID" ]] || blocked GOOGLE_MANAGED_CALENDAR_ID_MISSING
    [[ "$GOOGLE_PRIMARY_CALENDAR_ID" != "$GOOGLE_MANAGED_CALENDAR_ID" ]] || blocked GOOGLE_CALENDAR_IDS_MUST_DIFFER
    write_secret GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID_FILE"
    write_secret GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET_FILE"
    write_secret GOOGLE_REFRESH_TOKEN "$GOOGLE_REFRESH_TOKEN_FILE"
    ;;
  false)
    rm -f -- "$GOOGLE_CLIENT_ID_FILE" "$GOOGLE_CLIENT_SECRET_FILE" "$GOOGLE_REFRESH_TOKEN_FILE"
    export GOOGLE_PRIMARY_CALENDAR_ID=primary
    export GOOGLE_MANAGED_CALENDAR_ID=jarvis-calendar-disabled
    printf 'GOOGLE_CALENDAR_DISABLED_STALE_FILES_REMOVED\n'
    ;;
  *) blocked JARVIS_CALENDAR_ENABLED_INVALID ;;
esac
unset GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN

export JARVIS_SCHEDULE_IMPORT_ENABLED="${JARVIS_SCHEDULE_IMPORT_ENABLED:-false}"
case "$JARVIS_SCHEDULE_IMPORT_ENABLED" in
  true)
    [[ "$JARVIS_CALENDAR_ENABLED" == true ]] || blocked SCHEDULE_IMPORT_REQUIRES_CALENDAR
    [[ -n "${JARVIS_SCHEDULE_ICS_GZIP_BASE64:-}" ]] || blocked JARVIS_SCHEDULE_ICS_GZIP_BASE64_MISSING
    ;;
  false) ;;
  *) blocked JARVIS_SCHEDULE_IMPORT_ENABLED_INVALID ;;
esac

install -o node -g node -m 0600 /app/config/openclaw.railway.json5 "$OPENCLAW_CONFIG_PATH"

if [[ ! -e "$JARVIS_ROOT/.jarvis-initialized" ]]; then
  cp -a --no-clobber /app/workspace/. "$JARVIS_ROOT/workspace/"
  install -o node -g node -m 0600 /dev/null "$JARVIS_ROOT/.jarvis-initialized"
fi

# Refresh only versioned policy files on every release. Durable memory and
# personal notes under the persisted workspace are intentionally untouched.
install -d -o node -g node -m 0700 "$JARVIS_ROOT/workspace/skills/jarvis-os"
install -o node -g node -m 0600 /app/workspace/SOUL.md "$JARVIS_ROOT/workspace/SOUL.md"
install -o node -g node -m 0600 /app/workspace/AGENTS.md "$JARVIS_ROOT/workspace/AGENTS.md"
install -o node -g node -m 0600 /app/workspace/IDENTITY.md "$JARVIS_ROOT/workspace/IDENTITY.md"
install -o node -g node -m 0600 /app/workspace/USER.md "$JARVIS_ROOT/workspace/USER.md"
install -o node -g node -m 0600 /app/workspace/HEARTBEAT.md "$JARVIS_ROOT/workspace/HEARTBEAT.md"
install -o node -g node -m 0600 /app/workspace/skills/jarvis-os/SKILL.md "$JARVIS_ROOT/workspace/skills/jarvis-os/SKILL.md"

chown -R node:node "$JARVIS_ROOT/state" "$JARVIS_ROOT/config" "$JARVIS_ROOT/credentials" \
  "$JARVIS_ROOT/imports" "$JARVIS_ROOT/workspace" "$JARVIS_ROOT/backups"
if [[ -e "$JARVIS_DATABASE_PATH" ]]; then
  chown node:node "$JARVIS_DATABASE_PATH" "$JARVIS_DATABASE_PATH"-wal "$JARVIS_DATABASE_PATH"-shm 2>/dev/null || true
  chmod 0600 "$JARVIS_DATABASE_PATH" "$JARVIS_DATABASE_PATH"-wal "$JARVIS_DATABASE_PATH"-shm 2>/dev/null || true
fi

gosu node node /app/plugins/jarvis-tools/dist/legacy-seed.js

if [[ "$JARVIS_CALENDAR_ENABLED" == true ]]; then
  gosu node node /app/plugins/jarvis-tools/dist/calendar-readiness.js || blocked GOOGLE_CALENDAR_REFRESH_NOT_READY
fi

if [[ "$JARVIS_SCHEDULE_IMPORT_ENABLED" == true ]]; then
  schedule_name=horarios-2026-2.ics
  schedule_path="$JARVIS_ROOT/imports/$schedule_name"
  schedule_temporary="${schedule_path}.tmp.$$"
  printf '%s' "$JARVIS_SCHEDULE_ICS_GZIP_BASE64" | base64 --decode | gzip --decompress > "$schedule_temporary" \
    || { rm -f -- "$schedule_temporary"; blocked JARVIS_SCHEDULE_ICS_GZIP_BASE64_INVALID; }
  chown node:node "$schedule_temporary"
  chmod 0600 "$schedule_temporary"
  mv -f "$schedule_temporary" "$schedule_path"
  export JARVIS_IMPORT_DIRECTORY="$JARVIS_ROOT/imports"
  export JARVIS_SCHEDULE_ICS_FILE="$schedule_name"
  gosu node node /app/plugins/jarvis-tools/dist/schedule-import.js || blocked SCHEDULE_IMPORT_FAILED
  rm -f -- "$schedule_path"
  printf 'SCHEDULE_IMPORT_CONSUMED source=railway-secret-variable\n'
fi
unset JARVIS_SCHEDULE_ICS_GZIP_BASE64

printf 'RAILWAY_STARTUP_READY state=/data/jarvis-v1 runtime_uid=1000 calendar=%s\n' \
  "$([[ "$JARVIS_CALENDAR_ENABLED" == true ]] && printf configured || printf disabled)"

gateway_pid=''
reminder_pid=''
google_tasks_pid=''
forward_signal() {
  local signal=$1
  for pid in "$gateway_pid" "$reminder_pid" "$google_tasks_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "-$signal" "$pid" 2>/dev/null || true; fi
  done
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

gosu node node /app/plugins/jarvis-tools/dist/reminder-worker.js &
reminder_pid=$!
gosu node "$@" &
gateway_pid=$!

openclaw() {
  gosu node /app/node_modules/.bin/openclaw "$@"
}

gateway_ready=false
for _ in $(seq 1 60); do
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    set +e
    wait "$gateway_pid"
    gateway_status=$?
    set -e
    printf 'RAILWAY_STARTUP_BLOCKED code=GATEWAY_EXITED status=%s\n' "$gateway_status" >&2
    exit "$gateway_status"
  fi
  if ! kill -0 "$reminder_pid" 2>/dev/null; then
    forward_signal TERM
    wait "$gateway_pid" 2>/dev/null || true
    blocked REMINDER_WORKER_EXITED
  fi
  if [[ -n "$google_tasks_pid" ]] && ! kill -0 "$google_tasks_pid" 2>/dev/null; then
    forward_signal TERM
    wait "$gateway_pid" 2>/dev/null || true
    blocked GOOGLE_TASKS_CANARY_WORKER_EXITED
  fi
  if openclaw cron status --json >/dev/null 2>&1; then
    gateway_ready=true
    break
  fi
  sleep 1
done

if [[ "$gateway_ready" != true ]]; then
  forward_signal TERM
  wait "$gateway_pid" 2>/dev/null || true
  blocked GATEWAY_READINESS_TIMEOUT
fi

if ! gosu node /app/deploy/configure-automations.sh; then
  forward_signal TERM
  wait "$gateway_pid" 2>/dev/null || true
  blocked AUTOMATION_RECONCILE_FAILED
fi

printf 'RAILWAY_AUTOMATIONS_READY declarations=0 state=/data/jarvis-v1\n'

if ! gosu node /app/deploy/migrate-session-model.sh; then
  forward_signal TERM
  wait "$gateway_pid" 2>/dev/null || true
  blocked SESSION_MODEL_MIGRATION_FAILED
fi
# Start the mutation-capable canary only after all existing startup gates have succeeded.
if [[ "$JARVIS_GOOGLE_TASKS_ENABLED" == true ]]; then
  gosu node node /app/plugins/jarvis-tools/dist/google-tasks-worker-main.js &
  google_tasks_pid=$!
fi
set +e
if [[ -n "$google_tasks_pid" ]]; then
  wait -n "$gateway_pid" "$reminder_pid" "$google_tasks_pid"
else
  wait -n "$gateway_pid" "$reminder_pid"
fi
gateway_status=$?
set -e
forward_signal TERM
if [[ -n "$google_tasks_pid" ]]; then
  wait "$gateway_pid" "$reminder_pid" "$google_tasks_pid" 2>/dev/null || true
else
  wait "$gateway_pid" "$reminder_pid" 2>/dev/null || true
fi
exit "$gateway_status"
