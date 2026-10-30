#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

OPENCLAW_BIN="${OPENCLAW_BIN:-/app/node_modules/.bin/openclaw}"
[[ -x "$OPENCLAW_BIN" ]] || {
  printf 'AUTOMATIONS_BLOCKED code=OPENCLAW_BIN_UNAVAILABLE\n' >&2
  exit 1
}

openclaw() {
  "$OPENCLAW_BIN" "$@"
}

retired_keys=(
  'jarvis-v1.morning-weekdays'
  'jarvis-v1.morning-tuesday'
  'jarvis-v1.morning-weekend'
  'jarvis-v1.night-monday'
  'jarvis-v1.night-other-days'
  'jarvis-v1.weekly-review'
  'jarvis-v1.meal-prep-wednesday'
  'jarvis-v1.meal-prep-sunday'
  'jarvis-v1.sales-monday-prospecting'
  'jarvis-v1.sales-tuesday-approval'
  'jarvis-v1.sales-thursday-followup'
  'jarvis-v1.sales-friday-pipeline'
  'jarvis-v1.sales-saturday-offer'
)

retired_json="$(printf '%s\n' "${retired_keys[@]}" | node --input-type=module -e '
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(JSON.stringify(Buffer.concat(chunks).toString("utf8").trim().split("\n")));
')"

list_jobs() {
  openclaw cron list --all --json
}

extract_retired_ids() {
  RETIRED_KEYS_JSON="$retired_json" node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
    if (!Array.isArray(jobs)) process.exit(2);
    const retired = new Set(JSON.parse(process.env.RETIRED_KEYS_JSON));
    for (const job of jobs) {
      if (retired.has(job?.declarationKey) && typeof job.id === "string") {
        process.stdout.write(job.id + "\n");
      }
    }
  '
}

verify_absent() {
  RETIRED_KEYS_JSON="$retired_json" node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
    if (!Array.isArray(jobs)) process.exit(2);
    const retired = new Set(JSON.parse(process.env.RETIRED_KEYS_JSON));
    if (jobs.some((job) => retired.has(job?.declarationKey))) process.exit(3);
  '
}

removed=0
while IFS= read -r job_id; do
  [[ "$job_id" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || {
    printf 'AUTOMATIONS_BLOCKED code=INVALID_RETIRED_JOB_ID\n' >&2
    exit 1
  }
  openclaw cron rm "$job_id" --json >/dev/null 2>&1 || {
    printf 'AUTOMATIONS_BLOCKED code=RETIRED_JOB_REMOVE_FAILED\n' >&2
    exit 1
  }
  removed=$((removed + 1))
done < <(list_jobs | extract_retired_ids)

list_jobs | verify_absent || {
  printf 'AUTOMATIONS_BLOCKED code=RETIRED_DECLARATION_REMAINS\n' >&2
  exit 1
}

printf 'AUTOMATIONS_OK declarations=0 stale_removed=%s\n' "$removed"
