#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ "${TELEGRAM_OWNER_ID:-}" =~ ^[1-9][0-9]{5,19}$ ]] || {
  printf 'SESSION_MODEL_MIGRATION_BLOCKED code=TELEGRAM_OWNER_ID_INVALID\n' >&2
  exit 1
}

OPENCLAW_BIN="${OPENCLAW_BIN:-/app/node_modules/.bin/openclaw}"
TARGET_MODEL='openai/gpt-5.6-luna'
[[ -x "$OPENCLAW_BIN" ]] || {
  printf 'SESSION_MODEL_MIGRATION_BLOCKED code=OPENCLAW_BIN_UNAVAILABLE\n' >&2
  exit 1
}

openclaw() {
  "$OPENCLAW_BIN" "$@"
}

list_sessions() {
  openclaw gateway call sessions.list --params '{}' --json
}

select_pinned_owner_sessions() {
  TELEGRAM_OWNER_ID="$TELEGRAM_OWNER_ID" TARGET_MODEL="$TARGET_MODEL" node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const rows = Array.isArray(parsed) ? parsed : (parsed.sessions ?? parsed.result?.sessions);
    if (!Array.isArray(rows)) process.exit(2);
    const owner = process.env.TELEGRAM_OWNER_ID;
    const target = process.env.TARGET_MODEL;
    for (const row of rows) {
      const ownerRoute = typeof row?.key === "string" && row.key.split(":").includes(owner);
      const telegramDm = row?.channel === "telegram" && (row?.chatType === "direct" || row?.kind === "direct");
      const pinned = row?.modelOverrideSource === "user" || row?.modelOverrideSource === "auto";
      const effective = typeof row?.model === "string"
        ? (row.model.includes("/") ? row.model : `${row.modelProvider ?? ""}/${row.model}`)
        : target;
      const stale = pinned || effective !== target;
      if (ownerRoute && telegramDm && stale) {
        process.stdout.write(Buffer.from(row.key, "utf8").toString("base64url") + "\n");
      }
    }
  '
}

verify_target_model() {
  TELEGRAM_OWNER_ID="$TELEGRAM_OWNER_ID" TARGET_MODEL="$TARGET_MODEL" node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const rows = Array.isArray(parsed) ? parsed : (parsed.sessions ?? parsed.result?.sessions);
    if (!Array.isArray(rows)) process.exit(2);
    const owner = process.env.TELEGRAM_OWNER_ID;
    const target = process.env.TARGET_MODEL;
    const stale = rows.some((row) => {
      const ownerRoute = typeof row?.key === "string" && row.key.split(":").includes(owner);
      const telegramDm = row?.channel === "telegram" && (row?.chatType === "direct" || row?.kind === "direct");
      const pinned = row?.modelOverrideSource === "user" || row?.modelOverrideSource === "auto";
      const effective = typeof row?.model === "string"
        ? (row.model.includes("/") ? row.model : `${row.modelProvider ?? ""}/${row.model}`)
        : target;
      return ownerRoute && telegramDm && (pinned || effective !== target);
    });
    if (stale) process.exit(3);
  '
}

migrated=0
while IFS= read -r encoded_key; do
  [[ "$encoded_key" =~ ^[A-Za-z0-9_-]{1,1024}$ ]] || {
    printf 'SESSION_MODEL_MIGRATION_BLOCKED code=SESSION_KEY_ENCODING_INVALID\n' >&2
    exit 1
  }
  params="$(ENCODED_KEY="$encoded_key" node --input-type=module -e '
    const key = Buffer.from(process.env.ENCODED_KEY, "base64url").toString("utf8");
    process.stdout.write(JSON.stringify({ key, model: null }));
  ')"
  openclaw gateway call sessions.patch --params "$params" --json >/dev/null 2>&1 || {
    printf 'SESSION_MODEL_MIGRATION_BLOCKED code=SESSION_PATCH_FAILED\n' >&2
    exit 1
  }
  migrated=$((migrated + 1))
done < <(list_sessions | select_pinned_owner_sessions)

list_sessions | verify_target_model || {
  printf 'SESSION_MODEL_MIGRATION_BLOCKED code=TELEGRAM_SESSION_MODEL_STILL_PINNED\n' >&2
  exit 1
}

printf 'SESSION_MODEL_MIGRATION_OK migrated=%s target=openai/gpt-5.6-luna\n' "$migrated"
