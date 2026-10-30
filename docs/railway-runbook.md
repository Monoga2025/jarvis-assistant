# Railway migration and operations runbook

This is the primary production path for the existing Railway project `universidad-os-jarvis`, environment `production`, service `jarvis-telegram`. It reuses the attached 5 GB volume at `/data` and does not create a domain, a VPS, or a Tailscale route.

Sources: [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles), [config-as-code reference](https://docs.railway.com/config-as-code/reference), [volume permissions and file downloads](https://docs.railway.com/volumes), [deployment rollback](https://docs.railway.com/guides/roll-back-bad-deploy), [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [native OAuth loopback/PKCE](https://developers.google.com/identity/protocols/oauth2/native-app), [FreeBusy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), [Events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), and [Calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert).

## 1. Migration identity and volume safety

Capture the live successful deployment immediately before migration. Never copy a deployment ID from this repository because it becomes stale:

```powershell
$deployments = @(railway deployment list --service jarvis-telegram --environment production --json | ConvertFrom-Json)
$previousDeploymentId = ($deployments | Where-Object { $_.status -eq 'SUCCESS' } | Select-Object -First 1).id
if ($previousDeploymentId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
  throw 'No live successful Railway deployment ID was found.'
}
New-Item -ItemType Directory -Force migration-backups | Out-Null
Set-Content -LiteralPath 'migration-backups/previous-deployment-id.txt' -Value $previousDeploymentId -NoNewline
```

The CLI could not download the volume because the Railway account has no SSH key registered. That limitation is explicit rather than bypassed: this first deployment writes exclusively under the new namespace `/data/jarvis-v1` and never reads, moves, deletes, changes ownership of, or overwrites paths outside that namespace. Existing /data contents remain available to the previous image during rollback.

The downloadable backup is not a first-deploy gate because the immutable namespace gives rollback a preserved old state. Register a Railway SSH key after the cutover, then run `deploy/railway-predeploy-backup.ps1`; it uses `railway volume files download`, writes `migration-backups/previous-deployment-id.txt`, and creates a SHA-256 manifest. Keep a second encrypted copy. Never paste or print `railway variable list --json` or `--kv`; those commands include raw secret values.

## 2. Pre-deployment settings

### Consistent SQLite snapshot gate for later migrations

`deploy/railway-predeploy-backup.ps1` downloads volume files for evidence. It is **not** a consistent SQLite backup or restore proof: a live download can separate the main database from committed WAL changes. Do not pass a potentially inconsistent downloaded copy to the snapshot helper and describe that as production proof.

The offline operator helper `scripts/sqlite-snapshot.ts` uses Node's SQLite backup API on a locally accessible database, including committed WAL state. It creates a new private output directory, verifies integrity, and records a SHA-256 database checksum, schema hash, schema version, per-table counts/row hashes, and the exact candidate/deployment identity. It never overwrites an existing snapshot or restore directory. The inventory contains no raw row values; the database itself remains sensitive. The manifest detects corruption, not malicious replacement of both manifest and database.

Run only against an explicitly authorized same-host source, with its compatible deployed commit/deployment identity (not automatically the local HEAD):

```text
node --import tsx scripts/sqlite-snapshot.ts create --source <authorized-sqlite-path> --output <new-private-snapshot-directory> --candidate <full-deployed-commit> --deployment <deployed-id>
node --import tsx scripts/sqlite-snapshot.ts verify --snapshot <snapshot-directory>
node --import tsx scripts/sqlite-snapshot.ts restore --snapshot <snapshot-directory> --output <new-isolated-restore-directory> --candidate <recorded-compatible-commit> --schema <recorded-schema-sha256>
```

Inspect the isolated restore using the compatible application revision before migrating. Record its exact manifest and verification evidence; preserve the old snapshot as read-only evidence, and store a second encrypted copy outside the service. These commands do not encrypt, schedule backups, upload data, replace live files, or establish application/schema compatibility by themselves. Failed/partial output directories are retained for operator inspection, never recursively cleaned up automatically. Use a private operator-owned parent directory and restrictive Windows ACLs; POSIX mode bits do not establish Windows ACL isolation.

Local fixtures prove WAL commits, legacy IDs, date-only deadlines, reminder quarantine, ownership, and corruption/non-overwrite rejection. **Live Railway snapshot/restore proof remains outstanding.** A schema change must not rely on image rollback alone or the original first-deploy namespace exception. Never restore a whole volume over `/` or silently discard post-snapshot work; separately approve the bounded live recovery after reconciliation.

The shared inspector also requires `PRAGMA foreign_key_check` to return no violations; `integrity_check` alone cannot prove referential consistency. The helper refuses sources/logical SQLite pages/output files above **64 MiB** and tables above **100,000 rows**. File checksums are streamed. Crossing a bound requires operator review and a separately tested larger-data strategy, never silently removing checks. Rejected artifacts are retained; the source is not repaired or deleted.

### Additive canonical task migration (not yet authorized in production)

The local task service adds `jarvis_task_metadata`, `jarvis_task_migrations`, `jarvis_task_intents`, and `jarvis_task_outbox` beside the existing `jarvis_tasks` table. It preserves existing IDs and legacy columns. Backfilled tasks retain Alex ownership and unknown confidence; invalid legacy date text remains recorded without inventing a deadline. No backfill is independently verified evidence. `LegacyStore` task methods and the existing task tools use this same service; no shadow task database is introduced.

Opening the new `LegacyStore` performs the additive migration, so **do not run it against production until the live snapshot/restore gate passes**. Older images can read the legacy columns but do not maintain new metadata/outbox invariants: do not run old and new task writers concurrently, and do not call image rollback schema-safe without a reviewed data-reconciliation or restore plan.

Task updates require an owner-scoped ID, expected revision, and payload-bound intent key. The existing `task_create` tool accepts `taskId` plus `expectedRevision` for edits; `task_complete` requires revision and intent. Trusted local compatibility calls retain the former completion signature. Normal Telegram remains Alex-only; neither task parameters nor Telegram chat IDs choose another task owner.

Every new task mutation commits a revision and outbound intent together. `queued` means local persistence, not Google success. Dispatch claims commit before any provider work; only an acknowledged external reference and matching claim token can settle as `synced`. A stopped dispatcher may quarantine in-flight claims as `unknown`; never automatically requeue them or let later revisions overtake them. Remote reconciliation and the Google adapter are not included in this slice. No dispatcher, new jobs, or service is started by this migration.

Railway mounts volumes as root. The startup script creates and owns only `/data/jarvis-v1`, then runs OpenClaw as the image's unprivileged `node` user. Set the documented Railway volume bootstrap UID without triggering a deployment:

```powershell
railway variable set RAILWAY_RUN_UID=0 --project a7e458bf-8f9c-41b7-8440-72988cc75d7f --service jarvis-telegram --environment production --skip-deploys
```

Keep the existing variables in Railway's secret store:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` (numeric Telegram user ID)
- `OPENAI_API_KEY`
- `JARVIS_DB_PATH` (its filename is preserved, but it is relocated under `/data/jarvis-v1`)
- `JARVIS_TIMEZONE`
- `REMINDER_POLL_SECONDS`

Google Calendar is explicitly disabled by default. In that mode startup removes stale generated Google credential files and calendar calls degrade without breaking Telegram, tasks, reminders, routines, finance, or sales. Do not partially configure Calendar.

### Reauthorize the existing Calendar and prepare Google Tasks locally

1. In Google Cloud, enable the Calendar and Tasks APIs, configure the OAuth consent screen for the operator, and use the existing OAuth client of type **Desktop app**. Do not create a Web client or service account and do not use an out-of-band callback. Obtain the exact existing `GOOGLE_MANAGED_CALENDAR_ID` from the restricted operator configuration; never resolve it by title.
2. Download the Desktop client JSON outside the repository, then run from this repository:

```powershell
npm run calendar:oauth -- --client "$HOME\Downloads\google-desktop-client.json" --managed-calendar-id "<existing-managed-id>" --tasks-list-id "<existing-dedicated-list-id>" --output .env.jarvis-calendar
```

The helper binds only to `127.0.0.1`, validates OAuth state and S256 PKCE, and requests exactly `calendar.events.freebusy`, `calendar.events.readonly`, `calendar.app.created`, and `tasks`. It verifies the exact calendar ID through `CalendarList.get`, requiring owner access and rejecting primary, deleted, inaccessible, or mismatched targets. It does **not** create a calendar during reauthorization, even on verification failure. This reauthorization command requires an existing managed calendar; it is not a first-time calendar provisioning command.

`calendar.events.readonly` grants Google event-read access across calendars; Jarvis restricts detail requests in code to the configured primary and managed calendars, requests only id/title/description/start/end/location for primary events, and never mutates the primary calendar. The Tasks scope is account-wide; application code must restrict projection to `GOOGLE_TASKS_LIST_ID`. Existing refresh tokens require renewed consent for the combined scopes. The helper writes `.env.jarvis-calendar` with mode 0600 where supported and prints no access or refresh token. The artifact is covered by `.env.*` in `.gitignore`; remove it after installation through the authorized operator workflow. Use restrictive Windows ACLs for the working directory.

For the **first dedicated list only**, replace `--tasks-list-id "<existing-dedicated-list-id>"` with `--create-tasks-list`. This explicitly creates `Jarvis Tasks` and records a token-free pending/created receipt under `.env.jarvis-calendar.provisioning`. On repeat, a successful receipt reuses its exact ID after readback. An interrupted or failed creation is treated as an unknown outcome: the helper refuses to POST again. Keep that receipt and reconcile the actual list ID before running with `--tasks-list-id`; never delete a pending receipt to force a retry. Do not use `@default`, a title match, or a different output path to bypass this safeguard. A receipt is bound to the verified managed calendar. Creation is not performed unless this operator command is deliberately run.

The artifact persists `GOOGLE_TASKS_LIST_ID` but sets `JARVIS_TASKS_ENABLED=false`. This is provisioning preparation, **not** a working sync adapter or a claim that tasks are already visible in Google. Enable sync only after its separate implementation and live acceptance proof.

3. Install every value without placing secret values on the command line or printing them. This updates variables without deploying:

```powershell
Get-Content .env.jarvis-calendar | ForEach-Object {
  $pair = $_.Split('=', 2)
  $pair[1] | railway variable set $pair[0] --stdin --skip-deploys `
    --project a7e458bf-8f9c-41b7-8440-72988cc75d7f `
    --service jarvis-telegram --environment production | Out-Null
}
Remove-Item -LiteralPath .env.jarvis-calendar
```

When enabled, all six settings below are mandatory and startup verifies refresh-token/free-busy readiness without logging credentials:

- `JARVIS_CALENDAR_ENABLED=true`
- `GOOGLE_CLIENT_ID=<Desktop client ID>`
- `GOOGLE_CLIENT_SECRET=<Desktop client secret>`
- `GOOGLE_REFRESH_TOKEN=<offline refresh token>`
- `GOOGLE_PRIMARY_CALENDAR_ID=primary`
- `GOOGLE_MANAGED_CALENDAR_ID=<Jarvis Plan calendar id>`

The two calendar IDs must be distinct. The primary calendar is read through FreeBusy and the scope-gated event-details adapter. Jarvis event insert/update operations target only the managed calendar.

### One-time private schedule import

After Calendar is configured, install the personal ICS as a temporary Railway variable without printing it:

```powershell
$source = [IO.File]::ReadAllBytes('C:\path\to\horarios-2026-2.ics')
$buffer = New-Object IO.MemoryStream
$gzip = New-Object IO.Compression.GZipStream($buffer, [IO.Compression.CompressionMode]::Compress, $true)
$gzip.Write($source, 0, $source.Length)
$gzip.Dispose()
[Convert]::ToBase64String($buffer.ToArray()) |
  railway variable set JARVIS_SCHEDULE_ICS_GZIP_BASE64 --stdin --skip-deploys `
    --project a7e458bf-8f9c-41b7-8440-72988cc75d7f `
    --service jarvis-telegram --environment production
$buffer.Dispose()
railway variable set JARVIS_SCHEDULE_IMPORT_ENABLED=true --skip-deploys `
  --project a7e458bf-8f9c-41b7-8440-72988cc75d7f `
  --service jarvis-telegram --environment production
```

Deploy once and require `SCHEDULE_IMPORT_READY` followed by `SCHEDULE_IMPORT_CONSUMED`. Events are selected only from the `Alex` category, bounded to the reviewed term, persisted by deterministic UID, and protected against rescheduling. The decoded file is deleted immediately after success. Re-running an import is UID-idempotent. Then disable the one-time switch and remove the private payload:

```powershell
railway variable set JARVIS_SCHEDULE_IMPORT_ENABLED=false --skip-deploys `
  --project a7e458bf-8f9c-41b7-8440-72988cc75d7f `
  --service jarvis-telegram --environment production
railway variable delete JARVIS_SCHEDULE_ICS_GZIP_BASE64 `
  --project a7e458bf-8f9c-41b7-8440-72988cc75d7f `
  --service jarvis-telegram --environment production
```

Do not add a Railway domain. Telegram long polling is the default OpenClaw transport, and the gateway remains bound to container loopback.

### Legacy recovery boundary

Startup seeds only transcript-verifiable task, academic, reminder, handoff, and material metadata with explicit provenance. Task #18 keeps its date-only `2026-09-10` deadline; no hour is invented. Historical reminders without trustworthy absolute timestamps are `review_required` and cannot dispatch. Historical PDF names remain `unavailable` metadata because the files were not recovered. The former `UNAB_OS` bridge source and contract are unavailable, so that bridge remains disabled even if unrelated legacy Railway variables still exist.

## 3. Deploy and observe

Run the repository checks, then deploy explicitly to the existing service:

```powershell
npm run verify
npm audit --omit=dev --audit-level=high
railway up . --path-as-root --project a7e458bf-8f9c-41b7-8440-72988cc75d7f --service jarvis-telegram --environment production --message "Deploy Jarvis v1 on OpenClaw"
railway deployment list --service jarvis-telegram --environment production --json --limit 3
railway logs --project a7e458bf-8f9c-41b7-8440-72988cc75d7f --service jarvis-telegram --environment production --lines 100
```

Success evidence:

- Build used the root `Dockerfile` and `openclaw@2026.9.1`.
- Runtime logs contain `RAILWAY_STARTUP_READY` but no credential values.
- Telegram responds only to the configured numeric owner.
- A different Telegram account receives no usable response.
- The `/data/jarvis-v1/workspace`, `/data/jarvis-v1/config`, `/data/jarvis-v1/credentials`, `/data/jarvis-v1/imports`, and database state persist after one service restart.
- Files outside `/data/jarvis-v1` retain their pre-deployment hashes and ownership.
- No Railway domain exists for this service.

### Retired automations and session model readiness

After the Gateway accepts local RPC, the Railway entrypoint removes only the 13
retired Jarvis coaching declarations by exact `declarationKey`. It never uses a
wildcard and leaves user-created reminders and unrelated system jobs untouched.
The recurring agent heartbeat is disabled with `every: "0m"`.

Startup also lists owner Telegram sessions through the supported Gateway API.
Any explicit session model override is cleared with `sessions.patch` using
`model: null`, then readiness confirms that the effective model is the
budget-first `openai/gpt-5.6-luna` route and that no override remains. Startup
fails closed if the session remains pinned. Never edit OpenClaw SQLite state
directly.

The entrypoint runs the migration only after Gateway readiness. To repeat that
supported readiness step manually from a Railway shell, run:

```bash
/app/deploy/migrate-session-model.sh
```

For diagnosis, the underlying read is
`openclaw gateway call sessions.list --params '{}' --json`; the supported
per-session reset is
`openclaw gateway call sessions.patch --params '{"key":"<owner Telegram session key>","model":null}' --json`.
Do not substitute a direct database edit.

After each deploy or restart, verify the logs without printing environment
variables or secrets:

```powershell
railway logs --project a7e458bf-8f9c-41b7-8440-72988cc75d7f --service jarvis-telegram --environment production --lines 200
```

Expected markers are:

```text
AUTOMATIONS_OK declarations=0 stale_removed=<count>
RAILWAY_AUTOMATIONS_READY declarations=0 state=/data/jarvis-v1
SESSION_MODEL_MIGRATION_OK migrated=<count> target=openai/gpt-5.6-luna
```

When Railway SSH access is available, verify after two restarts with
`openclaw cron list --all --json`: none of the 13 exact retired declaration keys
may remain, while unrelated jobs must remain unchanged.

Because the service owns a volume, Railway cannot overlap two deployments. Expect a short migration interruption even though the worker restart policy is `ALWAYS`.

## 4. Rollback

If startup, Telegram authorization, state integrity, or memory use is wrong:

1. Stop testing the new worker; do not delete `/data` or `/data/jarvis-v1`.
2. In Railway, open `jarvis-telegram` > **Deployments**, locate the ID stored in `migration-backups/previous-deployment-id.txt`, and choose **Rollback**. Railway restores that deployment's image and variables as a new deployment.
3. If the previous image has expired from Railway retention, redeploy that historical deployment from the dashboard.
4. The original first-deploy namespace preserved old paths; later in-place schema changes do not inherit that guarantee. If recovery requires data restoration, retain the incident volume for evidence, verify an isolated snapshot against its compatible candidate/schema, and obtain approval for a bounded live recovery. Do not overwrite the volume root or discard post-snapshot work automatically.

5. Confirm the old bot flow works and retain both deployment IDs in the incident note.

Never delete or detach the existing volume as part of rollback.

## 5. Updates and backups

- Keep `openclaw` and the Node base image pinned; test upgrades in a separate branch.
- After registering an SSH key, download `/data` before later production migrations and at least weekly.
- The legacy VPS scripts remain an isolated alternative only. They are not used on Railway.
- Railway `railway.json` config-as-code remains supported for this existing service until the platform's documented 2026-12-01 cutoff; migrate to Railway IaC before then.


## Google Tasks single-insert canary

The Tasks worker is disabled by default (`JARVIS_GOOGLE_TASKS_ENABLED=false`). Do not enable it during ordinary Railway deploys. A deliberate canary requires Calendar to be enabled, a provisioned dedicated `GOOGLE_TASKS_LIST_ID`, all three existing Google credential files, `JARVIS_GOOGLE_TASKS_CANARY_MODE=single_insert`, and a 5–3600-second `JARVIS_GOOGLE_TASKS_POLL_SECONDS`.

The worker makes a metadata-only Tasks list probe before its ready marker, prioritizes recovery of an unknown prior insertion, and has one mutation-capable budget for its full process lifetime. It never updates mapped tasks. Disable the variable to stop the worker; do not reuse a failed process as proof that a provider write did not occur. Startup markers intentionally exclude task IDs, titles, tokens, and provider bodies.
